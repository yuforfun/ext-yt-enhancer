# YouTube 翻譯增強工具 (Ext-YT-Enhancer) - 專案情境總結 (v4.3.0)

## 1. 專案目標與核心功能

此應用程式是一個 Chrome Manifest V3 (MV3) 擴充功能，旨在即時攔截並翻譯 YouTube 影片字幕，解決原生字幕品質不佳、無目標語言或自動字幕斷句破碎的問題。

專案採用 **完全 Serverless 架構**，不依賴外部中介伺服器，所有邏輯與 API 請求均由擴充功能直接發起。

**核心功能：**

* **智慧型後端代理 (Smart Backend Agent)**：
    * **斷路器機制 (Circuit Breaker)**：在記憶體中維護「金鑰-模型」的健康狀態。精準區分 **RPM** (速率限制，冷卻 60s) 與 **RPD** (每日額度耗盡，冷卻 24h)，在發送請求前先查表 (Local Skip)，避免無效請求。引入 `_readyPromise` + `ensureLoaded()`，消除 Service Worker 重啟後的 50–200ms 競態窗口；`_toggleLock` 旗標防止 popup 快速連點導致的 `toggleGlobalState` 競態條件。
    * **負載平衡 (Model-First Strategy)**：採用「模型優先」的雙重迴圈邏輯。優先使用高品質模型（如 Gemini 3.0 Pro）遍歷所有可用金鑰，失敗後才降級至次一級模型（如 Flash），確保翻譯品質最大化。迴圈結束後補掃所有 key/model 狀態，若本輪 trip 後已無可用組合，立即回傳 `reason: QUOTA_EXHAUSTED`，省去無意義的重試等待。
    * **金鑰黏著性 (Key Stickiness)**：`_lastSuccessfulKeyIdCache` 記憶體快取取代每次 session storage 讀取，`reorderKeysByStickiness` 改為同步函式；`recordSuccessfulKey` 同步更新快取並非同步持久化。`_clientCache` Map 快取 `GoogleGenAI` client 實例，避免每批次重複建構，`updateSettings` 含 `userApiKeys` 時自動失效。
* **播放器優先握手 (Player-First Handshake)**：
    * 解決 `content.js` 與 `injector.js` 之間的時序競爭 (Race Condition)。由 `injector.js` 確保獲取到 YouTube 播放器資料後，才回應 `content.js` 的主動輪詢。
* **三層式語言決策引擎 (3-Tier Engine)**：
    1.  **Tier 1 (原文顯示)**：優先匹配使用者設定的「母語」，不消耗 API 額度。
    2.  **Tier 2 (自動翻譯)**：匹配使用者設定的「目標語言」，根據自訂 Prompt 進行 AI 翻譯。支援快取命中路徑（需驗證 `sourceLang` 一致性）。
    3.  **Tier 3 (按需翻譯)**：Fallback 模式，顯示原文並在播放器右上角提供「翻譯」按鈕。點擊後優先使用 `activateNativeView` 預存的 `rawPayload` 直接觸發翻譯，無需重新請求 injector。
    * **統一決策入口 `_runTierDecision`**：`start()` 與 `TIMEDTEXT_DATA` handler 共同呼叫的非同步函式，消除約 180 行重複的 Tier 判斷邏輯，確保「鏡像原則」在架構層面強制落地。
* **高品質分句引擎 (HQS Engine)**：
    * 專門針對日文 ASR (自動辨識字幕) 破碎問題設計。
    * **觸發機制**：僅當 `hqsEnabledForJa` 開啟 + 語言為日文 + ASR 多 Seg 事件比例超過 `0.35` 時觸發。
    * **處理流程**：執行三階段管線（清理雜訊 -> 語意/時間斷句 -> 碎片合併）。

