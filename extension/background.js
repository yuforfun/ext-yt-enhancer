/**
 * @file background.js
 * @author [yuforfun]
 * @copyright 2025 [yuforfun]
 * @license MIT
 */
'use strict';

// 區塊: DEFAULT_CORE_PROMPT_TEMPLATE
const DEFAULT_CORE_PROMPT_TEMPLATE = `你是一位頂尖的繁體中文譯者與{source_lang}校對專家，專為台灣的使用者翻譯 YouTube 影片的自動字幕。
你收到的{source_lang}原文雖然大多正確，但仍可能包含 ASR 造成的錯字或專有名詞錯誤。

你的核心任務:
發揮你的推理能力參考上下文的內容，理解原文的真實意圖，直接翻譯當前句子為完整、自然、口語化的繁體中文，不需要辨識是誰講的話。

範例:
- 輸入: ["こんにちは世界", "お元気ですか？"]
- 你的輸出應為: ["哈囉世界", "你好嗎？"]

執行指令:
請嚴格遵循以上所有指南與對照表，**「逐句翻譯」**以下 JSON 陣列中的每一句{source_lang}，並將翻譯結果以**相同順序、相同數量的 JSON 陣列格式**回傳。

{json_input_text}`;

// 區塊: lang_map
const LANG_MAP = {'ja': '日文', 'ko': '韓文', 'en': '英文'}; 

// 區塊: safety_settings
const SAFETY_SETTINGS = [
    {"category": "HARM_CATEGORY_HARASSMENT", "threshold": "BLOCK_NONE"},
    {"category": "HARM_CATEGORY_HATE_SPEECH", "threshold": "BLOCK_NONE"},
    {"category": "HARM_CATEGORY_SEXUALLY_EXPLICIT", "threshold": "BLOCK_NONE"},
    {"category": "HARM_CATEGORY_DANGEROUS_CONTENT", "threshold": "BLOCK_NONE"}
];

const API_KEY_COOLDOWN_SECONDS = 60; // 金鑰因配額失敗後的冷卻時間（秒）

// **「新使用者」的「初始預設值」
const DEFAULT_CUSTOM_PROMPTS = {
    "ja": `**風格指南:**
- 翻譯需符合台灣人的說話習慣，並保留說話者(日本偶像)的情感語氣。

**人名/專有名詞對照表 (優先級最高):**
無論上下文如何，只要看到左側的原文或讀音，就必須嚴格地翻譯為右側的詞彙。
- まちだ / まち田 / まちだ けいた -> 町田啟太
- さとう たける -> 佐藤健
- しそん じゅん -> 志尊淳
- しろたゆう -> 城田優
- みやざき ゆう -> 宮崎優
- 天ブランク -> TENBLANK
- グラスハート -> 玻璃之心
- Fujitani Naoki -> 藤谷直季
- Takaoka Sho -> 高岡尚
- Sakamoto Kazushi -> 坂本一志
- 西條朱音 -> 西條朱音
- 菅田將暉 -> 菅田將暉
- ノブ -> ノブ
`,
    "ko": `**風格指南:**
- 翻譯需符合台灣人的說話習慣，並保留說話者(偶像)的情感語氣。

**人名/專有名詞對照表 (優先級最高):**
無論上下文如何，只要看到左側的原文或讀音，就必須嚴格地翻譯為右側的詞彙。
`,
    "en": `**風格指南:**
- 翻譯需符合台灣人的說話習慣，並保留說話者的情感語氣。

**人名/專有名詞對照表 (優先級最高):**
無論上下文如何，只要看到左側的原文或讀音，就必須嚴格地翻譯為右側的詞彙。
`,
};

// 新增斷路器類別，負責管理 RPM (60s) 與 RPD (24h) 的冷卻狀態
class CircuitBreaker {
    constructor() {
        this.state = new Map(); // Key: "keyId::modelId", Value: timestamp (cooldown until)
        this.loadFromStorage();
    }

