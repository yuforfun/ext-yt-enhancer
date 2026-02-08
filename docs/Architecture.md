# YouTube 字幕增強器 - 專案情境總結 (v4.1.4)

## 1. 專案目標與核心功能

此應用程式是一個 Chrome Manifest V3 (MV3) 擴充功能，旨在即時攔截並翻譯 YouTube 影片字幕，解決原生字幕品質不佳、無目標語言或自動字幕斷句破碎的問題。

專案採用 **完全 Serverless 架構**，不依賴外部中介伺服器，所有邏輯與 API 請求均由擴充功能直接發起。

**核心功能：**

* **智慧型後端代理 (Smart Backend Agent)**：
    * **斷路器機制 (Circuit Breaker)**：在記憶體中維護「金鑰-模型」的健康狀態。精準區分 **RPM** (速率限制，冷卻 60s) 與 **RPD** (每日額度耗盡，冷卻 24h)，在發送請求前先查表 (Local Skip)，避免無效請求。
    * **負載平衡 (Model-First Strategy)**：採用「模型優先」的雙重迴圈邏輯。優先使用高品質模型（如 Gemini 3.0 Pro）遍歷所有可用金鑰，失敗後才降級至次一級模型（如 Flash），確保翻譯品質最大化。
    * **金鑰黏著性 (Key Stickiness)**：系統會記憶並優先使用上一次成功請求的金鑰，減少輪詢開銷。
* **播放器優先握手 (Player-First Handshake)**：
    * 解決 `content.js` 與 `injector.js` 之間的時序競爭 (Race Condition)。由 `injector.js` 確保獲取到 YouTube 播放器資料後，才回應 `content.js` 的主動輪詢。
* **三層式語言決策引擎 (3-Tier Engine)**：
    1.  **Tier 1 (原文顯示)**：優先匹配使用者設定的「母語」，不消耗 API 額度。
    2.  **Tier 2 (自動翻譯)**：匹配使用者設定的「目標語言」，根據自訂 Prompt 進行 AI 翻譯。
    3.  **Tier 3 (按需翻譯)**：Fallback 模式，顯示原文並在播放器右上角提供「翻譯」按鈕，點擊後才觸發翻譯。
* **高品質分句引擎 (HQS Engine)**：
    * 專門針對日文 ASR (自動辨識字幕) 破碎問題設計。
    * **觸發機制**：僅當 `hqsEnabledForJa` 開啟 + 語言為日文 + ASR 多 Seg 事件比例超過 `0.35` 時觸發。
    * **處理流程**：執行三階段管線（清理雜訊 -> 語意/時間斷句 -> 碎片合併）。

## 2. 系統架構與資訊流

本專案由三個主要環境組成，各司其職並透過訊息傳遞溝通。

* **架構組成**：
    * **後端 (Service Worker)**: `background.js`。負責 API 通訊、斷路器狀態管理、錯誤判讀、跨分頁設定廣播。
    * **前端 (Main World)**: `injector.js`。負責攔截 `timedtext` 網路請求、操作 YouTube 播放器 API (`player.setOption`)。
    * **前端 (Isolated World)**: `content.js`。負責業務邏輯、決策引擎、HQS 運算、UI 渲染 (字幕/圓環)。
    * **資料庫 (Local/Session)**: `chrome.storage`。
        * `local`: 儲存使用者設定 (`ytEnhancerSettings`)、API 金鑰 (`userApiKeys`)、影片翻譯快取。
        * `session`: 儲存斷路器狀態 (`circuitBreakerState`)、錯誤日誌。