* **快取子系統 (Cache Subsystem)**：
    * **TTL 365 天**：`CACHE_TTL_MS` 常數定義 365 天有效期，`getCache` 讀取時比對 `cachedAt` 欄位自動清除過期快取。
    * **語言鎖定 (sourceLang Lock)**：`setCache` 存入時附加 `sourceLang` 欄位；`getCache` 讀取時嚴格比對（向下相容：舊版無 `sourceLang` 欄位時允許載入），防止跨語言快取污染。
    * **自動清理 `purgeExpiredCache`**：`background.js` 提供清理過期快取項目的工具函式。
    * **Metadata 附掛**：`content.js` 的 `setCache` wrapper 自動附加 `videoTitle` / `channelName` / `firstTwoOriginals`，供 options 頁「已快取影片清單」UI 顯示；舊快取 (無 metadata) 可透過 `backfillCacheMetadata` message 從 `translatedTrack` 前兩句補齊識別資訊。
    * **管理 UI**：options「診斷與日誌」頁面提供快取清單卡片，支援搜尋 / 排序 / 天數過濾 / 分頁 / 縮圖 lazy load + 點擊放大 modal / 個別與批次刪除。Background 提供 `listCaches` / `deleteCachesByKeys` / `backfillCacheMetadata` 三個 message handlers 支援此 UI。

## 2. 系統架構與資訊流

* **架構組成**：
* **開發層 (Source)**: `src/` (ES Modules)，支援 npm 生態系。
* **建置層 (Build)**: `esbuild` (自動化打包)，將 `src/` 編譯為瀏覽器可執行的 `extension/`。
* **執行層 (Runtime)**: `extension/` (Chrome Extension 環境)。
* **模型層**: Google GenAI SDK (`@google/genai`)。


