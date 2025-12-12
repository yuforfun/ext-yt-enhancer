# YouTube 字幕增強器 - 專案情境總結 (v4.1.3)

## 1. 專案目標與核心功能

此應用程式是一個 Chrome Manifest V3 (MV3) 擴充功能，旨在即時攔截並翻譯 YouTube 影片字幕，解決原生字幕品質不佳或無目標語言選項的問題。

專案採用**完全 Serverless 架構**，所有核心邏輯均在擴充功能內部處理：`background.js` (Service Worker) 作為後端，`content.js` (Isolated World) 作為指揮中心，`injector.js` (Main World) 作為現場特工。

**核心功能：**

* **播放器優先握手 (Player-First Handshake)**：
    * 為解決 `content.js` 與 `injector.js` 之間的時序競爭 (Race Condition)，架構採用「播放器優先」設計。
    * `injector.js` (Main World) 會等待 `yt-navigate-finish` 觸發，*主動*獲取 `playerResponse` 並暫存 (`isDataReady = true`)。
    * `content.js` (Isolated World) 則會*主動*輪詢 (`REQUEST_PLAYER_RESPONSE`) 向 `injector.js` 請求資料，直到 `injector.js` 回傳 `PLAYER_RESPONSE_CAPTURED`。
* **三層式語言決策引擎 (3-Tier Engine)**：
    1.  **Tier 1 (原文顯示)**：使用者設定的「原文顯示語言」列表 (零成本)。
    2.  **Tier 2 (自動翻譯)**：使用者設定的「自動翻譯語言」列表 (高品質 Prompt)。
    3.  **Tier 3 (按需翻譯)**：未命中前兩者的 Fallback 模式，提供右上角「翻譯」按鈕。
* **Serverless AI 翻譯**：由 `background.js` (Service Worker) 直接呼叫 Google Gemini API (`generativelanguage.googleapis.com`) 進行字幕翻譯。
* **高品質分句引擎 (HQS Engine)**：
    * 針對日文字幕，提供實驗性的高品質分句功能（由 Popup 開關控制）。
    * **條件觸發**：僅當 `settings.hqsEnabledForJa` 為 `true` 且當前語言為日文時觸發。
    * **比例偵測**：觸發後，系統會計算 ASR (自動字幕) 的「多 Seg 事件比例」。
    * **動態切換**：只有當比例超過 `HQS_MULTI_SEG_THRESHOLD` (0.35) (表示為 ASR) 時，才執行 HQS 三階段管線 (`_phase1`...`_phase3`)；否則自動回退至舊版解析器。
* **動態金鑰管理**：
    * `options.html` 提供動態列表介面，用於管理多組 API Key。
    * **儲存邏輯**：新金鑰 (`.new-key-value-input`) 在 `blur` 時（且兩欄位皆有值）觸發*儲存*；已儲存金鑰 (`.key-value-input`) 在 `change` 時（`blur` 且值變更）觸發*更新*。
* **模型偏好設定**：
    * `options.html` 提供「單一可拖曳排序列表 (`#selected-models`)」 + 「可添加的 Pill 標籤 (`#available-model-pills`)」來管理模型調用優先級。
* **智慧錯誤處理**：
    * `background.js` 能精確分析 API 失敗原因，並回傳三種結構化錯誤：`TEMPORARY_FAILURE` (可重試)、`PERMANENT_FAILURE` (應停止)、`BATCH_FAILURE` (批次內容錯誤)。
    * `content.js` 根據錯誤執行不同 UI 響應（黃色重試圓環、紅色停止圓環、點擊重試字幕行）。
* **語言等價性檢查**：
    * `content.js` 中的 `checkLangEquivalency` 函式，用於解決 `zh-Hant` vs `zh-TW` vs `zh` 等語言代碼不一致的匹配問題。
* **開發者工具 (Prompt 實驗室)**：
    * 提供 `lab.html` (非公開頁面)，用於 A/B 測試 Prompt 效果。
    * `lab.js` 會呼叫 `translateBatch` API，並傳入 `overridePrompt` 參數，繞過儲存區的 Prompt，直接使用實驗性 Prompt 進行翻譯。