    async loadFromStorage() {
        try {
            const result = await chrome.storage.session.get({ 'circuitBreakerState': {} });
            // 將 Object 轉換回 Map
            for (const [k, v] of Object.entries(result.circuitBreakerState)) {
                if (v > Date.now()) { // 只載入尚未過期的冷卻
                    this.state.set(k, v);
                }
            }
        } catch (e) {
            console.error('[CircuitBreaker] Load failed:', e);
        }
    }

    async saveToStorage() {
        try {
            const obj = Object.fromEntries(this.state);
            await chrome.storage.session.set({ 'circuitBreakerState': obj });
        } catch (e) {
            console.error('[CircuitBreaker] Save failed:', e);
        }
    }

    getUniqueId(keyId, modelId) {
        return `${keyId}::${modelId}`;
    }

    isOpen(keyId, modelId) {
        const uid = this.getUniqueId(keyId, modelId);
        const cooldownUntil = this.state.get(uid);
        // 如果冷卻時間存在且大於現在，代表斷路器開啟 (Open/Tripped) -> 不可用
        if (cooldownUntil && cooldownUntil > Date.now()) {
            return { isOpen: true, remaining: Math.ceil((cooldownUntil - Date.now()) / 1000) };
        }
        return { isOpen: false, remaining: 0 };
    }

    trip(keyId, modelId, penaltyMs) {
        const uid = this.getUniqueId(keyId, modelId);
        const until = Date.now() + penaltyMs;
        this.state.set(uid, until);
        this.saveToStorage(); // 非同步寫入，不阻塞主流程
    }
}
// Session Storage 鍵值，用於儲存 Key 黏著性
const LAST_SUCCESSFUL_KEY_ID = 'lastSuccessfulKeyId';
// 初始化全域實例
const globalCircuitBreaker = new CircuitBreaker();

const sessionData = {
// 功能: 一個在記憶體中運行的全域變數，用於儲存與特定分頁 (Tab) 相關的臨時資料。
//      它會在瀏覽器關閉時被清除。
// input: 由 content.js 和 injector.js 寫入。
// output: 供 content.js 和 popup.js 讀取。
// 其他補充: lastPlayerData 作為一個「信箱」，解決了 injector.js 和 content.js 之間因載入時序不同而造成的通訊問題。
};



// 功能: 定義擴充功能的預設設定值。
// input: 無 (靜態物件)
// output: 在使用者首次安裝或清除儲存資料時，作為基礎設定寫入 chrome.storage。
// 其他補充: 新增 hqsEnabledForJa: false
const defaultSettings = {
    isEnabled: true,
    fontSize: 22,
    fontFamily: 'Microsoft JhengHei, sans-serif',
    models_preference: [
        "gemini-2.5-flash",
        "gemini-2.5-flash-lite"
    ],
    showOriginal: true,
    showTranslated: true,
    native_langs: ['zh-Hant'],
    auto_translate_priority_list: [
        {
            langCode: 'ja',
            name: '日文',
            customPrompt: DEFAULT_CUSTOM_PROMPTS.ja
        },
        {
            langCode: 'ko',
            name: '韓文',
            customPrompt: DEFAULT_CUSTOM_PROMPTS.ko
        },
        {
            langCode: 'en',
            name: '英文',
            customPrompt: DEFAULT_CUSTOM_PROMPTS.en
        }
    ],
    // HQS 引擎啟用開關 (預設關閉)
    hqsEnabledForJa: false
};