* **典型資訊流**：

    1.  **[流程一：啟動與握手]**
        1.  `background.js` (`onInstalled`) 透過 `chrome.scripting.registerContentScripts` 將 `injector.js` 註冊到 `MAIN` World。
        2.  `content.js`(ISOLATED World) 載入，*主動*輪詢 (`REQUEST_PLAYER_RESPONSE`)。
        3.  `injector.js` 監聽到 `yt-navigate-finish`，獲取 `player.getPlayerResponse()` 並暫存，設定 `state.isDataReady = true`。(同時 `injector.js` 也會發送 `YT_NAVIGATED` 信號，確保 `content.js` 在軟導航後重置)。
        4.  `injector.js` 收到 `REQUEST_PLAYER_RESPONSE` 信號，回傳 `PLAYER_RESPONSE_CAPTURED` 資料。
        5.  `content.js` 收到資料，呼叫 `start()` 進入決策引擎。

    * **[流程二：HQS 翻譯流程 (Tier 2)]**
        1.  `content.js` (`start()`) 呼叫 `_runTierDecision()`，命中 Tier 2，先查詢 `getCache()`（驗證 `sourceLang` 一致性），若快取命中則直接呼叫 `activate()`；快取未命中則鎖定目標軌道 `vssId`，命令 `injector.js` (`FORCE_ENABLE_TRACK`)。
        2.  `injector.js` 攔截 `/api/timedtext` 回應，`postMessage('TIMEDTEXT_DATA', ...)`。
        3.  `content.js` 收到 `TIMEDTEXT_DATA`，驗證 `vssId` 或 `lang` 匹配 `targetVssId`，解除看門狗，呼叫 `_runTierDecision()` (step 3) -> `activate()`。
        4.  `activate()` 呼叫 `parseAndTranslate()` -> `parseRawSubtitles()`。
        5.  `parseRawSubtitles()` 檢查 `isJapanese` && `settings.hqsEnabledForJa`。
        6.  (若為 True) 計算「多 Seg 比例」，若 > `THRESHOLD` (0.35)，執行 HQS 管線 (`_phase1`...`_phase3`)；否則執行 `_fallbackParseRawSubtitles()`。
        7.  (若為 False) 執行 `_fallbackParseRawSubtitles()`。
        8.  `content.js` 呼叫 `processNextBatch()`，以 `BATCH_SIZE = 25` 批次呼叫 `chrome.runtime.sendMessage({ action: 'translateBatch', ... })`。
        9.  `background.js` 收到任務，先呼叫 `circuitBreaker.ensureLoaded()` 確保狀態已從 storage 載入，組合 Prompt，執行「金鑰-模型」迴圈呼叫 Gemini。
        10. (成功) `sendResponse({ data: [...] })`，記錄成功金鑰至 `_lastSuccessfulKeyIdCache`。
        11. (失敗) `sendResponse({ error: 'TEMPORARY_FAILURE' | 'PERMANENT_FAILURE' | 'BATCH_FAILURE', reason?: 'QUOTA_EXHAUSTED', ... })`。
        12. `content.js` 處理回應，渲染 UI 或顯示錯誤狀態（黃色圓環 `retrying`、紅框 `quota-exhausted Q`、紅色圓環、點擊重試行）。

    * **[流程三：批次翻譯與負載平衡]**
        1.  `content.js` 累積 **25 句** 字幕，呼叫 `translateBatch`。
        2.  `background.js` 收到請求，呼叫 `globalCircuitBreaker.ensureLoaded()` 確保斷路器狀態從 session storage 同步完畢（消除 Service Worker 重啟後的競態窗口）。
        3.  從 `_clientCache` 取得（或建立）`GoogleGenAI` client 實例；以 `_lastSuccessfulKeyIdCache` 重排 Keys 優先序。
        4.  **外層迴圈 (Model)**：依 `settings.models_preference` 陣列順序嘗試（實際清單以 `extension/config/models.js` 為準，可從 options 頁面拖曳排序）。
        5.  **內層迴圈 (Key)**：
            * 檢查 `CircuitBreaker.isOpen(Key, Model)`。若冷卻中則跳過 (Local Skip)。
            * 若可用，發送 API 請求。
        6.  **結果處理**：
            * **成功**：回傳翻譯結果，同步更新 `_lastSuccessfulKeyIdCache` 並非同步持久化。
            * **失敗**：解析錯誤代碼。若為 RPD (Day Limit) 判罰 24 小時；若為 RPM (Rate Limit) 判罰 60 秒。寫入斷路器並嘗試下一個 Key。
        7.  迴圈結束後補掃所有 key/model 狀態。若已無可用組合，立即回傳 `{ error: 'TEMPORARY_FAILURE', retryDelay: 3600, reason: 'QUOTA_EXHAUSTED' }`。
        8.  `content.js` 收到結果渲染 UI，或收到含 `reason: QUOTA_EXHAUSTED` 時顯示紅框 Q 圓環；一般暫時性過載顯示黃色重試圓環。

    * **[流程四：Prompt 實驗室]**
        1.  `lab.html` 載入，`lab.js` 觸發 `getDebugPrompts` 填入預設值。
        2.  使用者點擊「執行比較翻譯」。
        3.  `lab.js` 呼叫 `chrome.runtime.sendMessage`。
        4.  請求: `{ action: 'translateBatch', overridePrompt: '...' }` (Prompt A)。
        5.  `background.js` 偵測到 `overridePrompt` 參數，**繞過** `storage` 中的 Prompt，直接使用 `overridePrompt` 呼叫 API。
        6.  `lab.js` 收到結果，渲染對照表格。

## 3. 專案檔案結構與職責

* **後端邏輯 (Backend Context)**：
* `src/background.js`: **[唯一真理]** 開發與邏輯修改處。負責 SDK 初始化、Batch 處理、錯誤判刑。啟動時 `import '../extension/config/models.js'`，esbuild 會把 config 一起 bundle。
* `extension/background.js`: **[唯讀產物]** 由 `npm run build` 生成。**嚴禁手動修改**。


* **前端腳本 (Frontend Script)**：
* `extension/content.js`: 負責 DOM 操作、字幕樣式渲染、Orb 狀態顯示。**嚴禁包含任何 API 金鑰邏輯**。
* `extension/injector.js`: 負責將攔截器注入 YouTube 頁面環境。