* **典型資訊流**：

    1.  **[流程一：啟動與握手]**
        1.  `background.js` (`onInstalled`) 透過 `chrome.scripting.registerContentScripts` 將 `injector.js` 註冊到 `MAIN` World。
        2.  `content.js`(ISOLATED World) 載入，*主動*輪詢 (`REQUEST_PLAYER_RESPONSE`)。
        3.  `injector.js` 監聽到 `yt-navigate-finish`，獲取 `player.getPlayerResponse()` 並暫存，設定 `state.isDataReady = true`。(同時 `injector.js` 也會發送 `YT_NAVIGATED` 信號，確保 `content.js` 在軟導航後重置)。
        4.  `injector.js` 收到 `REQUEST_PLAYER_RESPONSE` 信號，回傳 `PLAYER_RESPONSE_CAPTURED` 資料。
        5.  `content.js` 收到資料，呼叫 `start()` 進入決策引擎。

    * **[流程二：HQS 翻譯流程 (Tier 2)]**
        1.  `content.js` (`start()`) 命中 Tier 2，鎖定目標軌道的 `vssId` (`state.targetVssId`)，命令 `injector.js` (`FORCE_ENABLE_TRACK`)。
        2.  `injector.js` 攔截 `/api/timedtext` 回應，`postMessage('TIMEDTEXT_DATA', ...)`。
        3.  `content.js` 收到 `TIMEDTEXT_DATA`，驗證 `vssId` 或 `lang` 匹配 `targetVssId`，解除看門狗，呼叫 `activate()`。
        4.  `activate()` 呼叫 `parseAndTranslate()` -> `parseRawSubtitles()`。
        5.  `parseRawSubtitles()` 檢查 `isJapanese` && `settings.hqsEnabledForJa`。
        6.  (若為 True) 計算「多 Seg 比例」，若 > `THRESHOLD` (0.35)，執行 HQS 管線 (`_phase1`...`_phase3`)；否則執行 `_fallbackParseRawSubtitles()`。
        7.  (若為 False) 執行 `_fallbackParseRawSubtitles()`。
        8.  `content.js` 呼叫 `processNextBatch()`，以 `BATCH_SIZE = 25` 批次呼叫 `chrome.runtime.sendMessage({ action: 'translateBatch', ... })`。
        9.  `background.js` 收到任務，組合 Prompt，執行「金鑰-模型」迴圈呼叫 Gemini。
        10. (成功) `sendResponse({ data: [...] })`。
        11. (失敗) `sendResponse({ error: 'TEMPORARY_FAILURE' | 'PERMANENT_FAILURE' | 'BATCH_FAILURE', ... })`。
        12. `content.js` 處理回應，渲染 UI 或顯示錯誤狀態 (黃色圓環、紅色圓環、點擊重試行)。

    * **[流程三：批次翻譯與負載平衡]**
        1.  `content.js` 累積 **45 句** 字幕，呼叫 `translateBatch`。
        2.  `background.js` 收到請求，初始化 `CircuitBreaker`。
        3.  **外層迴圈 (Model)**：依序嘗試 `Gemini 3.0 Pro` -> `Gemini 2.5 Pro` -> `Gemini 2.5 Flash`...
        4.  **內層迴圈 (Key)**：
            * 檢查 `CircuitBreaker.isOpen(Key, Model)`。若冷卻中則跳過 (Local Skip)。
            * 若可用，發送 API 請求。
        5.  **結果處理**：
            * **成功**：回傳翻譯結果，更新「黏著金鑰」。
            * **失敗**：解析錯誤代碼。若為 RPD (Day Limit) 判罰 24 小時；若為 RPM (Rate Limit) 判罰 60 秒。寫入斷路器並嘗試下一個 Key。
        6.  `content.js` 收到結果渲染 UI，或收到 `retryDelay` 顯示黃色重試圓環。

    * **[流程四：Prompt 實驗室]**
        1.  `lab.html` 載入，`lab.js` 觸發 `getDebugPrompts` 填入預設值。
        2.  使用者點擊「執行比較翻譯」。
        3.  `lab.js` 呼叫 `chrome.runtime.sendMessage`。
        4.  請求: `{ action: 'translateBatch', overridePrompt: '...' }` (Prompt A)。
        5.  `background.js` 偵測到 `overridePrompt` 參數，**繞過** `storage` 中的 Prompt，直接使用 `overridePrompt` 呼叫 API。
        6.  `lab.js` 收到結果，渲染對照表格。