chrome.runtime.onInstalled.addListener(async () => {
// 區塊: chrome.runtime.onInstalled.addListener
// 功能: 在擴充功能首次安裝或更新時執行一次的特殊事件監聽器。
// input: 無
// output: 無 (操作 Chrome Scripting API)
// 其他補充: 核心任務是透過 chrome.scripting.registerContentScripts API，以動態方式注入 injector.js。
//           這確保了 injector.js 能以最高的權限 (MAIN world) 和最早的時機 (document_start) 運行。
    try {
        // 嘗試註銷舊的腳本，為新的註冊做準備。
        await chrome.scripting.unregisterContentScripts({ ids: ["injector-script"] });
    } catch (error) {
        // 如果在註銷時發生錯誤（例如首次安裝時找不到腳本），
        // 我們可以在控制台記錄下來除錯，但不會因此停止執行。
        if (error.message.includes("Nonexistent script ID")) {
            // // console.log("[Background] 無需註銷舊的 injector 腳本，直接進行安裝。");
        } else {
            // console.error("[Background] 註銷舊的 injector 腳本時發生非預期錯誤:", error);
        }
    }

    // 無論註銷是否成功，都必定會執行這裡的註冊新腳本的步驟。
    try {
        await chrome.scripting.registerContentScripts([{
            id: "injector-script",
            js: ["injector.js"],
            matches: ["*://www.youtube.com/*"],
            runAt: "document_start",
            world: "MAIN",
        }]);
        // // console.log("[Background] 新的 injector 腳本已成功註冊。");
    } catch (error) {
        // console.error("[Background] 註冊新的 injector 腳本時發生嚴重錯誤:", error);
    }
});