* **模型清單與設定**：
* `extension/config/models.js`: **[單一真理]** Gemini 模型清單來源，掛載到 `globalThis.YT_ENHANCER_MODELS`；popup / lab / options / background 四處共用。
    * 加/減/改模型必須在此檔完成，禁止在其他檔案硬寫 model ID。
    * popup.html / lab.html / options.html 皆以 `<script src="config/models.js">` 在自身 script 前載入；background 透過 esbuild inject 拿到同一份資料。


* **稽核工具 (Tools)**：
* `tools/audit-models.mjs`: 本地稽核腳本。Paid key 呼叫 ListModels 取完整清單 → Free key 全測 → Paid 補測 Free 失敗的；比對 API vs `config/models.js` 差異，異動時透過 LINE Messaging API 推送摘要。
* `tools/audit-models.ps1`: Windows 工作排程器包裝腳本。
* `tools/.env.local`: **[Gitignore]** 存放兩把 Gemini API key 與 LINE token；範本見 `.env.local.example`。


* **配置與靜態資源**：
* `package.json`: 定義依賴 (`@google/genai`) 與建置腳本。
* `extension/style.css`: 定義 Orb 的視覺狀態 (Loading/Success/Error/CoolingDown)。



## 4. 後端 API 溝通協議 (SDK 規範)

全面遷移至官方 **Google GenAI SDK**，不再使用手動 Fetch。

* **初始化**: `import { GoogleGenAI } from "@google/genai"`。
* **資料解析**: 必須使用 `response.candidates[0].content.parts[0].text` 提取文字。
* **錯誤處理**: 必須解析 `error.details` 判斷 `PerDay` (24h冷卻) 或 `PerMinute` (65s冷卻)。

## 5. 關鍵決策與歷史包袱 (History & Decisions)

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

### 後端效能與穩健性
* **[決策] CircuitBreaker `_readyPromise` 模式**：
    * **原因**：MV3 Service Worker 可隨時被 Chrome 暫停並重啟，重啟後斷路器狀態需從 `chrome.storage.session` 非同步載入，若在載入完成前就接收到 `translateBatch` 請求，會導致所有 key/model 誤判為可用並發出無效請求。
    * **實作**：建構子中啟動 `_readyPromise = _loadFromStorage()`；`translateBatch` 在進入迴圈前先 `await ensureLoaded()`，確保狀態同步完畢。

* **[決策] `_clientCache` 避免重複建構 SDK Client**：
    * **原因**：`GoogleGenAI` 物件建構需解析 API Key、初始化 HTTP 連線池，每批次重複建構浪費資源。
    * **實作**：以 Map 以 key ID 為索引快取 client 實例；`updateSettings` 含 `userApiKeys` 更新時清除整個 Map 強制重建。

* **[決策] `toggleGlobalState` 改 async/await + `_toggleLock`**：
    * **原因**：原 callback 風格在 popup 快速連點時可能同時發起兩個 toggle，導致競態條件（兩次讀取到相同舊值，結果相互抵消）。
    * **實作**：加入 `globalCircuitBreaker._toggleLock` 布林旗標；若已鎖定則立即回傳 `{ isEnabled: null, error: 'busy' }`；`finally` 區塊確保例外時鎖定仍釋放。

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

* **[決策] `_runTierDecision` 統一決策入口**：
    * **原因**：`start()` (自動載入) 和 `TIMEDTEXT_DATA` handler (手動 CC 切換) 原本各自維護一套 Tier 1/2/3 判斷邏輯，約 180 行重複程式碼，任何修改都需雙份同步，易出現分歧。
    * **實作**：抽取 `async _runTierDecision(lang, timedTextPayload, vssId, availableTracks)` 作為唯一入口，`start()` 與 `TIMEDTEXT_DATA` handler 均委派至此函式，在架構層面強制「鏡像原則」。

* **[決策] Tier 3 點擊翻譯改用 rawPayload 直觸**：
    * **原因**：原流程點擊「翻譯」後重送 `FORCE_ENABLE_TRACK`，但該軌道 YouTube 已播放過，不會重新回傳資料，導致 watchdog 超時顯示 `cc-failed`。
    * **實作**：`activateNativeView` 執行時將 `rawPayload` 存入 `state.rawPayload`；點擊翻譯後優先使用此 payload 直接呼叫 `activate()`，同時設定 `hasActivated = true` 防止週期性 `TIMEDTEXT_DATA` 重複觸發 Tier 3 按鈕。