## 2. 系統架構與資訊流

* **架構組成**：
    * **後端**: `background.js` (Chrome Service Worker)。負責所有 API 呼叫、儲存管理、日誌、動態腳本註冊。
    * **前端 (注入)**: `injector.js` (MAIN World)。"現場特工"，負責網路攔截、播放器操作、握手 (回應方)。
    * **前端 (核心)**: `content.js` (ISOLATED World)。"指揮中心"，負責三層決策引擎、HQS 引擎、UI 渲染、握手 (請求方)。
    * **前端 (介面)**: `options.html` / `popup.html` (由 `popup.js` 共享驅動)。
    * **前端 (開發)**: `lab.html` (由 `lab.js` 驅動)。
    * **資料儲存 (Local)**: `chrome.storage.local`
        * `ytEnhancerSettings`: 核心設定 (含 Tier 1/2 列表, HQS 開關)。
        * `userApiKeys: []`: 使用者金鑰列表。
        * `yt-enhancer-cache-[VIDEO_ID]`: 影片翻譯快取。
    * **資料儲存 (Session)**: `chrome.storage.session`
        * `errorLogs: []`: 錯誤日誌。
        * `apiKeyCooldowns: {}`: 金鑰冷卻狀態。

* **典型資訊流**：

    1.  **[流程一：啟動與握手]**
        1.  `background.js` (`onInstalled`) 透過 `chrome.scripting.registerContentScripts` 將 `injector.js` 註冊到 `MAIN` World。
        2.  `content.js`(ISOLATED World) 載入，*主動*輪詢 (`REQUEST_PLAYER_RESPONSE`)。
        3.  `injector.js` 監聽到 `yt-navigate-finish`，獲取 `player.getPlayerResponse()` 並暫存，設定 `state.isDataReady = true`。(同時 `injector.js` 也會發送 `YT_NAVIGATED` 信號，確保 `content.js` 在軟導航後重置)。
        4.  `injector.js` 收到 `REQUEST_PLAYER_RESPONSE` 信號，回傳 `PLAYER_RESPONSE_CAPTURED` 資料。
        5.  `content.js` 收到資料，呼叫 `start()` 進入決策引擎。

    2.  **[流程二：HQS 翻譯流程 (Tier 2)]**
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

    3.  **[流程三：Prompt 實驗室]**
        1.  `lab.html` 載入，`lab.js` 觸發 `getDebugPrompts` 填入預設值。
        2.  使用者點擊「執行比較翻譯」。
        3.  `lab.js` 呼叫 `chrome.runtime.sendMessage`。
        4.  請求: `{ action: 'translateBatch', overridePrompt: '...' }` (Prompt A)。
        5.  `background.js` 偵測到 `overridePrompt` 參數，**繞過** `storage` 中的 Prompt，直接使用 `overridePrompt` 呼叫 API。
        6.  `lab.js` 收到結果，渲染對照表格。

## 3. 專案檔案結構與職責

* **後端 (Backend)**：
    * `background.js`: (Service Worker) **核心後端**。實作 `translateBatch` (Gemini API 呼叫、v4.1.3 精鍊錯誤處理、多金鑰/模型迴圈、冷卻機制、`overridePrompt` 邏輯)、`diagnoseAllKeys`、`writeToLog` (含 `userSolution`)、`get/setCache`、`get/setSettings`、`registerContentScripts`。
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

系統使用 `chrome.runtime.sendMessage` 進行內部 API 呼叫 (由 `background.js` 處理)。