chrome.runtime.onMessage.addListener(function (request, sender, sendResponse) {
// 功能: 擴充功能內部所有組件 (content, popup) 之間的訊息總中樞。
// input: request (物件) - 包含 action 和 payload 的訊息。
//        sender (物件) - 訊息發送者的資訊，包含 tabId。
//        sendResponse (函式) - 用於非同步回傳結果給發送者。
// 其他補充: 修改 'translateBatch' 並新增 'getDebugPrompts'。
    let isAsync = false;

    // 取得 tabId，popup 頁面發送時可能沒有 sender.tab。
    const tabId = sender.tab ? sender.tab.id : null;

    switch (request.action) {
        
        
        case 'translateBatch':
            // 功能: 容錯翻譯處理器
            // 邏輯: 雙重迴圈 (Model -> Key) + CircuitBreaker + 智慧錯誤解析
            isAsync = true;

            (async () => {
                const { texts, source_lang, models_preference, overridePrompt } = request;
                
                // 1. 基礎檢查
                if (!texts || texts.length === 0) {
                    sendResponse({ data: [] });
                    return;
                }
                const keyResult = await chrome.storage.local.get(['userApiKeys']);
                let apiKeys = keyResult.userApiKeys || [];
                if (apiKeys.length === 0) {
                    await writeToLog('ERROR', '翻譯失敗：未設定 API Key');
                    sendResponse({ error: 'PERMANENT_FAILURE', message: '未設定 API Key' });
                    return;
                }
                
                // 金鑰黏著性：將上一次成功的 Key 移到最前面
                apiKeys = await reorderKeysByStickiness(apiKeys); 

                // 2. 準備 Prompt
                let fullPrompt;
                if (overridePrompt) {
                    const jsonInputText = JSON.stringify(texts);
                    fullPrompt = overridePrompt.replace('{json_input_text}', jsonInputText);
                } else {
                    const sourceLangName = LANG_MAP[source_lang] || '原文';
                    const corePrompt = DEFAULT_CORE_PROMPT_TEMPLATE.replace(/{source_lang}/g, sourceLangName);
                    const settingsResult = await chrome.storage.local.get(['ytEnhancerSettings']);
                    const settings = settingsResult.ytEnhancerSettings || {};
                    const tier2List = settings.auto_translate_priority_list || [];
                    const langConfig = tier2List.find(item => item.langCode === source_lang);
                    const customPromptPart = langConfig ? langConfig.customPrompt : "";
                    const jsonInputText = JSON.stringify(texts);
                    fullPrompt = `${customPromptPart}\n\n${corePrompt.replace('{json_input_text}', jsonInputText)}`;
                }

                const requestBody = {
                    "contents": [{ "parts": [{ "text": fullPrompt }] }],
                    "generationConfig": { "responseMimeType": "application/json" },
                    "safetySettings": SAFETY_SETTINGS
                };

                let lastError = null;
                let allKeysDeadToday = true;

                // 3. 雙重迴圈 - Model 優先 (Outer), Key 後補 (Inner)
                for (const modelName of models_preference) {
                    
                    let anyKeyAliveForThisModel = false; 

                    for (const keyInfo of apiKeys) {
                        const keyId = keyInfo.id;
                        const keyName = keyInfo.name || '未命名';

                        // 4. [Local Skip] 查表：檢查斷路器狀態
                        const breakerStatus = globalCircuitBreaker.isOpen(keyId, modelName);
                        if (breakerStatus.isOpen) {
                            // console.log(`[Skip] Key: ${keyName} @ ${modelName} is cooling down (${breakerStatus.remaining}s)`);
                            continue;
                        }

                        anyKeyAliveForThisModel = true; 
                        allKeysDeadToday = false; 

                        try {
                            // 5. 發送請求
                            const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent`, {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json', 'x-goog-api-key': keyInfo.key },
                                body: JSON.stringify(requestBody)
                            });

                            if (!response.ok) {
                                const errorText = await response.text();
                                // 將原始錯誤本文 (errorText) 輸出到 Console
                                console.error(`[Gemini API Error - Key ${keyId}] 原始錯誤本文:`, errorText);
                                throw new Error(`HTTP ${response.status}::${errorText}`);
                            }

                            const responseData = await response.json();
                            
                            const rawText = responseData.candidates[0].content.parts[0].text;
                            
                            const jsonMatch = rawText.match(/\[[\s\S]*\]/);
                            if (!jsonMatch) throw new Error('回應中找不到 JSON 陣列');
                            
                            const translatedList = JSON.parse(jsonMatch[0]);

                            if (Array.isArray(translatedList) && translatedList.length === texts.length) {
                                // 成功！
                                // 成功時，更新黏著性紀錄
                                await chrome.storage.session.set({ [LAST_SUCCESSFUL_KEY_ID]: keyId }); 
                                sendResponse({ data: translatedList });
                                return; 
                            } else {
                                throw new Error('BATCH_FAILURE::陣列長度不符');
                            }

                        } catch (e) {
                            // 6. 錯誤解析與判刑
                            const decision = parseErrorAndTrip(e, keyInfo, modelName);
                            
                            if (decision.penalty > 0) {
                                globalCircuitBreaker.trip(keyId, modelName, decision.penalty);
                            }

                            await writeToLog(decision.logLevel, decision.logMessage, decision.rawErrorContext, decision.userSolution);
                            
                            lastError = decision;
                            continue;
                        }
                    } 

                    if (!anyKeyAliveForThisModel) {
                        // console.log(`[Model Skip] ${modelName} has no available keys.`);
                    }

                } 

                // 7. 全軍覆沒：根據最後的狀態回傳結構化錯誤
                if (allKeysDeadToday) {
                    sendResponse({ error: 'TEMPORARY_FAILURE', retryDelay: 3600 }); 
                    await writeToLog('ERROR', '所有 Key 的每日額度(RPD)均已耗盡', null, '請明天再來，或新增更多 API Key。');
                } else if (lastError && lastError.type === 'BATCH_FAILURE') {
                    sendResponse({ error: 'BATCH_FAILURE', message: '模型無法處理此批次內容' });
                } else {
                    sendResponse({ error: 'TEMPORARY_FAILURE', retryDelay: 10 });
                }

            })();
            break;
        
        case 'STORE_ERROR_LOG':
            // 功能: 接收來自 content.js 的錯誤日誌並存入 chrome.storage.session。
            // input from: content.js -> setPersistentError 函式
            // output to: content.js (透過 sendResponse 確認收到)
            // 其他補充: 將舊格式錯誤轉換為新 LogEntry 格式
            isAsync = true;
            writeToLog('ERROR', request.payload.message)
                .then(() => sendResponse({ success: true }))
                .catch(() => sendResponse({ success: false }));
            break;
            
        case 'getErrorLogs': 
            // 功能: 從 chrome.storage.session 讀取所有已儲存的錯誤日誌。
            // input from: popup.js (options.html) -> loadErrorLogs 函式
            // output to: popup.js (透過 sendResponse 回傳日誌陣列)
            isAsync = true;
            chrome.storage.session.get({ 'errorLogs': [] }, (result) => {
                sendResponse({ success: true, data: result.errorLogs });
            });
            break;
            
        case 'clearAllCache':
            // 功能: 清除所有與此擴充功能相關的暫存和日誌資料。
            // input from: popup.js (options.html) -> clearCacheButton 的點擊事件
            // output to: popup.js (透過 sendResponse 確認完成)
            // 其他補充: 現在會同時清除 local (影片暫存) 和 session (日誌)
            isAsync = true;
            let clearedCount = 0;
            chrome.storage.local.get(null, (items) => {
                const cacheKeysToRemove = Object.keys(items).filter(key => key.startsWith('yt-enhancer-cache-'));
                clearedCount = cacheKeysToRemove.length;
                const localClearPromise = new Promise((resolve) => {
                    if (cacheKeysToRemove.length > 0) {
                        chrome.storage.local.remove(cacheKeysToRemove, resolve);
                    } else {
                        resolve();
                    }
                });
                const sessionClearPromise = chrome.storage.session.remove('errorLogs');

                Promise.all([localClearPromise, sessionClearPromise])
                    .then(() => {
                        // console.log(`[Background] 成功清除了 ${clearedCount} 個影片的暫存與所有日誌。`);
                        sendResponse({ success: true, count: clearedCount });
                    })
                    .catch((e) => {
                         console.error('[Background] 清除快取或日誌時發生錯誤:', e);
                         sendResponse({ success: false });
                    });
            });
            break;

        case 'getCache':
            // 功能: 從 chrome.storage.local 獲取指定 key 的暫存資料。
            // input: key (字串) - 暫存鍵值。
            // output: (物件 | null) - 暫存的資料或 null。
            isAsync = true;
            const cacheKeyGet = request.key;
            if (tabId && cacheKeyGet) {
                chrome.storage.local.get([cacheKeyGet], (result) => {
                    sendResponse({ success: true, data: result[cacheKeyGet] || null });
                });
            } else {
                sendResponse({ success: false, data: null });
            }
            break;

        case 'setCache':
            // 功能: 將資料透過 chrome.storage.local 存入指定 key 的暫存。
            // input: key (字串) - 暫存鍵值。
            //        data (物件) - 要暫存的資料。
            // output: 無
            isAsync = true; // 由於 storage 操作是非同步的，必須設為 true
            const { key: cacheKeySet, data } = request;
            if (tabId && cacheKeySet) {
                if (data === null || data === undefined) {
                    chrome.storage.local.remove(cacheKeySet, () => {
                        sendResponse({ success: true });
                    });
                } else {
                    chrome.storage.local.set({ [cacheKeySet]: data }, () => {
                        sendResponse({ success: true });
                    });
                }
            } else {
                sendResponse({ success: false });
            }
            break;

        case 'getSettings':
            // 功能: 從 chrome.storage 讀取使用者設定，若無則回傳預設值。
            // input from: content.js -> initialSetup 函式
            //             popup.js -> loadSettings 函式
            // output to: content.js 和 popup.js (透過 sendResponse 回傳設定物件)
            // 其他補充: 回應採用兼容格式，同時包含 'data' 和 'settings' 兩個鍵，以滿足新舊不同前端的需求。
            isAsync = true;
            chrome.storage.local.get({ 'ytEnhancerSettings': defaultSettings }, (result) => {
                sendResponse({ 
                    success: true, 
                    data: result.ytEnhancerSettings,
                    settings: result.ytEnhancerSettings 
                });
            });
            break;

        case 'getGlobalState':
            // 功能: 快速獲取擴充功能的總開關狀態。
            // input from: popup.js -> updatePopupStatus 函式
            // output to: popup.js (透過 sendResponse 回傳 isEnabled 狀態)
            // 其他補充: 專為 popup 主視窗設計的輕量級請求。
            isAsync = true;
            chrome.storage.local.get({ 'ytEnhancerSettings': defaultSettings }, (result) => {
                sendResponse({ 
                    success: true, 
                    isEnabled: result.ytEnhancerSettings.isEnabled 
                });
            });
            break;

        case 'updateSettings':
            // 功能: 更新使用者設定，將其儲存到 chrome.storage，並廣播通知所有開啟的 YouTube 分頁。
            // input from: popup.js -> saveSettings 函式
            // output to: popup.js (確認儲存) 和 所有 content.js (廣播 settingsChanged 事件)
            isAsync = true;
            chrome.storage.local.set({ 'ytEnhancerSettings': request.data })
                .then(() => {
                    sendResponse({ success: true });
                    chrome.tabs.query({ url: "*://www.youtube.com/*" }, (tabs) => {
                        for (const tab of tabs) {
                            chrome.tabs.sendMessage(tab.id, { action: 'settingsChanged', settings: request.data }).catch(() => {});
                        }
                    });
                })
                .catch(() => sendResponse({ success: false }));
            break;

        case 'toggleGlobalState':
            // 功能: 切換擴充功能的總開關 (isEnabled)。
            // input from: popup.js -> 主開關按鈕的點擊事件
            // output to: popup.js (回傳新的開關狀態) 和 所有 content.js (廣播 settingsChanged 事件)
            isAsync = true;
            chrome.storage.local.get({ 'ytEnhancerSettings': defaultSettings }, (result) => {
                const newSettings = result.ytEnhancerSettings;
                newSettings.isEnabled = !newSettings.isEnabled;
                chrome.storage.local.set({ 'ytEnhancerSettings': newSettings }, () => {
                    sendResponse({ isEnabled: newSettings.isEnabled });
                    chrome.tabs.query({ url: "*://www.youtube.com/*" }, (tabs) => {
                        for (const tab of tabs) {
                            chrome.tabs.sendMessage(tab.id, { action: 'settingsChanged', settings: newSettings }).catch(() => {});
                        }
                    });
                });
            });
            break;
        
        case 'getDebugPrompts':
            // 功能: 獲取實驗室所需的預設 Prompt 內容
            // input from: lab.js
            // output: { universalPrompt, savedCustomPrompt }
            // 其他補充: 會從 storage 讀取 "真實" 的自訂 Prompt
            isAsync = true;
            (async () => {
                try {
                    const result = await chrome.storage.local.get({ 'ytEnhancerSettings': defaultSettings });
                    const settings = result.ytEnhancerSettings;
                    
                    const tier2List = settings.auto_translate_priority_list || [];
                    const langConfig = tier2List.find(item => item.langCode === 'ja'); 
                    
                    let savedCustomPrompt;
                    if (langConfig && langConfig.customPrompt) {
                        savedCustomPrompt = langConfig.customPrompt;
                    } else {
                        savedCustomPrompt = DEFAULT_CUSTOM_PROMPTS['ja'];
                    }
                    
                    const universalPrompt = DEFAULT_CORE_PROMPT_TEMPLATE;
                    
                    sendResponse({ success: true, universalPrompt, savedCustomPrompt });
                    
                } catch (e) {
                    console.error('[Background] getDebugPrompts 失敗:', e);
                    sendResponse({ success: false, error: e.message });
                }
            })();
            break;

        case 'diagnoseAllKeys':
            isAsync = true;
            
            (async () => {
                const results = []; 
                const keyResult = await chrome.storage.local.get(['userApiKeys']);
                const apiKeys = keyResult.userApiKeys || []; 

                if (apiKeys.length === 0) {
                    await writeToLog('WARN', '診斷失敗：未設定 API Key', null, '請至「診斷與日誌」分頁新增您的 API Key。'); 
                    sendResponse([]); 
                    return;
                }

                const testBody = {
                  "contents": [
                    { "parts": [ { "text": "test" } ] } 
                  ],
                  "generationConfig": {
                    "responseMimeType": "text/plain" 
                  }
                };

                for (const keyInfo of apiKeys) { 
                    const keyName = keyInfo.name || '未命名金鑰';
                    try {
                        const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent`, {
                            method: 'POST',
                            headers: {
                                'Content-Type': 'application/json',
                                'x-goog-api-key': keyInfo.key
                            },
                            body: JSON.stringify(testBody)
                        });

                        if (!response.ok) {
                            let errorText = await response.text();
                            throw new Error(`HTTP ${response.status}: ${errorText}`);
                        }
                        
                        await writeToLog('INFO', `金鑰 '${keyName}' 診斷有效。`, null, null); 
                        results.push({ name: keyName, status: 'valid' }); 

                    } catch (e) {
                        await writeToLog('ERROR', `金鑰 '${keyName}' 診斷無效。`, e.message, '請確認金鑰是否複製正確、是否已啟用或已達用量上限。'); 
                        results.push({ name: keyName, status: 'invalid', error: e.message }); 
                    }
                }

                sendResponse(results); 
            })();
            
            break;
            
        default:
            break;
    }
    return isAsync;
});