## 3. 專案檔案結構與職責

* **後端 (Backend)**：
    * `background.js`:
        * `CircuitBreaker` (Class): 管理 `keyId::modelId` 的冷卻時間戳記。
        * `translateBatch`: 實作「模型優先」的雙重迴圈與錯誤重試邏輯。
        * `parseErrorAndTrip`: 解析 Google API 錯誤 (Quota/Billing)，決定判罰刑期。
        * `reorderKeysByStickiness`: 實作金鑰優先級調整。
* **前端 (Frontend)**：
    * `injector.js`: (MAIN World) "現場特工"。實作 **握手回應方** (`onNavigate`, `handleContentMessage`)、**主動導航通知** (`YT_NAVIGATED`)、攔截 `timedtext` (Fetch/XHR 雙攔截器)、確保 `vssId` 為 `''`、存取 `player` 物件 (`getPlayerResponse`, `setOption` 3 次重試)。
    * `content.js`: (ISOLATED World) "指揮中心"。實作 **握手請求方** (`requestPlayerResponse`)、**三層決策引擎** (`start`, `onMessageFromInjector`)、**vssId 鎖定**、**HQS 引擎** (`parseRawSubtitles` 及 `_phase` 函式)、UI 渲染 (字幕/圓環/Tier 3 按鈕)、批次錯誤處理 (`BATCH_SIZE=25`, `handleRetryBatchClick`)。
* **介面與邏輯 (UI & Logic)**：
    * `manifest.json`: MV3 設定檔。**關鍵權限**：`storage`, `scripting`, `tabs`, `host_permissions: ["...youtube.com/*", "...googleapis.com/*"]`。
    * `popup.html`: "遙控器" (Action Popup) 的 UI。包含總開關、即時設定 (顯示模式、HQS 開關、字體大小)。
    * `options.html`: "管理後台" (Options Page) 的 UI。包含頁籤、語言清單 A/B、模型偏好、金鑰管理、診斷日誌。
    * `popup.js`: **共享腳本**。處理 `popup.html` 和 `options.html` 的所有 DOM 事件與邏輯。實作設定 I/O、動態列表渲染 (金鑰、模型、Tier 1/2)。
    * `lab.html`: "Prompt 實驗室" (Dev Tool) 的 UI。提供 A/B 測試用的 `textarea`。
    * `lab.js`: `lab.html` 的驅動腳本。處理 A/B 測試的 API 呼叫與結果渲染。
* **樣式與資源 (CSS)**：
    * `style.css`: `content.js` 注入的 CSS。定義雙語字幕容器 (`#enhancer-subtitle-container`)、狀態圓環 (`#enhancer-status-orb`)、Tier 3 按鈕 (`#enhancer-ondemand-button`)、批次錯誤行 (`.enhancer-error-line`)。
    * `popup.css`: **共享樣式表**。定義 `popup.html`, `options.html`, `lab.html` 的核心 UI 規範。
        * **UI 規範**: 採用卡片式 (`.card`) 佈局。
        * **色彩**: 淺色背景 (`--bg-color: #f4f4f5`)、白色卡片 (`--card-bg-color: #ffffff`)、深色點綴 (`--accent-color: #18181b`)。
        * **元件**: 定義了標準化的 `.button-primary`, `.button-secondary`, `.toggle-switch`, `.sortable-list` 等元件樣式。

## 4. 後端 API 溝通協議

系統內部使用 `chrome.runtime.sendMessage` 進行溝通。