* **`POST /translateBatch`** (虛擬)
    * **Action**: `translateBatch`
    * **功能**: 翻譯一個批次的文字。支援金鑰迴圈、模型降級與 Prompt 覆蓋。
    * **請求 (標準)**: `{ action: 'translateBatch', texts: [...], source_lang: "ja", models_preference: [...] }`
    * **請求 (實驗室)**: `{ action: 'translateBatch', texts: [...], source_lang: "ja", models_preference: [...], overridePrompt: "..." }`
    * **成功回應**: `{ data: ["...", "..."] }`
    * **失敗回應 (結構化)**:
        * `{ error: 'TEMPORARY_FAILURE', retryDelay: <Number> }` (可重試，例如 429, 503)
        * `{ error: 'PERMANENT_FAILURE', message: "..." }` (金鑰失效，例如 403, billing)
        * `{ error: 'BATCH_FAILURE', message: "..." }` (內容錯誤，例如 400)
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
* **`GET /getDebugPrompts`**
    * **Action**: `getDebugPrompts`
    * **功能**: (供 `lab.js` 使用) 獲取預設的通用 Prompt 和儲存的日文自訂 Prompt。
    * **回應**: `{ success: true, universalPrompt: "...", savedCustomPrompt: "..." }`
* **(其他)**: `toggleGlobalState`, `getErrorLogs`, `STORE_ERROR_LOG`, `getCache`, `setCache`...

## 5. 關鍵決策與歷史包袱 (重要)

* **[決策] 精鍊後端錯誤處理**：
    **原因**：舊版邏輯會將 `429` (速率限制) 錯誤地歸類為金鑰錯誤，導致無辜的金鑰被冷卻 60 秒，嚴重影響翻譯流程。
    **決策**：在 `background.js` 的 `translateBatch` 中嚴格區分錯誤：
        1.  **暫時性錯誤 (429, 503, 500)**：**嚴格禁止**冷卻金鑰，執行 `continue`（立即用同金鑰嘗試下一個備用模型）。
        2.  **永久性錯誤 (403, billing, invalid key)**：**必須**冷卻金鑰，執行 `break`（放棄此金鑰）。
        3.  **批次內容錯誤 (400, 404)**：執行 `continue`。
* **[決策] 握手架構 (Player-First Handshake)**：
    **原因**：解決 `content.js` (Isolated) 和 `injector.js` (Main) 之間的時序競爭 (Race Condition)。
    **決策**：改為 `content.js` (請求方) *主動輪詢* `injector.js` (回應方)，`injector.js` 則等待 `yt-navigate-finish` 確保 `playerResponse` 可用後才回應。
* **[決策] HQS 引擎的 ASR 比例觸發**：
    **原因**：HQS 引擎（`_phase` 函式）若套用在*人工*字幕上，會破壞原有的優良斷句。
    **決策**：HQS 引擎不僅受 `hqsEnabledForJa` 開關控制，還**必須**通過「多 Seg 事件比例」(`HQS_MULTI_SEG_THRESHOLD` = 0.35) 檢查。只有 ASR 字幕 (多 Seg 比例高) 才會啟用 HQS 管線。
* **[決策] 抽象化「語言等價性」**：
    **原因**：YouTube 提供的 `zh-TW` 或 `zh` 無法匹配使用者設定的 `zh-Hant`。
    **決策**：在 `content.js` 中建立 `checkLangEquivalency` 函式，定義「繁體中文群組」和「簡體中文群組」，所有語言比對必須通過此函式。
* **[決策] `injector.js` 的 3 次重試保險**：
    **原因**：為了解決 `player.setOption()` 偶爾因時序問題而靜默失效的問題。
    **影響**：`injector.js` 在收到 `FORCE_ENABLE_TRACK` 指令時，會在 0ms, 250ms, 500ms *執行 3 次* `setOption` 以確保成功。
* **[決策] `injector.js` 的 vssId `''` Fallback**：
    **原因**：`URL.searchParams.get('vssId')` 在 `vssId` 不存在時 (例如手動字幕) 會回傳 `null`，這會導致 `content.js` 的 `vssId === targetVssId` 驗證邏輯崩潰。
    **決策**：`injector.js` 在獲取 `vssId` 時使用 `|| ''`，確保 `vssId` 永不為 `null`。
* **[包袱] 資料庫自動遷移**：
    **影響**：`popup.js` 的 `loadSettings` 中的 `if (currentSettings.preferred_langs)` 區塊，其**唯一**存在的理由就是為了服務 v1.x -> v2.0 的資料庫遷移。