* **[決策] 快取 sourceLang 鎖定 + 向下相容**：
    * **原因**：使用者切換語言後若快取無語言標記，會載入錯誤語言的快取。
    * **實作**：新快取存入時附加 `sourceLang` 欄位；讀取時執行 `(!cachedData.sourceLang || cachedData.sourceLang === lang)` 比對——舊版無欄位快取允許載入（向下相容），新快取則嚴格比對，防止跨語言污染。

* **[決策] 配額耗盡 (QUOTA_EXHAUSTED) 獨立 Orb 狀態**：
    * **原因**：原本配額耗盡與暫時性過載都顯示同樣的黃色圓環，使用者無法區分「等一會兒就好」vs「今天額度用完了」。
    * **實作**：`background.js` 回傳 `reason: QUOTA_EXHAUSTED`；`content.js` 解析後顯示紅框 `Q` 圓環，tooltip 說明配額耗盡原因與解決方案。


* **[開發流] 引入編譯步驟 (esbuild)**
* **決策**：從直接撰寫瀏覽器腳本，轉變為 `src/` (原始碼) + `npm run build` (打包) 的流程。
* **原因**：為了使用官方 `Google GenAI SDK` (它依賴 Node.js 生態系)，Chrome MV3 環境無法直接 `import` npm 套件，必須透過打包工具將依賴項壓製成單一檔案。


* **[核心] 遷移至 Google GenAI SDK (`@google/genai`)**
* **決策**：捨棄手動維護的 `fetch` REST API 呼叫，全面改用官方 SDK。
* **原因**：手動處理 HTTP/2 連線復用 (Connection Reuse) 與複雜的 JSON 解析過於脆弱。SDK 提供了更強健的錯誤處理與類別封裝，雖增加了檔案體積 (約 +200KB)，但換取了極高的通訊穩定性。


* **[邏輯] 嚴格的斷路器機制 (Circuit Breaker)**
* **決策**：在客戶端實作 `QuotaFailure` 的深度解析，區分 `PerDay` (24h) 與 `PerMinute` (65s) 限制。
* **原因**：單純的重試 (Retry) 會導致 API Key 被 Google 判定為濫用。我們選擇「主動冷卻」，在本地端攔截請求，保護使用者的 API Key 信譽。


* **[架構] 模型清單集中化 + 本地稽核**
* **決策**：Gemini 模型清單集中到 `extension/config/models.js` 單一來源；`tools/audit-models.mjs` 每週跑一次比對 Google 實際 API 與 config 的漂移。
* **原因**：Gemini 版本更新頻繁 (數月即出新 flash 世代)，原本模型 ID 散落 popup / lab / background 三處，維護痛點大；付費 key 不上雲，稽核腳本純本地執行，透過 LINE 推送摘要通知模型異動。

### 歷史包袱 (Legacy Debt)
* **[包袱] `DEFAULT_CUSTOM_PROMPTS` vs `EXAMPLE_CUSTOM_PROMPTS` 雙常數**：
    * **描述**：`DEFAULT_CUSTOM_PROMPTS` 已改為通用格式說明範本（無硬編碼藝人名稱）；另設 `EXAMPLE_CUSTOM_PROMPTS` 常數保留個人化範例，供 options UI「載入範例」功能使用（對應新增的 `getExamplePrompt` message handler）。
    * **影響**：修改預設 Prompt 格式時仍需同步確認 `background.js` 與 `popup.js` 的展示是否一致。