* **`POST /translateBatch`**
    * **功能**: 執行智慧負載平衡翻譯。
    * **請求**: `{ action: 'translateBatch', texts: ["..."], source_lang: "ja", models_preference: ["gemini-3...", "gemini-2..."] }`
    * **成功回應**: `{ data: ["翻譯1", "翻譯2"...] }`
    * **結構化錯誤**:
        * `{ error: 'TEMPORARY_FAILURE', retryDelay: 60 }`: 所有 Key 短暫過載 (RPM)，前端應等待後重試。
        * `{ error: 'PERMANENT_FAILURE', message: "..." }`: 無有效 Key 或帳單錯誤，前端應停止翻譯。
        * `{ error: 'BATCH_FAILURE', message: "..." }`: 模型拒絕處理此內容 (Safety Filter)，前端應跳過此批次。
* **`GET /getSettings`**
    * **Action**: `getSettings`
    * **功能**: 獲取 `ytEnhancerSettings`。
* **`POST /updateSettings`**
    * **Action**: `updateSettings`
    * **功能**: 儲存 `ytEnhancerSettings`。
* **`GET /diagnoseAllKeys`**
    * **Action**: `diagnoseAllKeys`
    * **功能**: 診斷所有儲存的金鑰。
    * **回應**: `[ { "name": "Key1", "status": "valid" | "invalid", "error": "..." } ]`
* **`GET /diagnoseAllKeys`**
    * **功能**: 快速診斷所有金鑰有效性 (不消耗額度)。
    * **回應**: `[{ name: "Key1", status: "valid" }, { name: "Key2", status: "invalid", error: "..." }]`
* **`GET /getDebugPrompts`**
    * **Action**: `getDebugPrompts`
    * **功能**: (供 `lab.js` 使用) 獲取預設的通用 Prompt 和儲存的日文自訂 Prompt。
    * **回應**: `{ success: true, universalPrompt: "...", savedCustomPrompt: "..." }`
* **(其他)**: `toggleGlobalState`, `getErrorLogs`, `STORE_ERROR_LOG`, `getCache`, `setCache`...

## 5. 關鍵決策與歷史包袱 (重要)

此章節紀錄專案開發過程中的核心權衡（Trade-offs）與不可動搖的架構基石。

### 核心架構與流程
* **[決策] 邏輯翻轉 (Model-First Strategy)**：
    * **原因**：為了最大化翻譯品質。即使是免費用戶，也應優先嘗試所有 Key 的高品質模型 (如 Gemini 3.0 Pro)，直到全部耗盡才降級至 Flash。
    * **實作**：`background.js` 的迴圈結構從原本的 `For Key -> For Model` 變更為 `For Model -> For Key`。
* **[決策] 握手架構 (Player-First Handshake)**：
    * **原因**：解決 `content.js` (Isolated World) 和 `injector.js` (Main World) 之間的時序競爭 (Race Condition)。
    * **實作**：改為 `content.js` (請求方) *主動輪詢* `injector.js` (回應方)，`injector.js` 則等待 `yt-navigate-finish` 確保 `playerResponse` 可用後才回應。
* **[決策] `injector.js` 的 3 次重試保險**：
    * **原因**：為了解決 `player.setOption()` 偶爾因 YouTube 播放器載入時序問題而靜默失效的問題。
    * **實作**：`injector.js` 在收到 `FORCE_ENABLE_TRACK` 指令時，會在 0ms, 250ms, 500ms *連續執行 3 次* `setOption` 以確保設定成功。

### 後端與 AI 策略
* **[決策] 精準判刑 (Precise Penalty)**：
    * **原因**：Google API 的 `429` 可能代表 RPM (60秒速率限制) 或 RPD (24小時配額耗盡)。若不區分，會導致死 Key 卡住佇列浪費時間，或活 Key 被誤殺。
    * **實作**：解析 API 回傳的 `quota_id` 字串。含 `Day` 判 **24小時** 冷卻，含 `Minute` 判 **60秒** 冷卻。