* **[包袱] `DEFAULT_CUSTOM_PROMPTS` 同步債**：
    **影響**：`DEFAULT_CUSTOM_PROMPTS` 常數同時存在於 `background.js` 和 `popup.js`。兩者必須保持同步。

## 6. 嚴格護欄 (Guard Rails) (最重要)

* **[禁止]**：**[護欄 0 (Backend)] 錯誤處理的唯一性**
    * **規則**：在 `background.js` 的 `translateBatch` 中，**嚴格禁止**將暫時性錯誤 (如 `429`, `503`, `500`) 視為金鑰錯誤。
    * **行為**：暫時性錯誤**必須**執行 `continue`（切換模型），**不得**執行 `break` 或冷卻金鑰。
    * **後果**：若違反，將導致金鑰被錯誤鎖定，翻譯流程卡在「黃色圓環」重試狀態。
* **[禁止]**：**[護欄 1 (Backend)] Serverless 原則**
    * **規則**：**嚴格禁止**重新引入任何對本地伺服器 (`127.0.0.1` 或 `backend.py`) 的依賴。
    * **後果**：專案必須保持 100% Serverless。
* **[禁止]**：**[護欄 2 (Backend)] 結構化錯誤**
    * **規則**：**嚴格禁止** `background.js` 的 `translateBatch` 回傳*籠統的錯誤字串*。
    * **後果**：它*必須*回傳結構化的 `{ error: 'TEMPORARY_FAILURE' | 'PERMANENT_FAILURE' | 'BATCH_FAILURE', ... }` 物件，`content.js` 依賴此結構進行 UI 響應。
* **[禁止]**：**[護欄 3 (Content)] 隔離區原則**
    * **規則**：**嚴格禁止**在 `content.js` (Isolated World) 中直接存取 `window.player` 或 `window.fetch`。
    * **後果**：所有與頁面 `window` 的互動*必須*透過 `postMessage` 委派給 `injector.js` (Main World)。
* **[禁止]**：**[護欄 4 (Content)] 語言匹配的唯一性**
    * **規則**：在 `content.js` 中，**所有**語言代碼比對**必須**使用 `checkLangEquivalency` 函式。
    * **後果**：若使用 `===` 或 `.includes()`，將導致 Tier 1/2/3 匹配失敗 (例如 `zh-TW` vs `zh-Hant`)。
* **[禁止]**：**[護欄 5 (Content)] 決策樹的鏡像原則**
    * **規則**：`content.js` 的兩個入口點：`start()`（自動載入） 和 `onMessageFromInjector`（手動切換） 內部的 Tier 1/2/3 判斷邏輯**必須**保持 100% 鏡像同步。
    * **後果**：若只修改其一，將導致手動切換字幕時決策邏輯錯誤。
* **[禁止]**：**[護欄 6 (Content)] HQS 引擎的回退**
    * **規則**：`content.js` 的 `parseRawSubtitles` 函式**必須**保留 `_fallbackParseRawSubtitles` 邏輯。
    * **後果**：移除 Fallback 將導致非日文、HQS 關閉、或人工日文字幕 (低比例) 的情況下，無法解析任何字幕。
* **[禁止]**：**[護欄 7 (UI)] `popup.js` 共享腳本**
    * **規則**：存取*只存在於* `options.html` 的 DOM 元素 (例如 `apiKeyList`) 之前，**必須**使用 `if (isOptionsPage)` 或 `if (element)` 進行嚴格的 `null` 檢查。
    * **後果**：若違反，`popup.html`（小彈窗）將立即崩潰。
* **[禁止]**：**[護欄 8 (Dev)] Prompt Lab API 的隔離**
    * **規則**：`content.js` 在呼叫 `translateBatch` 時，**嚴格禁止**傳遞 `overridePrompt` 參數。
    * **後果**：`overridePrompt` 參數僅供 `lab.js` 測試使用，若 `content.js` 傳遞此參數，將破壞正式的翻譯流程。