* **[包袱] LANG_MAP 動態查找優先序**：
    * **描述**：`translateBatch` 的 Prompt 組裝現在優先從 `tier2` 設定物件的 `name` 欄位取得語言名稱，`LANG_MAP` 僅作最後備援，確保新增第四語言後 Prompt 品質不下降。
    * **影響**：新增語言時需確保 `tier2` 設定物件的 `name` 欄位有正確填入。

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
* **[禁止]**：**嚴格禁止**破壞 `content.js` 的鏡像原則。`start()` 和 `TIMEDTEXT_DATA` handler 內部的 Tier 1/2/3 判斷邏輯**必須**透過 `_runTierDecision` 統一入口執行，不得各自維護獨立的判斷分支。
* **[禁止]**：**嚴格禁止**在 `content.js` 呼叫 `translateBatch` 時傳遞 `overridePrompt` 參數。此參數僅供 `lab.js` 測試使用，若在正式環境傳遞將破壞使用者的自訂 Prompt 設定。
* **[禁止]**：**嚴格禁止**在 Tier 3 點擊翻譯流程中移除 `rawPayload` 的直接觸發路徑。點擊翻譯後**必須**優先使用 `state.rawPayload` 呼叫 `activate()`，並立即設定 `hasActivated = true`，否則會導致 watchdog 超時顯示 `cc-failed`，以及週期性 `TIMEDTEXT_DATA` 重複觸發翻譯按鈕。
* **[禁止]**：**嚴格禁止**在快取讀取邏輯中移除 `sourceLang` 的向下相容判斷 (`!cachedData.sourceLang`)。必須保持 `(!cachedData.sourceLang || cachedData.sourceLang === lang)` 的完整形式，否則升級前已完成翻譯的舊版快取將全數失效。

### [UI 與其他] Popup & Options
* **[禁止]**：**嚴格禁止**在 `popup.js` 中直接存取只存在於 `options.html` 的 DOM 元素 (例如 `apiKeyList`)。存取前**必須**使用 `if (isOptionsPage)` 或 `if (element)` 進行嚴格檢查，否則會導致 `popup.html` (小彈窗) 崩潰。

### [設定] 模型清單來源
* **[禁止]**：**嚴格禁止**在 `popup.js` / `lab.js` / `src/background.js` 或任何其他檔案硬寫 Gemini 模型 ID (如 `'gemini-2.5-flash'` 字面量)。所有模型清單、tier、tip、預設偏好順序**必須**透過 `globalThis.YT_ENHANCER_MODELS` 讀取 `extension/config/models.js` 單一來源。違反此規則將回到集中化前「模型散落三處難維護」的原始痛點。

* **[禁止] 直接修改 `extension/background.js` (No Direct Edit on Artifacts)**
* **內容**：**絕對禁止**在 `extension/background.js` 進行任何邏輯修改。
* **後果**：該檔案是 `src/background.js` 經過 esbuild 產生的「編譯成品」。任何在此處的手動修改，都會在下一次執行 `npm run build` 時被無情覆蓋並遺失。


* **[禁止] 混用通訊協議 (No Protocol Mixing)**
* **內容**：**嚴格禁止**在專案中重新引入手動的 `fetch('https://generativelanguage...')` 呼叫。
* **後果**：系統已全面標準化為 `GoogleGenAI` 類別實例。混用舊版 fetch 會導致全域的錯誤攔截 (Circuit Breaker) 無法捕捉該請求的失敗狀態，破壞冷卻機制。


* **[禁止] 使用非結構化路徑讀取回應**
* **內容**：**禁止**使用 SDK 的 `.text()` 簡便方法，必須使用 `response.candidates[0].content.parts[0].text`。
* **後果**：為了確保對應到正確的候選回應 (Candidate) 並過濾掉安全性阻擋 (Safety Block) 的空回應，必須使用明確的 JSON 路徑解析，否則容易在邊界情況下報錯。


* **[禁止] 隨意變更 `active_key_index` 儲存鍵名**
* **內容**：`chrome.storage.local` 中的 `active_key_index` 是前後端同步狀態的關鍵。
* **後果**：更動此鍵名需同步修改 `options.js`、`popup.js` 與 `background.js`，否則會導致 API Key 輪替功能失效，讓使用者卡死在無效的 Key 上。