* **[決策] 本地查表 (Local Skip)**：
    * **原因**：減少無效的 HTTP 請求，提升 UI 反應速度並避免網路資源浪費。
    * **實作**：`background.js` 在 `fetch` 前先檢查 `CircuitBreaker.isOpen()`，若斷路器開啟則直接跳過該 Key/Model 組合。

### 前端邏輯與 HQS 引擎
* **[決策] HQS 的 ASR 比例觸發**：
    * **原因**：HQS (高品質分句) 重組演算法若套用在人工翻譯的字幕上，會破壞原本良好的斷句結構。
    * **實作**：`content.js` 計算 `multiSeg` 事件比例，必須 **> 0.35** (即 35% 以上的字幕包含多個時間段) 才會啟動 HQS 引擎。
* **[決策] 抽象化「語言等價性」**：
    * **原因**：YouTube 提供的 `zh-TW` 或 `zh` 無法直接匹配使用者設定的 `zh-Hant`。
    * **實作**：在 `content.js` 中建立 `checkLangEquivalency` 函式，定義「繁體中文群組」和「簡體中文群組」，所有語言比對必須通過此函式。
* **[決策] `injector.js` 的 vssId `''` Fallback**：
    * **原因**：`URL.searchParams.get('vssId')` 在 `vssId` 不存在時 (例如手動上傳的字幕) 會回傳 `null`，這會導致 `content.js` 的 `vssId === targetVssId` 驗證邏輯崩潰。
    * **實作**：`injector.js` 在獲取 `vssId` 時強制使用 `|| ''`，確保 `vssId` 永不為 `null`。

### 歷史包袱 (Legacy Debt)
* **[包袱] 資料庫遷移 (Migration)**：
    * **描述**：`popup.js` 的 `loadSettings` 中包含將舊版 `preferred_langs` 轉換為新版 `auto_translate_priority_list` 的邏輯。
    * **原因**：為了兼容從 v1.x 升級至 v2.0+ 的舊使用者，此邏輯**不可刪除**。
* **[包袱] `DEFAULT_CUSTOM_PROMPTS` 同步債**：
    * **描述**：`DEFAULT_CUSTOM_PROMPTS` 常數同時存在於 `background.js` (用於預設邏輯) 和 `popup.js` (用於 UI 顯示)。
    * **影響**：修改預設 Prompt 時，兩者必須保持同步。

## 6. 嚴格護欄 (Guard Rails) (最重要)

此章節列出絕對禁止修改的紅線，防止 AI 在重構時破壞核心穩定性。

### [後端] Background.js
* **[禁止]**：**嚴格禁止**在 `background.js` 的 `translateBatch` 迴圈中移除 `globalCircuitBreaker.isOpen()` 檢查。這會導致向 Google 發送大量無效請求，可能導致金鑰被永久封鎖。
* **[禁止]**：**嚴格禁止**修改錯誤判讀的順序。必須 **先檢查 RPD (Day/Limit)**，**再檢查 RPM (Minute)**。因為 RPD 的嚴重性高於 RPM，且 Google 的錯誤訊息可能同時包含兩者，需優先處理最嚴重的。
* **[禁止]**：**嚴格禁止**將暫時性錯誤 (如 `429`, `503`, `500` 且無 Day 標記) 視為永久金鑰錯誤。暫時性錯誤必須執行 `continue` (切換模型/Key) 並設定短暫冷卻，**不得** 執行 `break` 放棄該 Key 的後續嘗試。
* **[禁止]**：**嚴格禁止**重新引入任何對本地伺服器 (`127.0.0.1` 或 `backend.py`) 的依賴。專案必須保持 100% Serverless。
* **[禁止]**：**嚴格禁止**回傳籠統的錯誤字串。`background.js` 必須回傳結構化的 `{ error: 'TEMPORARY_FAILURE' | 'PERMANENT_FAILURE' | 'BATCH_FAILURE', ... }` 物件，因為 `content.js` 依賴此結構進行 UI 響應 (如黃色重試圓環)。