// 新增標準化日誌函式
// 功能: 將標準化的日誌條目寫入 chrome.storage.session
// input: level ('ERROR' | 'WARN' | 'INFO')
//        message (string) - 白話說明
//        context (string | null) - 原始錯誤資訊
//        solution (string | null) - 解決方法
// output: (Promise) 寫入 storage
// 其他補充: 核心日誌公用函式
async function writeToLog(level, message, context = null, solution = null) {
    try {
        const newEntry = {
            timestamp: Date.now(),
            level: level,
            message: message,
            context: context,
            solution: solution
        };

        const result = await chrome.storage.session.get({ 'errorLogs': [] }); 
        const logs = result.errorLogs;
        
        logs.unshift(newEntry); // (最新在前)

        if (logs.length > 20) {
            logs.length = 20; // 維持最大長度
        }

        await chrome.storage.session.set({ 'errorLogs': logs });
    } catch (e) {
        console.error('[Background] writeToLog 函式執行失敗:', e);
    }
}

// 功能: 錯誤判讀輔助函式，決定刑期長短
// input: error (Error Object), keyInfo (Object), modelName (String)
// output: { type, penalty, logLevel, logMessage, userSolution, rawErrorContext }
function parseErrorAndTrip(error, keyInfo, modelName) {
    const errStr = error.message;
    let penalty = 0;
    let type = 'UNKNOWN';
    let logLevel = 'WARN';
    let logMessage = `Key '${keyInfo.name}' @ ${modelName} 失敗`;
    let userSolution = '系統將自動切換金鑰重試。';
    const rawErrorContext = errStr.substring(errStr.indexOf('::') + 2); // 提取 HTTP:: 後面的 JSON 文本
    const httpMatch = errStr.match(/HTTP (\d{3})/);
    const status = httpMatch ? parseInt(httpMatch[1]) : 0;

    // 1. 嘗試解析 Quota Violations
    let errorJson;
    try {
        // 提取並解析 JSON
        errorJson = JSON.parse(rawErrorContext);
    } catch (e) {
        errorJson = null; // 非 JSON 錯誤
    }
    
    const violations = errorJson?.error?.details?.find(d => d['@type'] === 'type.googleapis.com/google.rpc.QuotaFailure')?.violations || [];

    // 提取所有 Quota ID，用於日誌輸出
    const quotaIds = violations.map(v => v.quotaId).filter(id => id); 
    const quotaIdLog = quotaIds.length > 0 ? ` [Quota IDs: ${quotaIds.join(', ')}]` : '';

    // 2. 判決邏輯 (優先級: 永久/RPD > RPM > 兜底)
    
    let isRPDError = false;
    let isRPMError = false;
    
    for (const violation of violations) {
        const quotaId = violation.quotaId || '';

        // 判斷 A: 模型黑名單 / RPD 終止 (Pro 模型在 FreeTier 上就是 RPD 終止)
        if (
            quotaId.includes('GenerateContentInputTokensPerModelPerMinute-FreeTier') || // 此模型不適用於免費Key (FreeTier)
            quotaId.includes('PerDay') || // 每日額度耗盡 (RPD)
            quotaId.includes('PerHour') || // 每小時額度耗盡 (比 Day 次一級，但也是長時間冷卻)
            quotaId.includes('PerWeek')
        ) {
            isRPDError = true;
            // 找到 RPD/黑名單錯誤，優先處理
            break;
        }

        // 判斷 B: RPM 速率限制
        if (quotaId.includes('PerMinute')) {
            isRPMError = true;
        }
    }

    // 執行判罰
    if (isRPDError) {
        type = 'RPD_LIMIT';
        penalty = 24 * 60 * 60 * 1000; // 判罰 24 小時
        // 使用反引號加入 quotaIdLog
        logMessage += ` (每日/長時間額度耗盡)${quotaIdLog}`;
        logLevel = 'ERROR';
        userSolution = '此 Key 的長時間額度已滿或不適用此模型。系統將在 24 小時內自動跳過它。';
    } else if (isRPMError) {
        // 檢查 RetryInfo 獲取精確等待時間
        const retryInfo = errorJson?.error?.details?.find(d => d['@type'] === 'type.googleapis.com/google.rpc.RetryInfo');
        let retryDelaySec = 60; 
        if (retryInfo?.retryDelay) {
            // 提取 "56s" 中的數字
            const delayMatch = retryInfo.retryDelay.match(/(\d+)s/);
            retryDelaySec = delayMatch ? parseInt(delayMatch[1], 10) : 60;
        }
        
        type = 'RPM_LIMIT';
        penalty = (retryDelaySec + 5) * 1000; // 判罰 延遲時間 + 5 秒緩衝
        // 使用反引號加入 quotaIdLog
        logMessage += ` (速率限制 RPM，冷卻 ${retryDelaySec}s)${quotaIdLog}`;
    } 
    else if (errStr.includes('API_KEY_INVALID') || status === 400 || errStr.includes('billing')) {
        // [Fatal] 金鑰無效/帳單/400 內容錯誤 (兜底)
        type = 'FATAL';
        penalty = 365 * 24 * 60 * 60 * 1000; // 判罰 1 年 (永久)
        logMessage += ' (永久性金鑰錯誤)';
        logLevel = 'ERROR';
        userSolution = '請檢查 API Key 是否正確或帳單是否已啟用。';
    } else {
        // 未知錯誤 (例如 500, 503)
        type = 'UNKNOWN';
        penalty = 10 * 1000; // 10 秒短暫休息
        logMessage += ' (未知錯誤，短暫休息)';
    }

    return { type, penalty, logLevel, logMessage, userSolution, rawErrorContext };
}

// Key 黏著性的輔助函式
// 功能: 讀取上一次成功的 Key ID，並將其移到 Key 陣列的第一位。
// input: apiKeys (Array) - 原始 Key 陣列。
// output: (Array) - 排序後的 Key 陣列。
async function reorderKeysByStickiness(apiKeys) {
    if (!apiKeys || apiKeys.length <= 1) return apiKeys;
    
    // 讀取上一次成功的 Key ID
    const result = await chrome.storage.session.get({ [LAST_SUCCESSFUL_KEY_ID]: null });
    const lastSuccessfulId = result[LAST_SUCCESSFUL_KEY_ID];
    
    if (!lastSuccessfulId) return apiKeys;

    const stickIndex = apiKeys.findIndex(key => key.id === lastSuccessfulId);

    if (stickIndex > 0) {
        // 找到 Key，將其移動到第一個位置
        const stickyKey = apiKeys.splice(stickIndex, 1)[0];
        apiKeys.unshift(stickyKey);
        // console.log(`[Stickiness] Key ${lastSuccessfulId} 移至首位`);
    }
    
    return apiKeys;
}