### [前端] Content.js & Injector.js
* **[禁止]**：**嚴格禁止**將 `BATCH_SIZE` 設定超過 **50**。過大的 Batch 會導致前端渲染延遲感 (字幕一次跳出一大段) 及 API Time-to-First-Byte 過長。
* **[禁止]**：**嚴格禁止**在 `content.js` 中移除 `isProcessing = false` 的狀態重置邏輯。必須確保在成功、失敗、Abort 等所有出口都正確重置，否則翻譯佇列會永久卡死。
* **[禁止]**：**嚴格禁止**移除 `content.js` 中的 `HQS_MULTI_SEG_THRESHOLD` 檢查。這保護了人工字幕不被錯誤重組。
* **[禁止]**：**嚴格禁止**移除 `content.js` 的 `parseRawSubtitles` 函式中的 `_fallbackParseRawSubtitles` 邏輯。這確保了在非日文、HQS 關閉或人工字幕情境下，系統仍能運作。
* **[禁止]**：**嚴格禁止**在 `content.js` (Isolated World) 中直接存取 `window.player` 或 `window.fetch`。所有與頁面 `window` 的互動**必須**透過 `postMessage` 委派給 `injector.js` (Main World)。
* **[禁止]**：**嚴格禁止**使用 `===` 或 `.includes()` 進行語言代碼比對。所有語言比對**必須**使用 `checkLangEquivalency` 函式，以解決 `zh-TW` vs `zh-Hant` 等匹配問題。
* **[禁止]**：**嚴格禁止**破壞 `content.js` 的鏡像原則。`start()` (自動載入) 和 `onMessageFromInjector` (手動切換) 內部的 Tier 1/2/3 判斷邏輯**必須**保持 100% 同步。
* **[禁止]**：**嚴格禁止**在 `content.js` 呼叫 `translateBatch` 時傳遞 `overridePrompt` 參數。此參數僅供 `lab.js` 測試使用，若在正式環境傳遞將破壞使用者的自訂 Prompt 設定。

### [UI 與其他] Popup & Options
* **[禁止]**：**嚴格禁止**在 `popup.js` 中直接存取只存在於 `options.html` 的 DOM 元素 (例如 `apiKeyList`)。存取前**必須**使用 `if (isOptionsPage)` 或 `if (element)` 進行嚴格檢查，否則會導致 `popup.html` (小彈窗) 崩潰。


### Gemini 模型免費版實測總結 (2026-02-08)

針對當前專案支援的模型，使用免費版 API Key 進行一次性可用性測試，結果如下：

#### 1. 測試結果清單

* **gemini-3-flash-preview**: ✅ **成功** (耗時 3.03s)。輸出格式正確且語意流暢。
* **gemini-2.5-flash**: ✅ **成功** (耗時 4.02s)。翻譯品質穩定，符合台灣口語習慣。
* **gemini-2.5-flash-lite**: ✅ **成功** (耗時 **1.22s**)。回應速度最快，適合效能優先情境。
* **Pro 系列 (3-pro, 2.5-pro)**: ❌ **失敗** (HTTP 429)。免費層級配額限制為 0，無法直接調用。
* **2.0 系列 (2.0-flash, 2.0-flash-lite)**: ❌ **失敗** (HTTP 429)。實測顯示目前免費版 Key 在此等模型上的請求限制亦為 0。

#### 2. 開發與配置建議

* **免費版首選模型**：建議將 `gemini-2.5-flash-lite` 設為預設或高優先級模型，其 1.22s 的響應速度能顯著提升字幕同步的即時感。
* **配額限制說明**：免費版用戶應避開 Pro 系列及 2.0 系列模型，否則將觸發 `RESOURCE_EXHAUSTED` 錯誤導致翻譯中斷。
* **錯誤處理機制**：系統已證實能精確擷取 HTTP 429 錯誤中的 `Quota exceeded` 訊息，未來可持續利用此特性優化斷路器（Circuit Breaker）的判罰邏輯。
