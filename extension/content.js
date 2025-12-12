// 請用以下完整內容，替換您現有的整個 content.js 檔案。
/**
 * @file content.js
 * @author [yuforfun]
 * @copyright 2025 [yuforfun]
 * @license MIT
 */

// 偵錯模式開關和計時器
const DEBUG_MODE = false;
const scriptStartTime = performance.now();

// 植入 HQS (高品質分句) 引擎常數
const HQS_PAUSE_THRESHOLD_MS = 500;
const HQS_LINGUISTIC_PAUSE_MS = 150;

const HQS_LINGUISTIC_MARKERS = [
    'です', 'でした', 'ます', 'ました', 'ません','ますか','ない',
    'だ','かな﻿','かしら',
    'ください',
    '。', '？', '！'
];

// 使用 Set 物件以優化查找效能
const HQS_CONNECTIVE_PARTICLES_TO_MERGE = new Set([
    'に', 'を', 'は', 'で', 'て', 'と', 'も', 'の' ,'本当','やっぱ','ども','お'
]);
// HQS 多 Seg 事件比例閾值
const HQS_MULTI_SEG_THRESHOLD = 0.35; // 70% (可調整 0.0 - 1.0)
// --- HQS 引擎常數結束 ---

class YouTubeSubtitleEnhancer {
    constructor() {
        // 功能: 初始化 class 實例。
        // 建立一個詳細的日誌記錄器
        this._log = (message, ...args) => {
            if (DEBUG_MODE) {
                const timestamp = (performance.now() - scriptStartTime).toFixed(2).padStart(7, ' ');
                console.log(`%c[指揮中心@${timestamp}ms]`, 'color: #059669; font-weight: bold;', message, ...args);
            }
        };
        this.currentVideoId = null;
        this.settings = {};
        this.requestIntervalId = null;
        this.resetState();
        this.onMessageFromInjector = this.onMessageFromInjector.bind(this);
        this.onMessageFromBackground = this.onMessageFromBackground.bind(this);
        this.handleTimeUpdate = this.handleTimeUpdate.bind(this);
        this.processNextBatch = this.processNextBatch.bind(this);
    }

    async initialSetup() {
        // 功能: (偵錯版) 腳本總入口，主動向 injector.js 請求資料，包含詳細日誌。
        this._log('(偵錯模式) 已啟動。');
        const response = await this.sendMessageToBackground({ action: 'getSettings' });
        this.settings = response?.data || {};
        this._log('初始設定讀取完畢:', this.settings);
        window.addEventListener('message', this.onMessageFromInjector);
        chrome.runtime.onMessage.addListener(this.onMessageFromBackground);
        this.requestPlayerResponse();
    }

    requestPlayerResponse() {
        // 功能: (偵錯版) 主動、重複地向 injector.js 請求資料，直到成功，包含詳細日誌。
        let attempts = 0;
        const MAX_ATTEMPTS = 25; // 最多嘗試5秒 (25 * 200ms)
        this._log('🤝 [握手] 開始向現場特工輪詢請求核心資料...');

        const sendRequest = () => {
            if (this.state.isInitialized) {
                this._log('🤝 [握手] 資料已收到，停止輪詢請求。');
                clearInterval(this.requestIntervalId);
                return;
            }
            if (attempts >= MAX_ATTEMPTS) {
                this._log('❌ [握手] 輪詢超時(5秒)，仍未收到現場特工的回應，停止請求。');
                clearInterval(this.requestIntervalId);
                return;
            }
            // 每次請求都打印日誌
            this._log(`🤝 [握手] 發送第 ${attempts + 1} 次 REQUEST_PLAYER_RESPONSE 信號...`);
            window.postMessage({ from: 'YtEnhancerContent', type: 'REQUEST_PLAYER_RESPONSE' }, '*');
            attempts++;
        };
        sendRequest();
        this.requestIntervalId = setInterval(sendRequest, 200);
    }

    // 功能: (vssId 驗證版) 主流程入口，在發出指令前鎖定目標 vssId。
    // TIER 1 檢查邏輯尊重使用者排序
    async start() {
        this._log(`[決策] --- 主流程 Start ---`);
        if (!this.currentVideoId || !this.state.playerResponse) {
            this._log(`❌ [決策] 啟動失敗，缺少 VideoID 或 playerResponse。`);
            return;
        }

        const availableTracks = this.getAvailableLanguagesFromData(this.state.playerResponse, true);
        const availableLangs = availableTracks.map(t => t.languageCode);
        this._log(`[決策] 可用語言: [${availableLangs.join(', ')}]`);

        // 讀取 Tier 1/2 設定
        const { native_langs = [], auto_translate_priority_list = [] } = this.settings;
        this._log(`[決策] Tier 1 (原文): [${native_langs.join(', ')}]`);
        this._log(`[決策] Tier 2 (自動): [${auto_translate_priority_list.map(t => t.langCode).join(', ')}]`);

        // Tier 1/2 檢查邏輯
        // --- TIER 1 檢查 (使用 checkLangEquivalency) ---
        let nativeMatch = null;
        const orderedNativeLangs = this.settings.native_langs || [];
        
        // 遍歷使用者偏好的 Tier 1 順序
        for (const preferredLang of orderedNativeLangs) { // e.g., 'zh-Hant'
            // 檢查影片是否提供此語言 (使用等價性檢查)
            const matchingVideoLang = availableLangs.find(videoLang => this.checkLangEquivalency(videoLang, preferredLang)); // e.g., 'zh-TW' matches 'zh-Hant'
            
            if (matchingVideoLang) {
                nativeMatch = matchingVideoLang; // 儲存影片實際的語言代碼 (e.g., 'zh-TW')
                break; // 停止搜尋
            }
        }
        
        if (nativeMatch) {
            this._log(`[決策] -> Tier 1 命中：匹配到最高優先級原文 (${nativeMatch})。`); 
            const trackToEnable = availableTracks.find(t => t.languageCode === nativeMatch); 
            if (trackToEnable) this.runTier1_NativeView(trackToEnable); 
            return; // 流程結束
        }

        // --- TIER 2 檢查 (使用 checkLangEquivalency) ---
        let tier2Match = null;
        for (const priorityItem of auto_translate_priority_list) {
            // 檢查影片是否提供此語言 (使用等價性檢查)
            const matchingVideoLang = availableLangs.find(videoLang => this.checkLangEquivalency(videoLang, priorityItem.langCode));
            
            if (matchingVideoLang) {
                tier2Match = availableTracks.find(t => t.languageCode === matchingVideoLang); // 獲取完整的軌道物件
                break; // 找到第一個匹配的，停止搜尋
            }
        }
        
        if (tier2Match) {
            this._log(`[決策] -> Tier 2 命中：匹配到自動翻譯語言 (${tier2Match.languageCode})。`);
            
            this.state.sourceLang = tier2Match.languageCode;
            this._log('[意圖鎖定] 已將期望語言 sourceLang 設為:', this.state.sourceLang);
            
            const cacheKey = `yt-enhancer-cache-${this.currentVideoId}`;
            const cachedData = await this.getCache(cacheKey);

            if (cachedData && cachedData.translatedTrack) {
                this._log('[決策] 發現有效暫存，直接載入。');
                this.state.translatedTrack = cachedData.translatedTrack;
                // 從快取讀取 vssId 並傳遞
                const vssIdFromCache = cachedData.vssId || ''; // 添加 fallback
                this.activate(cachedData.rawPayload, vssIdFromCache); // 觸發翻譯
            } else {
                this._log(`[決策] 無暫存，命令特工啟用軌道 [${tier2Match.languageCode}]...`);
                this.state.targetVssId = tier2Match.vssId;
                this._log(`[鎖定] 已鎖定目標 vssId: ${this.state.targetVssId}`);
                this.state.activationWatchdog = setTimeout(() => this.handleActivationFailure(), 3000);
                window.postMessage({ from: 'YtEnhancerContent', type: 'FORCE_ENABLE_TRACK', payload: tier2Match }, '*');
            }
            return; // 流程結束
        }

        // --- TIER 3 檢查：按需翻譯 (Fallback) ---
        // 優先選擇非 'a.' (自動) 的軌道
        const nonAutoTrack = availableTracks.find(t => !t.vssId.startsWith('a.'));
        const fallbackTrack = nonAutoTrack || availableTracks[0];

        if (fallbackTrack) {
            this._log(`[決策] -> Tier 3 觸發：進入按需翻譯模式 (${fallbackTrack.languageCode})。`);
            this.runTier3_OnDemand(fallbackTrack);
        } else {
            this._log(`[決策] -> 無任何可用字幕，停止。`);
        }
    }

    async onMessageFromInjector(event) {
        // 功能: 處理來自 injector.js 的所有訊息，包含修復後的語言切換邏輯。
        // input: event (MessageEvent) - 來自 injector.js 的訊息事件。
        // output: 根據訊息類型觸發對應的核心流程。
        // 其他補充: 這是擴充功能邏輯的核心中樞，處理導航、資料接收和字幕處理。
        if (event.source !== window || !event.data || event.data.from !== 'YtEnhancerInjector') return;

        const { type, payload } = event.data;

        switch (type) {
            case 'YT_NAVIGATED':
                this._log(`📢 [導航通知] 收到來自特工的換頁通知 (新影片ID: ${payload.videoId})，準備徹底重置...`);
                await this.cleanup();
                this.requestPlayerResponse();
                break;

            case 'PLAYER_RESPONSE_CAPTURED':
                this._log('🤝 [握手] 成功收到 PLAYER_RESPONSE_CAPTURED 信號！');
                if (this.state.isInitialized) {
                    this._log('警告：在已初始化的狀態下再次收到 PLAYER_RESPONSE，忽略。');
                    return;
                }
                
                this.state.playerResponse = payload;
                this.currentVideoId = payload.videoDetails.videoId;
                
                this._log(`設定新影片 ID: ${this.currentVideoId}`);
                this.state.isInitialized = true;
                this._log(`狀態更新: isInitialized -> true`);
                if (this.settings.isEnabled && this.currentVideoId) {
                    this.start();
                }
                break;

            case 'TIMEDTEXT_DATA':
                // 從 payload 解構出 vssId
                const { payload: timedTextPayload, lang, vssId } = payload;
                this._log(`收到 [${lang}] (vssId: ${vssId || 'N/A'}) 的 TIMEDTEXT_DATA。`);
                // 儲存當前 vssId 到 state，供快取使用
                this.state.currentVssId = vssId || ''; // 確保是字串

                // 步驟 0: 全域開關防護機制
                if (!this.settings.isEnabled && !this.state.isOverride) {
                    this._log('擴充功能目前為停用狀態，已忽略收到的 timedtext 數據。');
                    if (this.state.hasActivated) {
                        this._log('偵測到狀態殘留，執行溫和重置以關閉字幕。');
                        this.state.abortController?.abort();
                        this.state.translatedTrack = null;
                        this.state.isProcessing = false;
                        this.state.hasActivated = false;
                        if(this.state.subtitleContainer) this.state.subtitleContainer.innerHTML = '';
                    }
                    return;
                }

                // 步驟 1: 處理與看門狗相關的初始啟用驗證
                if (this.state.activationWatchdog) {
                    // (使用 checkLangEquivalency 進行驗證)
                    const isVssIdMatch = this.state.targetVssId && vssId === this.state.targetVssId;
                    const isLangMatch = this.state.sourceLang && this.checkLangEquivalency(lang, this.state.sourceLang);
                    
                    if (!isVssIdMatch && !(isLangMatch && !vssId)) { // vssId 匹配優先，其次才是無 vssId 的 lang 匹配
                         this._log(`[驗證失敗] 忽略了非目標字幕。目標 vssId: [${this.state.targetVssId}], 目標 lang: [${this.state.sourceLang}] | 收到 vssId: [${vssId || 'N/A'}], lang: [${lang}]`);
                        return;
                    }
                    this._log(`[驗證成功] 收到的字幕符合預期 (vssId 匹配或 lang 匹配)。`);
                    clearTimeout(this.state.activationWatchdog);
                    this.state.activationWatchdog = null;
                    this._log('[看門狗] 成功收到目標字幕，看門狗已解除。');
                }
                // 清除 targetVssId，避免影響後續的手動切換操作
                this.state.targetVssId = null;

                // 步驟 2: 判斷是「語言切換」還是「重複數據」
                if (this.state.hasActivated) {
                    if (!this.checkLangEquivalency(lang, this.state.sourceLang)) {
                        // 語言發生變化，執行「溫和重置」
                        this._log(`[語言切換] 偵測到語言從 [${this.state.sourceLang}] -> [${lang}]。執行溫和重置...`);
                        this.state.abortController?.abort();
                        this.state.translatedTrack = null;
                        this.state.isProcessing = false;
                        this.state.hasActivated = false; // 重置激活狀態，這是讓後續流程能繼續的關鍵
                        
                        this.state.isNativeView = false; 
                        document.getElementById('enhancer-ondemand-button')?.remove(); // 移除 Tier 3 按鈕
                        this.state.onDemandButton = null;
                        
                        if(this.state.subtitleContainer) this.state.subtitleContainer.innerHTML = '';
                        this._log('溫和重置完成。');
                    } else {
                        // 語言未變，是重複數據，直接忽略
                        this._log('語言相同，忽略重複的 timedtext 數據。');
                        return;
                    }
                }

                // 步驟 3: 執行激活流程 (適用於「首次激活」或「語言切換後的再激活」)
            if (!this.state.hasActivated) {
                    this._log(`[決策/手動] 收到語言 [${lang}]，執行三層決策樹...`);

                    const playerResponse = this.state.playerResponse;
                    const availableTracks = this.getAvailableLanguagesFromData(playerResponse, true);
                    const { native_langs = [], auto_translate_priority_list = [] } = this.settings;

                this.state.sourceLang = lang;
                this.state.hasActivated = true;
                this._log(`狀態更新: hasActivated -> true`);

                // 1. 執行 Tier 1 檢查
                const isTier1Match = native_langs.some(settingLang => this.checkLangEquivalency(lang, settingLang));

                if (isTier1Match) {
                    this._log(`[決策/手動] -> Tier 1 命中 (${lang})。`);
                    this.state.isNativeView = true;
                    // 傳遞 vssId
                    this.activateNativeView(timedTextPayload, vssId);
                    return; // Tier 1 流程結束
                }

                // 2. 執行 Tier 2 檢查
                const tier2Config = auto_translate_priority_list.find(item => this.checkLangEquivalency(lang, item.langCode));
                if (tier2Config) {
                    this._log(`[決策] -> Tier 2 命中 (${lang})。`);
                    this.state.isNativeView = false; 
                        document.getElementById('enhancer-ondemand-button')?.remove(); 
                        this.state.onDemandButton = null;

                    // 傳遞 vssId
                    this.activate(timedTextPayload, vssId); // 觸發完整翻譯
                    return; // Tier 2 流程結束
                }

                // 3. 執行 Tier 3 (Fallback)
                this._log(`[決策/手動] -> Tier 3 觸發 (${lang})。`);
                const trackToEnable = availableTracks.find(t => this.checkLangEquivalency(t.languageCode, lang));

                if (trackToEnable) {
                         // 1. 建立按鈕
                        const playerContainer = document.getElementById('movie_player');
                        if (playerContainer && !document.getElementById('enhancer-ondemand-button')) {
                            const btn = document.createElement('div');
                            btn.id = 'enhancer-ondemand-button';
                            btn.innerHTML = '翻譯'; 
                            btn.title = `將 ${this.getFriendlyLangName(trackToEnable.languageCode)} 翻譯為中文`;
                            this.handleOnDemandTranslateClick = this.handleOnDemandTranslateClick.bind(this);
                            btn.addEventListener('click', () => this.handleOnDemandTranslateClick(trackToEnable));
                            playerContainer.appendChild(btn);
                            this.state.onDemandButton = btn; // 儲存參照
                        }
                        
                     // 2. 顯示原文
                     this.state.isNativeView = true;
                     // 傳遞 vssId
                     this.activateNativeView(timedTextPayload, vssId);
                } else {
                        // 兜底：找不到軌道物件 (例如 playerResponse 中只有 zh-Hant，但 timedtext 卻回傳 en)
                        // 這種情況極不可能發生，但如果發生了，我們也不應該觸發翻譯。
                         this._log(`[決策/手動] 找不到 ${lang} 的軌道物件，但收到了字幕。執行 Tier 3 (僅原文)。`);
                     this.state.isNativeView = true;
                     // 傳遞 vssId
                     this.activateNativeView(timedTextPayload, vssId);
                }
            }
            break;
        }
    }

    async onMessageFromBackground(request, sender, sendResponse) {
        // 功能: 監聽來自 background.js 和 popup.js 的訊息。
        if (request.action === 'settingsChanged') {
            this._log('收到設定變更通知，正在更新...');
            const oldIsEnabled = this.settings.isEnabled;
            this.settings = request.settings;
            this.applySettingsToUI();
            if (oldIsEnabled !== this.settings.isEnabled) {
                if (this.settings.isEnabled) {
                    this._log('擴充功能已重新啟用，正在啟動翻譯流程...');
                    await this.start();
                } else {
                    this._log('擴充功能已停用，正在清理畫面...');
                    await this.cleanup();
                }
            }
        }
        if (request.action === 'forceRerun') {
            this._log('收到強制重跑指令，將清除暫存並重新執行主流程。');
            if (this.currentVideoId) {
                const cacheKey = `yt-enhancer-cache-${this.currentVideoId}`;
                await this.setCache(cacheKey, null);
            }
            await this.start();
        }
        if (request.action === 'translateWithOverride') {
            this._log(`收到語言覆蓋指令，目標語言: ${request.language}`);
            if (!this.state.playerResponse) {
                this.handleCriticalFailure('override', `缺少字幕清單 (playerResponse)，無法執行語言覆蓋。`);
                sendResponse({ success: false });
                return true;
            }
            this.state.abortController?.abort();
            document.getElementById('enhancer-status-orb')?.remove();
            document.getElementById('enhancer-subtitle-container')?.remove();
            this.toggleNativeSubtitles(false);
            this.state.hasActivated = false;
            this.state.isProcessing = false;
            this.state.translatedTrack = null;
            this.state.sourceLang = request.language;
            this.state.isOverride = true;
            const availableTracks = this.getAvailableLanguagesFromData(this.state.playerResponse, true);
            const trackToEnable = availableTracks.find(t => t.languageCode === request.language);
            if (trackToEnable) {
                window.postMessage({ from: 'YtEnhancerContent', type: 'FORCE_ENABLE_TRACK', payload: trackToEnable }, '*');
            } else {
                this.handleCriticalFailure('override', `在字幕清單中未找到語言「${request.language}」。`);
            }
        }
        if (sendResponse) sendResponse({ success: true });
        return true;
    }

    // 語言等價性檢查函式 (納入 'zh')
    checkLangEquivalency(videoLang, settingLang) {
        // 功能: 檢查影片語言是否滿足設定語言
        // input: videoLang (e.g., 'zh-TW'), settingLang (e.g., 'zh-Hant')
        // output: boolean
        if (videoLang === settingLang) return true;

        // 檢查是否同屬「繁體中文」群組
        const traditionalGroup = ['zh-Hant', 'zh-TW', 'zh-HK'];
        if (traditionalGroup.includes(videoLang) && traditionalGroup.includes(settingLang)) {
            return true;
        }

        // 檢查是否同屬「簡體中文」群組
        const simplifiedGroup = ['zh-Hans', 'zh-CN', 'zh'];
        if (simplifiedGroup.includes(videoLang) && simplifiedGroup.includes(settingLang)) {
            return true;
        }
        
        return false;
    }

    getAvailableLanguagesFromData(playerData, returnFullObjects = false) {
        // 功能: 解析可用語言，包含正確的資料路徑和無效軌道過濾器。
        try {
            const tracks = playerData?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
            const validTracks = tracks.filter(track =>
                track.vssId && (track.vssId.startsWith('.') || track.vssId.startsWith('a.'))
            );
            if (returnFullObjects) {
                return validTracks;
            }
            return validTracks.map(t => t.languageCode);
        } catch (e) {
            this._log("❌ 解析字幕數據失敗:", e);
            return [];
        }
    }

    // 功能: 重置狀態，增加目標 vssId 鎖定與重試監聽旗標。
    // 新增 isNativeView 和 onDemandButton 旗標
    resetState() {
        this._log('[狀態] resetState() 執行，所有狀態還原為初始值。');
        this.state = {
            isProcessing: false, hasActivated: false, videoElement: null, statusOrb: null,
            subtitleContainer: null, translatedTrack: null, sourceLang: null,
            abortController: null, playerResponse: null, isOverride: false,
            isInitialized: false,
            pendingTimedText: null,
            activationWatchdog: null,
            targetVssId: null, // 目標 vssId 鎖定
            hasRetryListener: false, // 批次重試監聽旗標
            isNativeView: false, // Tier 1/3 旗標
            onDemandButton: null // Tier 3 按鈕 DOM 參照
        };
    }

    async getCache(key) {
        // 功能: 從 background.js 獲取指定 key 的暫存資料。
        try {
            const response = await this.sendMessageToBackground({ action: 'getCache', key });
            return response?.data;
        } catch (e) {
            this._log('❌ 讀取暫存失敗:', e);
            return null;
        }
    }

    async setCache(key, data) {
        // 功能: 將資料透過 background.js 存入指定 key 的暫存。
        try {
            await this.sendMessageToBackground({ action: 'setCache', key, data });
        } catch (e) {
            this._log('❌ 寫入暫存失敗:', e);
        }
    }

    // 功能: 清理所有UI與狀態，確保停止看門狗並移除重試監聽。
    async cleanup() {
        this._log('--- 🧹 cleanup() 開始 ---');
        this.state.abortController?.abort();

        // 在清理時，一併清除尚未觸發的看門狗計時器
        if (this.state.activationWatchdog) {
            clearTimeout(this.state.activationWatchdog);
            this._log('[看門狗] 已清除看門狗計時器。');
        }

        if (this.requestIntervalId) {
            this._log('停止請求輪詢的計時器。');
            clearInterval(this.requestIntervalId);
            this.requestIntervalId = null;
        }
        
        // 移除批次重試點擊監聽器
        if (this.state.subtitleContainer && this.state.hasRetryListener) {
            this.state.subtitleContainer.removeEventListener('click', this.handleRetryBatchClick);
            this._log('已移除批次重試點擊監聽器。');
            this.state.hasRetryListener = false;
        }
        
        document.getElementById('enhancer-status-orb')?.remove();
        document.getElementById('enhancer-subtitle-container')?.remove();
        document.getElementById('enhancer-manual-prompt')?.remove();
        
        // 移除 Tier 3 按鈕
        document.getElementById('enhancer-ondemand-button')?.remove();
        
        this._log('已移除所有 UI DOM 元素。');
        
        if (this.state.videoElement) {
            this.state.videoElement.removeEventListener('timeupdate', this.handleTimeUpdate);
            this._log('已移除 timeupdate 事件監聽器。');
        }
        
        this.toggleNativeSubtitles(false); 
        this.resetState();
        this._log('--- ✅ cleanup() 完成 ---');
    }

    // 功能: (vssId 驗證版) 處理自動啟用字幕超時，確保清除鎖定。
    handleActivationFailure() {
        this._log('❌ [看門狗] 自動啟用字幕超時！');
        this.state.activationWatchdog = null;
        // 失敗時也要清除鎖定，以便後續手動操作能正常運作
        this.state.targetVssId = null; 
        
        if (!this.state.subtitleContainer) {
            const playerContainer = document.getElementById('movie_player');
            if(playerContainer) this.createSubtitleContainer(playerContainer);
        }
        if(this.state.subtitleContainer) {
            this.state.subtitleContainer.innerHTML = `<div class="enhancer-line enhancer-error-line">自動啟用字幕失敗，請手動選擇字幕</div>`;
        }
    }

    // 新增 Tier 1 啟動函式
    runTier1_NativeView(trackToEnable) {
        // 功能: 僅顯示原文，不翻譯 (Tier 1)。
        this._log(`[Tier 1] 執行 runTier1_NativeView，語言: ${trackToEnable.languageCode}`);
        
        // 1. (重要) 設置旗標，告訴 TIMEDTEXT_DATA 處理器應進入原文模式
        this.state.isNativeView = true;
        this.state.sourceLang = trackToEnable.languageCode; // 記錄當前語言
        
        // 2. 確保清除舊狀態 (例如 Tier 3 按鈕)
        this.cleanup(); 
        this.state.isNativeView = true; // cleanup 會重置，需再次設定
        this.state.sourceLang = trackToEnable.languageCode;

        // 3. 請求 injector.js 啟用軌道
        this._log(`[Tier 1] 命令特工啟用軌道 [${trackToEnable.languageCode}]...`);
        this.state.targetVssId = trackToEnable.vssId;
        this.state.activationWatchdog = setTimeout(() => this.handleActivationFailure(), 3000);
        window.postMessage({ from: 'YtEnhancerContent', type: 'FORCE_ENABLE_TRACK', payload: trackToEnable }, '*');
    }

    // 新增 Tier 3 啟動函式
    runTier3_OnDemand(trackToEnable) {
        // 功能: 顯示原文 + 右上角 Hover 按鈕 (Tier 3)。
        this._log(`[Tier 3] 執行 runTier3_OnDemand，語言: ${trackToEnable.languageCode}`);
        
        // 1. 設置旗標，進入原文模式
        this.state.isNativeView = true;
        this.state.sourceLang = trackToEnable.languageCode;
        
        // 2. 確保清除舊狀態
        this.cleanup();
        this.state.isNativeView = true; // cleanup 會重置，需再次設定
        this.state.sourceLang = trackToEnable.languageCode;
        
        // 3. 建立按鈕
        const playerContainer = document.getElementById('movie_player');
        if (!playerContainer) return;
        
        const btn = document.createElement('div');
        btn.id = 'enhancer-ondemand-button';
        btn.innerHTML = '翻譯'; // 使用 CSS 來設定樣式
        btn.title = `將 ${this.getFriendlyLangName(trackToEnable.languageCode)} 翻譯為中文`;
        
        // 綁定點擊事件
        this.handleOnDemandTranslateClick = this.handleOnDemandTranslateClick.bind(this);
        btn.addEventListener('click', () => this.handleOnDemandTranslateClick(trackToEnable));
        
        playerContainer.appendChild(btn);
        this.state.onDemandButton = btn; // 儲存參照
        
        // 4. 請求 injector.js 啟用軌道 (以顯示原文)
        this._log(`[Tier 3] 命令特工啟用軌道 [${trackToEnable.languageCode}] (僅原文)...`);
        this.state.targetVssId = trackToEnable.vssId;
        this.state.activationWatchdog = setTimeout(() => this.handleActivationFailure(), 3000);
        window.postMessage({ from: 'YtEnhancerContent', type: 'FORCE_ENABLE_TRACK', payload: trackToEnable }, '*');
    }

    // 新增 Tier 3 點擊處理函式
    async handleOnDemandTranslateClick(trackToEnable) {
        // 功能: Tier 3 按鈕的點擊事件處理。
        this._log(`[Tier 3] 按鈕被點擊，開始翻譯 ${trackToEnable.languageCode}`);
        
        // 1. 移除按鈕
        this.state.onDemandButton?.remove();
        this.state.onDemandButton = null;

        // 2. (重要) 解除原文模式旗標
        this.state.isNativeView = false;
        
        // 3. 執行「溫和重置」以準備進入 Tier 2 流程
        this.state.abortController?.abort();
        this.state.translatedTrack = null;
        this.state.isProcessing = false;
        this.state.hasActivated = false;
        if(this.state.subtitleContainer) this.state.subtitleContainer.innerHTML = '';
        
        // 4. (同 Tier 2) 檢查快取或觸發 activate() 流程
        this.state.sourceLang = trackToEnable.languageCode;
        this._log('[意圖鎖定] 已將期望語言 sourceLang 設為:', this.state.sourceLang);

        const cacheKey = `yt-enhancer-cache-${this.currentVideoId}`;
        const cachedData = await this.getCache(cacheKey);

        if (cachedData && cachedData.translatedTrack) {
            this._log('[Tier 3->2] 發現快取，直接載入。');
            this.state.translatedTrack = cachedData.translatedTrack;
            // 從快取讀取 vssId 並傳遞
            const vssIdFromCache = cachedData.vssId || ''; // 添加 fallback
            this.activate(cachedData.rawPayload, vssIdFromCache); // 觸發完整翻譯
        } else {
            this._log(`[Tier 3->2] 無快取，命令特工重新獲取軌道...`);
            // 注意：此時軌道應已在原文模式下載入，
            // 我們需要觸發 TIMEDTEXT_DATA 再次傳來，
            // 但由於 isNativeView = false，這次它將觸發 activate()。
            // 為保險起見，再次發送啟用命令。
            this.state.targetVssId = trackToEnable.vssId;
            this.state.activationWatchdog = setTimeout(() => this.handleActivationFailure(), 3000);
            window.postMessage({ from: 'YtEnhancerContent', type: 'FORCE_ENABLE_TRACK', payload: trackToEnable }, '*');
        }
    }

    // 功能: 啟動原文顯示流程 (不翻譯)。
    // input: initialPayload (object), vssId (string)
    // output: (DOM 操作)
    activateNativeView(initialPayload, vssId = '') {
        this.removeGuidancePrompt();
        this.state.rawPayload = initialPayload;
        this.state.videoElement = document.querySelector('video');
        const playerContainer = document.getElementById('movie_player');
        if (!this.state.videoElement || !playerContainer) {
            this.handleCriticalFailure('activateNativeView', "找不到播放器元件，啟動失敗。");
            return;
        } 
        
        // (不建立狀態圓環 Orb)
        this.createSubtitleContainer(playerContainer);
        this.applySettingsToUI();
        this.toggleNativeSubtitles(true); // 隱藏原生字幕
        
        // (不呼叫 parseAndTranslate)
        if (!this.state.translatedTrack) {
            // 傳入 vssId
            this.state.translatedTrack = this.parseRawSubtitles(initialPayload, vssId);
        }
        if (!this.state.translatedTrack.length) {
            this._log("解析後無有效字幕句段。");
            return;
        }
        
        this.beginDisplay(); // 直接開始顯示
        this._log(`[Tier 1/3] 原文模式 (activateNativeView) 啟動完畢。`);
    }

    // 功能: 翻譯流程的正式啟動函式。
    // input: initialPayload (object), vssId (string)
    // output: (DOM 操作, API 呼叫)
    async activate(initialPayload, vssId = '') {
        this.removeGuidancePrompt();
        this.state.rawPayload = initialPayload;
        this.state.videoElement = document.querySelector('video');
        const playerContainer = document.getElementById('movie_player');
        if (!this.state.videoElement || !playerContainer) {
            this.handleCriticalFailure('activate', "找不到播放器元件，啟動失敗。");
            return;
        }
        this.createStatusOrb(playerContainer);
        this.createSubtitleContainer(playerContainer);
        this.applySettingsToUI();
        this.toggleNativeSubtitles(true);
        this.setOrbState('translating');
        await this.parseAndTranslate(initialPayload, vssId);
    }

    // 功能: 將原始 timedtext JSON 格式化為內部使用的標準化字幕物件陣列。
    //      此函式為 HQS (高品質分句) 引擎的整合點。
    // input: payload (object) - 來自 injector.js 的 timedtext 原始資料。
    //        vssId (string, optional) - 字幕軌道的 vssId (保留參數)。
    // output: (Array) - 格式化為 [{ start, end, text, translatedText: null }, ...]
    // 其他補充: 增加比例判斷。增加詳細日誌以驗證比例計算。
    parseRawSubtitles(payload, vssId = '') {
        const isJapanese = this.checkLangEquivalency(this.state.sourceLang || '', 'ja');
        const isHqsEnabledByUser = this.settings.hqsEnabledForJa === true;

        if (isJapanese && isHqsEnabledByUser) {
            this._log('[HQS Engine] 日文且啟用 HQS，開始預分析多 Seg 比例...');
            let totalEventsIterated = 0;
            let newlineEventsSkipped = 0;
            let emptyEventsSkipped = 0;
            let totalContentEventCount = 0;
            let multiSegCount = 0;

            // --- 預分析迴圈 ---
            if (payload && Array.isArray(payload.events)) {
                totalEventsIterated = payload.events.length;
                for (const event of payload.events) {
                    // 跳過非內容事件
                    if (!event || !event.segs || event.segs.length === 0) {
                        emptyEventsSkipped++;
                        continue;
                    }
                    const isNewlineEvent = event.aAppend === 1 &&
                                        event.segs.length === 1 &&
                                        event.segs[0].utf8 === "\\n";
                    if (isNewlineEvent) {
                        newlineEventsSkipped++;
                        continue;
                    }

                    // 到這裡的是內容事件
                    totalContentEventCount++;
                    if (event.segs.length > 1) {
                        multiSegCount++;
                        // 打印出被錯誤計為 MultiSeg 的事件
                        this._log(`[HQS Engine DEBUG] 偵測到 MultiSeg 事件 (segs.length = ${event.segs.length})，計入 multiSegCount:`, JSON.parse(JSON.stringify(event))); // 使用深拷貝打印，防止後續修改影響
                    }
                }
            }
            // --- 預分析結束 ---

            const ratio = totalContentEventCount > 0 ? (multiSegCount / totalContentEventCount) : 0;

            // 打印詳細計算結果 (保持不變)
            this._log(`[HQS Engine] 預分析統計:`);
            this._log(`  - 總事件數 (payload.events): ${totalEventsIterated}`);
            this._log(`  - 跳過空/無 Segs 事件: ${emptyEventsSkipped}`);
            this._log(`  - 跳過換行 (\\n) 事件: ${newlineEventsSkipped}`);
            this._log(`  - ===> 內容事件總數 (分母): ${totalContentEventCount}`);
            this._log(`  - ===> 多 Seg (>1) 事件數 (分子): ${multiSegCount}`);
            this._log(`  - ===> 計算比例: ${ratio.toFixed(3)}`);
            this._log(`  - 閾值 (HQS_MULTI_SEG_THRESHOLD): ${HQS_MULTI_SEG_THRESHOLD}`);

            // 根據比例決定是否執行 HQS (保持不變)
            if (ratio >= HQS_MULTI_SEG_THRESHOLD) {
                this._log(`[HQS Engine] 決策: 比例達到閾值 (${(HQS_MULTI_SEG_THRESHOLD * 100).toFixed(0)}%)，執行 HQS 三階段管線。`);
                try {
                    const cleanedBlocks = this._phase1_cleanAndStructureEvents(payload);
                    const intermediateSentences = this._phase2_segmentByGapsAndLinguistics(cleanedBlocks);
                    const finalSentences = this._phase3_mergeSentences(intermediateSentences);

                    // 格式化為 translateTrack 結構
                    return finalSentences.map(s => ({
                        start: s.start_ms,
                        end: s.end_ms,
                        text: s.text.trim(),
                        translatedText: null
                    }));
                } catch (e) {
                    this._log('❌ HQS parseRawSubtitles 在 HQS 管線中發生嚴重錯誤:', e, payload);
                    this.setPersistentError(`[HQS] 字幕解析失敗: ${e.message}`, true);
                    // 發生錯誤時，回退到舊邏輯
                    return this._fallbackParseRawSubtitles(payload);
                }
            } else {
                this._log(`[HQS Engine] 決策: 比例未達閾值，回退至舊版解析器。`);
                return this._fallbackParseRawSubtitles(payload);
            }
        } else {
            // --- 非 HQS 路徑，執行 Fallback ---
            this._log(`[Parser] 未啟用 HQS 或語言非日文 (lang: ${this.state.sourceLang || 'N/A'})，使用舊版解析器。`);
            return this._fallbackParseRawSubtitles(payload);
        }
    }
    

    // 功能: 預設的字幕解析邏輯。
    // input: payload (object) - timedtext 原始資料。
    // output: (Array) - 格式化為 [{ start, end, text, translatedText: null }, ...]
    // 其他補充: 作為 HQS 不觸發時的回退。
    _fallbackParseRawSubtitles(payload) {
        if (!payload?.events) return [];
        const subtitles = payload.events
            .map(event => ({
                start: event.tStartMs,
                // 舊邏輯：結束時間 = 開始時間 + 持續時間 (可能與下一句重疊或有間隙)
                end: event.tStartMs + (event.dDurationMs || 5000),
                text: event.segs?.map(seg => seg.utf8).join('') || '',
            }))
            .filter(sub => sub.text.trim()); // 過濾空字幕

        // 舊邏輯：嘗試修正結束時間，使其等於下一句的開始時間
        for (let i = 0; i < subtitles.length - 1; i++) {
            // 檢查下一句是否有有效的 start time
            if (subtitles[i+1] && typeof subtitles[i+1].start === 'number') {
            subtitles[i].end = subtitles[i + 1].start;
            }
            // 確保 end 不會跑到 start 之前 (處理 YT 資料異常)
            if (subtitles[i].end < subtitles[i].start) {
                subtitles[i].end = subtitles[i].start + 1; // 至少給 1ms
            }
        }
        // 處理最後一句可能的異常 end time
        if (subtitles.length > 0) {
            const lastSub = subtitles[subtitles.length - 1];
            if (lastSub.end < lastSub.start) {
                lastSub.end = lastSub.start + (payload.events.find(e => e.tStartMs === lastSub.start)?.dDurationMs || 1000); // 嘗試用 dDurationMs 或預設 1s
            }
        }

        // 格式化輸出
        return subtitles.map(sub => ({ ...sub, translatedText: null }));
    }

    // 功能: 清理 YT 原始事件，並建立包含絕對時間的 Segments。
    // input: rawPayload (object) - 來自 injector.js 的 timedtext 原始資料。
    // output: (Array) - 清理後的區塊 [{ block_start_ms, block_end_ms, segments: [{text, start_ms}, ...] }, ...]
    // 其他補充: 對應 python segment_test.py -> clean_subtitle_events
    //          增加對漏網 newline 事件缺少 dDurationMs 的容錯
    _phase1_cleanAndStructureEvents(rawPayload) {
        // 1. 過濾 `\n` 事件
        const content_events = [];
        if (!rawPayload || !Array.isArray(rawPayload.events)) {
            this._log('HQS P1: 警告: 找不到 .events 陣列或格式錯誤。');
            return [];
        }

        for (const event of rawPayload.events) {
            if (!event || !event.segs || event.segs.length === 0) continue;

            const is_newline_event = event.aAppend === 1 &&
                                    event.segs.length === 1 &&
                                    event.segs[0].utf8 === "\\n";

            if (!is_newline_event) {
                content_events.push(event);
            }
            // else: 如果是 newline 事件，會在此被過濾掉
        }

        // 2. 遍歷內容事件，計算實際結束時間，並建立絕對時間 segments
        const cleaned_blocks = [];
        const total_events = content_events.length;
        if (total_events === 0) return [];

        for (let i = 0; i < total_events; i++) {
            const current_event = content_events[i];

            // --- 加固時間戳檢查 (Newline 容錯) START ---
            if (typeof current_event.tStartMs !== 'number') {
                // tStartMs 缺失是嚴重錯誤，必須跳過
                this._log(`HQS P1: 警告: 跳過格式錯誤 event (缺少 tStartMs)。`);
                continue;
            } else if (typeof current_event.dDurationMs !== 'number') {
                // dDurationMs 缺失，但檢查是否為漏網的 newline 事件
                // (理論上 newline 應該在上面被過濾了，這是最後防線)
                const isMissedNewline = current_event.aAppend === 1
                                    && current_event.segs?.length === 1
                                    && current_event.segs[0].utf8 === "\\n";
                if (!isMissedNewline) {
                    // 如果不是 newline 事件，才報警告並跳過
                    const eventContentPreview = current_event.segs?.[0]?.utf8?.substring(0, 20) || 'N/A';
                    this._log(`HQS P1: 警告: 跳過格式錯誤 event (缺少 dDurationMs 且非 newline)。內容預覽: "${eventContentPreview}"`, current_event);
                    continue;
                }
                // else: 如果是漏網的 newline 事件，即使缺少 dDurationMs 也容忍，繼續處理
                //       因為它後續不會產生有效文字 segment。
            }

            const start_ms = current_event.tStartMs;
            // 使用 dDurationMs 計算 planned_end_ms (如果 dDurationMs 存在)
            // 對於漏網的 newline (dDurationMs 可能不存在)，給一個預設值 (例如 100ms)，雖然不影響結果
            const planned_end_ms = start_ms + (current_event.dDurationMs || 100);

            // 計算 actual_end_ms (取 planned_end_ms 和 next_event.tStartMs 的最小值)
            let actual_end_ms = planned_end_ms;
            if (i + 1 < total_events) {
                const next_event = content_events[i+1];
                if (typeof next_event.tStartMs === 'number') {
                    actual_end_ms = Math.min(planned_end_ms, next_event.tStartMs);
                }
            }

            // 3. 建立包含絕對時間的 segments
            let full_text = "";
            const segments_with_absolute_time = [];
            // 確保 segs 存在才遍歷
            if (Array.isArray(current_event.segs)) {
                for (const seg of current_event.segs) {
                    // 確保 seg 和 utf8 存在
                    const text = (seg && seg.utf8 || '').replace('\n', '').trim();
                    if (text) {
                        full_text += text;
                        const offset_ms = seg.tOffsetMs || 0;
                        const seg_start_ms = start_ms + offset_ms;

                        // 確保 seg_start_ms 不超過 actual_end_ms
                        if (seg_start_ms < actual_end_ms) {
                            segments_with_absolute_time.push({
                                text: text,
                                start_ms: seg_start_ms
                            });
                        }
                    }
                }
            }

            // 4. 僅在 full_text 非空時才加入
            if (full_text) {
                cleaned_blocks.push({
                    block_start_ms: start_ms,
                    block_end_ms: actual_end_ms,
                    segments: segments_with_absolute_time
                });
            }
            // else: 如果是漏網的 newline 事件，full_text 會是空，自然被過濾
        }

        return cleaned_blocks;
    }

    // 功能: 依據時間間隔 (Gaps) 和語言標記 (Linguistics) 進行分句。
    // input: cleanedBlocks (Array) - 來自 Phase 1 的輸出。
    // output: (Array) - 中間句子列表 [{ text, start_ms, end_ms, reason }, ...]
    // 其他補充: 對應 python segment_test.py -> segment_blocks_by_internal_gaps
    _phase2_segmentByGapsAndLinguistics(cleanedBlocks) {
        const intermediateSentences = [];
        
        // 從 'this' (class 實例) 獲取常數
        const pause_threshold_ms = HQS_PAUSE_THRESHOLD_MS;
        const linguistic_markers = HQS_LINGUISTIC_MARKERS;
        const linguistic_pause_ms = HQS_LINGUISTIC_PAUSE_MS;

        for (const event of cleanedBlocks) {
            const segments = event.segments;
            if (!segments || segments.length === 0) continue;
            
            let current_sentence_segs_text = [];
            let current_sentence_start_ms = segments[0].start_ms;

            for (let i = 0; i < segments.length; i++) {
                const current_seg = segments[i];
                const current_seg_text = current_seg.text;
                current_sentence_segs_text.push(current_seg_text);

                let split_reason = null;
                const is_last_segment_in_block = (i === segments.length - 1);

                if (!is_last_segment_in_block) {
                    const next_seg = segments[i+1];
                    const pause_duration = next_seg.start_ms - current_seg.start_ms;
                    
                    // 檢查語言標記是否命中
                    const marker_found = linguistic_markers.some(marker => current_seg_text.includes(marker));

                    // 決策 1: 時間間隔 > 500ms
                    if (pause_duration > pause_threshold_ms) {
                        if (current_sentence_segs_text.length > 1) { // 避免單一 seg 被切分
                            split_reason = `Time Gap (${pause_duration}ms)`;
                        }
                    // 決策 2: 語言標記 + 暫停 > 150ms
                    } else if (marker_found && pause_duration > linguistic_pause_ms) {
                        if (current_sentence_segs_text.length > 1) { // 避免單一 seg 被切分
                            split_reason = `Linguistic + Pause (${pause_duration}ms)`;
                        }
                    }
                
                // 決策 3: 區塊結尾
                } else if (is_last_segment_in_block) {
                    split_reason = "End of Block";
                }

                // 執行切分
                if (split_reason) {
                    const sentence_end_ms = is_last_segment_in_block ? event.block_end_ms : segments[i+1].start_ms;
                    const final_text = current_sentence_segs_text.join("");
                    
                    if (final_text) {
                        intermediateSentences.push({
                            text: final_text,
                            start_ms: current_sentence_start_ms,
                            end_ms: sentence_end_ms,
                            reason: split_reason
                        });
                    }
                    
                    current_sentence_segs_text = [];
                    if (!is_last_segment_in_block) {
                        current_sentence_start_ms = segments[i+1].start_ms;
                    }
                }
            }
        }
        
        return intermediateSentences;
    }

    // 功能: HQS Phase 3 後處理。使用迭代方法合併 'End of Block' 或 '助詞結尾' 的句子。
    // input: intermediateSentences (Array) - 來自 Phase 2 的輸出。
    // output: (Array) - 最終句子列表 [{ text, start_ms, end_ms, reason }, ...]
    // 其他補充: 對應 python segment_test.py -> post_process_merges
    _phase3_mergeSentences(intermediateSentences) {
        if (!intermediateSentences || intermediateSentences.length === 0) {
            return [];
        }

        const final_merged = [];
        const connective_markers = HQS_CONNECTIVE_PARTICLES_TO_MERGE; // 從 Set 獲取

        for (const current of intermediateSentences) {
            const current_text_cleaned = current.text.trim();
            
            // 跳過空的句子
            if (!current_text_cleaned) continue;

            // 如果 final_merged 是空的，直接加入
            if (final_merged.length === 0) {
                final_merged.push(current);
                continue;
            }

            // 取出 final_merged 中的最後一句 (即 previous)
            const previous = final_merged[final_merged.length - 1];
            const previous_text_cleaned = previous.text.trim();

            // --- 判斷 previous 是否需要與 current 合併 ---
            let should_merge = false;
            
            // 條件 1: 前一句是 'End of Block'
            const is_prev_end_of_block = previous.reason === 'End of Block';
            
            // 條件 2: 前一句以「連接助詞」結尾
            let does_prev_end_with_particle = false;
            if (previous_text_cleaned.length > 0) {
                // 檢查最後一個字元是否在 Set 中
                does_prev_end_with_particle = connective_markers.has(previous_text_cleaned.slice(-1));
            }

            if (is_prev_end_of_block || does_prev_end_with_particle) {
                should_merge = true;
            }
            
            // --- 執行合併或新增 ---
            if (should_merge) {
                // 合併：修改 final_merged 的最後一個元素 (in-place)
                previous.text = previous_text_cleaned + current_text_cleaned; // 合併文字
                previous.end_ms = current.end_ms; // 更新結束時間
                previous.reason = current.reason; // 繼承當前句 (current) 的 reason
            } else {
                // 新增：將 current 作為新句子加入
                final_merged.push(current);
            }
        }
        
        // 最後清理一次所有合併後的文本 (雖然合併時已 trim, 這裡再確保一次)
        return final_merged
            .filter(s => s.text.trim()) // 再次過濾空字串
            .map(s => ({ ...s, text: s.text.trim() }));
    }

    // 功能: 解析字幕並啟動分批翻譯的總流程。
    // input: payload (timedtext 物件), vssId (string)
    // output: 無 (啟動 processNextBatch 遞迴)
    async parseAndTranslate(payload, vssId = '') {
        if (this.state.isProcessing) return;
        this.state.isProcessing = true;
        if (!this.state.translatedTrack) {
                // 將 vssId 傳遞給 parseRawSubtitles
                this.state.translatedTrack = this.parseRawSubtitles(payload, vssId);
        }
        if (!this.state.translatedTrack.length) {
            this._log("解析後無有效字幕句段，停止翻譯。");
            this.setOrbState('error', '無有效字幕內容');
            this.state.isProcessing = false; // (此處為 '無字幕' 的出口，是正確的)
            return;
        }
        this.state.translationProgress = {
            done: this.state.translatedTrack.filter(t => t.translatedText).length,
            total: this.state.translatedTrack.length
        };
        this.beginDisplay();
        await this.processNextBatch();
        
        // 移除: this.state.isProcessing = false;
        // 說明: isProcessing 旗標的關閉，將交由 processNextBatch 內部
        //       在「真正成功」或「永久失敗」時自行處理，以確保 setTimeout 得以正常運作。
    }

    async processNextBatch() {
        // 功能: 處理翻譯批次，並在正確的出口管理 isProcessing 旗標。
        // input: 無 (從 this.state.translatedTrack 讀取)
        // output: (遞迴呼叫) 或 (觸發錯誤 UI)
        // 其他補充: 在 3 個流程終點新增 this.state.isProcessing = false;
        const BATCH_SIZE = 40; 
        const segmentsToTranslate = [];
        const indicesToUpdate = [];
        for (let i = 0; i < this.state.translatedTrack.length; i++) {
            if (!this.state.translatedTrack[i].translatedText && !this.state.translatedTrack[i].tempFailed) { // 確保不重試 tempFailed
                segmentsToTranslate.push(this.state.translatedTrack[i].text);
                indicesToUpdate.push(i);
                if (segmentsToTranslate.length >= BATCH_SIZE) break;
            }
        }
        if (segmentsToTranslate.length === 0) {
            this._log("所有翻譯批次處理完成！");
            this.setOrbState('success');
            this.state.isProcessing = false; // 1. 成功出口
            return;
        }
        const alreadyDone = this.state.translatedTrack.filter(t => t.translatedText).length;
        this.state.translationProgress.done = alreadyDone;
        this.setOrbState('translating');
        this.state.abortController = new AbortController();
        try {
            const translatedTexts = await this.sendBatchForTranslation(segmentsToTranslate, this.state.abortController.signal);
            if (translatedTexts.length !== segmentsToTranslate.length) {
                throw new Error("翻譯回傳的句數與請求不符。");
            }
            translatedTexts.forEach((text, i) => {
                if (this.state.translatedTrack[indicesToUpdate[i]]) {
                    this.state.translatedTrack[indicesToUpdate[i]].translatedText = text;
                }
            });
            // 更新快取
            if (this.currentVideoId) {
                const cacheKey = `yt-enhancer-cache-${this.currentVideoId}`;
                const currentDoneCount = this.state.translatedTrack.filter(t => t.translatedText).length;
                await this.setCache(cacheKey, {
                    translatedTrack: this.state.translatedTrack,
                    rawPayload: this.state.rawPayload,
                    // 將 vssId 存入快取
                    vssId: this.state.currentVssId || '' // 從 state 讀取
                });
                this._log(`批次完成 (${currentDoneCount}/${this.state.translationProgress.total})，進度已暫存。`);
            }
            await this.processNextBatch(); // 遞迴

        //  重構 catch 區塊以響應智慧錯誤
        } catch (e) {
            const errorMsg = String(e.message);

            // 1. 處理 AbortError
            if (errorMsg.includes('AbortError')) {
                this._log("翻譯任務已中止 (AbortError)，此為正常操作。");
                // (注意: AbortError 也算 'isProcessing = false'，但通常由 cleanup 觸發)
                this.state.isProcessing = false;
                return; // 結束，不重試
            }

            this._log("❌ 翻譯批次失敗:", e);

            // 2. 智慧錯誤
            if (errorMsg.includes('TEMPORARY_FAILURE')) {
                // 情境一：暫時性錯誤 (429/503)
                // (流程仍在繼續，*不*設定 isProcessing = false)
                const retryDelayMatch = errorMsg.match(/retryDelay: (\d+)/);
                const retryDelay = (retryDelayMatch && retryDelayMatch[1]) ? parseInt(retryDelayMatch[1], 10) : 10;
                const retryDelayMs = (retryDelay + 1) * 1000;
                
                this._log(`偵測到模型暫時性過載，${retryDelay} 秒後重試...`);
                this.setOrbState('retrying'); // 顯示黃色狀態 (階段 3 會優化 UI)
                
                setTimeout(() => {
                    // 檢查狀態，如果使用者已導航離開，則不重試
                    if (this.state.isProcessing && this.state.abortController) { 
                         this.processNextBatch();
                    }
                }, retryDelayMs); // 使用 API 建議的延遲 + 1s 緩衝

            } else if (errorMsg.includes('PERMANENT_FAILURE')) {
                // 情境二：永久性金鑰錯誤
                this.state.isProcessing = false; // 2. 永久失敗出口
                this.handleTranslationError("所有 API Key 均失效或帳單錯誤，翻譯已停止。");
            
            } else if (errorMsg.includes('BATCH_FAILURE')) {
                // 情境三：模型無法處理此批次
                // (流程仍在繼續，*不*設定 isProcessing = false)
                this._log("此批次翻譯失敗，標記為可重試。");
                indicesToUpdate.forEach(index => {
                    if (this.state.translatedTrack[index]) {
                        // 標記為臨時失敗，但不儲存 translatedText: null
                        this.state.translatedTrack[index].tempFailed = true; 
                    }
                });
                // 關鍵：繼續執行下一批次，以推進進度條
                await this.processNextBatch(); 

            } else {
                // 兜底：處理其他永久性錯誤 (例如 "未設定金鑰" 或舊的錯誤)
                this.state.isProcessing = false; // 3. 兜底失敗出口
                this.handleTranslationError(e.message);
            }
        }
    }

    handleCriticalFailure(source, message, data = {}) {
        // 功能: 統一的嚴重錯誤處理中心。
        this._log(`❌ [嚴重錯誤 | 來源: ${source}] ${message}`, data);
        this.setPersistentError(`[${source}] ${message}`);
    }

    async sendBatchForTranslation(texts, signal) {
        // 功能: 將批次文字發送到 background.js，並拋出結構化的錯誤。
        // input: texts (字串陣列), signal (AbortSignal)
        // output: (Promise) 翻譯後的字串陣列
        try {
            const response = await this.sendMessageToBackground({
                action: 'translateBatch', //
                texts: texts,
                source_lang: this.state.sourceLang,
                models_preference: this.settings.models_preference
            });

            if (signal.aborted) {
                throw new Error('AbortError'); // 模擬 AbortError
            }

            // 組合並拋出結構化錯誤
            if (response?.error) {
                // 如果 background.js 處理失敗 (例如 TEMPORARY_FAILURE)
                // 將包含 retryDelay 的完整錯誤訊息拋出
                let structuredError = response.error;
                if (response.retryDelay) {
                    structuredError += ` (retryDelay: ${response.retryDelay})`;
                }
                throw new Error(structuredError); // 拋出 "TEMPORARY_FAILURE (retryDelay: 22)"
            }

            if (response?.data && Array.isArray(response.data)) {
                return response.data;
            }

            // 未知的成功回應格式
            throw new Error('來自背景服務的回應格式不正確。');
            
        } catch (e) {
            // 捕獲 sendMessage 本身的錯誤 或 background.js 回傳的錯誤
            if (e.message.includes("Receiving end does not exist")) {
                 throw new Error('無法連線至擴充功能背景服務。');
            }
            throw e; // 將錯誤 (例如 "TEMPORARY_FAILURE (retryDelay: 22)") 拋給 processNextBatch
        }
    }

    handleTranslationError(errorMessage) {
        // 功能: 處理翻譯過程中的錯誤。
        // 將 logThisError 設為 false，因為 background.js (日誌 1) 已經記錄了這個錯誤的根本原因。
        this.setPersistentError(errorMessage, false);
    }

    setPersistentError(message, logThisError = true) {
        // 功能: 顯示一個永久性的錯誤圖示，並將錯誤記錄到 background。
        this.state.persistentError = message;

        // 增加 logThisError 參數，避免 background.js 和 content.js 重複記錄日誌 (日誌 2)
        if (logThisError) {
            this.sendMessageToBackground({
                action: 'STORE_ERROR_LOG',
                payload: { message, timestamp: Date.now() }
            }).catch(e => this._log('❌ 無法儲存錯誤日誌:', e));
        }
        
        if (!this.state.statusOrb || !document.body.contains(this.state.statusOrb)) {
            const playerContainer = document.getElementById('movie_player');
            if (playerContainer) this.createStatusOrb(playerContainer);
        }
        this.setOrbState('error', message);
    }

    beginDisplay() {
        // 功能: 開始字幕的顯示流程。
        if (!this.state.videoElement || !this.state.translatedTrack) return;
        this.state.videoElement.removeEventListener('timeupdate', this.handleTimeUpdate);
        this.state.videoElement.addEventListener('timeupdate', this.handleTimeUpdate);
        this.handleTimeUpdate();
    }

    handleTimeUpdate() {
        // 功能: 根據影片當前播放時間，更新字幕畫面。
        // input: 無 (從 this.state 讀取)
        // output: 呼叫 updateSubtitleDisplay
        const { videoElement, translatedTrack, subtitleContainer } = this.state;
        if (!videoElement || !translatedTrack || !subtitleContainer) return;
        
        this.updateSubtitleDisplay();
    }

    updateSubtitleDisplay() {
        // 功能: 將原文/譯文/批次失敗UI 渲染到自訂的字幕容器中。
        // input: 無 (自行從 this.state 獲取)
        // output: (DOM 操作)
        if (!this.state.subtitleContainer || !this.state.videoElement || !this.state.translatedTrack) return;

        const currentTime = this.state.videoElement.currentTime * 1000;
        const currentSub = this.state.translatedTrack.find(sub => currentTime >= sub.start && currentTime < sub.end);

        // 情境三 (批次失敗) UI 邏輯
        if (currentSub && currentSub.tempFailed) {
            // 1. 渲染批次失敗 UI
            const html = `<div class="enhancer-line enhancer-error-line" data-start-ms="${currentSub.start}">此批次翻譯失敗，<a class="retry-link" role="button" tabindex="0">點擊重試</a></div>`;
            if (this.state.subtitleContainer.innerHTML !== html) {
                this.state.subtitleContainer.innerHTML = html;
            }
            this.addRetryClickListener(); // 確保監聽器已綁定
            return; // 結束此函式
        }
        
        const originalText = currentSub?.text;
        const translatedText = currentSub?.translatedText;
        
        // Tier 1/3 原文模式邏輯
        if (this.state.isNativeView) {
            let html = '';
            if (originalText) {
                // 在原文模式下，使用 "translated-line" 的樣式 (較大、較粗) 來顯示原文
                html += `<div class="enhancer-line enhancer-translated-line">${originalText}</div>`;
            }
            if (this.state.subtitleContainer.innerHTML !== html) {
                this.state.subtitleContainer.innerHTML = html;
            }
            return; // 結束此函式
        }

        // 2. 渲染正常翻譯 UI (Tier 2 邏輯)
        const { showOriginal, showTranslated } = this.settings;
        let html = '';
        if (showOriginal && originalText) html += `<div class="enhancer-line enhancer-original-line">${originalText}</div>`;
        if (showTranslated) {
            const displayText = translatedText || '...';
            const placeholderClass = translatedText ? '' : 'enhancer-placeholder';
            html += `<div class="enhancer-line enhancer-translated-line ${placeholderClass}">${displayText}</div>`;
        }
        
        if (this.state.subtitleContainer.innerHTML !== html) {
            this.state.subtitleContainer.innerHTML = html;
        }
    }

    addRetryClickListener() {
        // 功能: 為字幕容器綁定「點擊重試」的事件監聽器。
        // input: 無
        // output: (DOM 事件綁定)
        // 其他補充: 使用 hasRetryListener 旗標確保只綁定一次。
        if (this.state.hasRetryListener || !this.state.subtitleContainer) return;
        
        // 綁定 'handleRetryBatchClick'，並確保 this 上下文正確
        this.handleRetryBatchClick = this.handleRetryBatchClick.bind(this);
        
        this.state.subtitleContainer.addEventListener('click', this.handleRetryBatchClick);
        this.state.hasRetryListener = true;
        this._log('[重試] 批次重試監聽器已綁定。');
    }

    async handleRetryBatchClick(e) {
        // 功能: 處理「點擊重試」事件，執行插隊翻譯。
        // input: e (ClickEvent)
        // output: (API 呼叫)
        // 其他補充: 找出所有 tempFailed 的句子並發送一次性翻譯請求。
        if (!e.target.classList.contains('retry-link')) return;

        e.preventDefault();
        e.stopPropagation();

        const line = e.target.closest('.enhancer-error-line');
        if (!line) return;

        this._log(`[插隊重試] 收到點擊，重試所有 'tempFailed' 批次...`);

        // 1. 找出所有標記為 tempFailed 的句子
        const segmentsToRetry = [];
        const indicesToUpdate = [];
        this.state.translatedTrack.forEach((sub, i) => {
            if (sub.tempFailed) {
                segmentsToRetry.push(sub.text);
                indicesToUpdate.push(i);
            }
        });

        if (segmentsToRetry.length === 0) {
            this._log('[插隊重試] 未找到標記為失敗的句子。');
            return;
        }

        e.target.textContent = '翻譯中...';
        e.target.style.pointerEvents = 'none'; // 防止重複點擊

        // 2. 執行一次性的翻譯請求
        try {
            const translatedTexts = await this.sendBatchForTranslation(
                segmentsToRetry, 
                new AbortController().signal // 使用一個新 signal
            );

            if (translatedTexts.length !== segmentsToRetry.length) {
                throw new Error("翻譯回傳的句數與請求不符。");
            }

            // 3. 更新數據
            translatedTexts.forEach((text, i) => {
                const trackIndex = indicesToUpdate[i];
                if (this.state.translatedTrack[trackIndex]) {
                    this.state.translatedTrack[trackIndex].translatedText = text;
                    this.state.translatedTrack[trackIndex].tempFailed = false; // 清除旗標
                }
            });

            // 4. 儲存快取並立即刷新 UI
            await this.setCache(`yt-enhancer-cache-${this.currentVideoId}`, {
                translatedTrack: this.state.translatedTrack,
                rawPayload: this.state.rawPayload,
                vssId: this.state.currentVssId || '' // 從 state 讀取
            });
            this.handleTimeUpdate(); // 立即刷新當前字幕
            this._log('[插隊重試] 成功，快取已更新。');

        } catch (error) {
            this._log('❌ [插隊重試] 失敗:', error);
            if (e.target) {
                e.target.textContent = '重試失敗!';
                e.target.style.pointerEvents = 'auto';
            }
            // 讓使用者可以再次嘗試
        }
    }
    createStatusOrb(container) {
        // 功能: 建立右上角的狀態圓環 UI 元件。
        if (document.getElementById('enhancer-status-orb')) return;
        this.state.statusOrb = document.createElement('div');
        this.state.statusOrb.id = 'enhancer-status-orb';
        container.appendChild(this.state.statusOrb);
    }

    removeGuidancePrompt() {
        // 功能: 移除手動模式下的引導提示框。
        document.getElementById('enhancer-prompt-guide')?.remove();
    }

    getFriendlyLangName(langCode) {
        // 功能: 將語言代碼轉換為友善的顯示名稱。
        const langMap = { ja: '日文', ko: '韓文', en: '英文' };
        return langMap[langCode] || langCode;
    }

    setOrbState(state, errorMsg = '') {
        // 功能: 控制右上角狀態圓環的顯示狀態。
        // input: state (字串), errorMsg (可選字串)
        // output: (DOM 操作)
        const orb = this.state.statusOrb;
        if (!orb) return;
        orb.className = 'enhancer-status-orb';
        orb.classList.add(`state-${state}`);
        const { translationProgress: progress, sourceLang } = this.state;
        const langName = this.getFriendlyLangName(sourceLang);
        switch (state) {
            case 'translating':
                if (progress && progress.total > 0) {
                    const percent = Math.round((progress.done / progress.total) * 100);
                    orb.innerHTML = `<div>${percent}%</div>`;
                    orb.title = `翻譯中: [${langName}] ${progress.done}/${progress.total}`;
                } else {
                    orb.innerHTML = '<div>%</div>';
                    orb.title = `匹配語言: [${langName}] - 等待字幕文字...`;
                }
                break;
            case 'success':
                orb.innerHTML = '<div>✓</div>';
                orb.title = '翻譯成功';
                setTimeout(() => orb?.classList.add('fade-out'), 1500);
                break;
            
            case 'retrying':
                if (progress && progress.total > 0) {
                    const percent = Math.round((progress.done / progress.total) * 100);
                    orb.innerHTML = `<div>${percent}%</div>`; // 顯示進度 %
                    orb.title = `模型暫時過載，自動重試中... (${progress.done}/${progress.total})`;
                } else {
                    orb.innerHTML = '<div>%</div>'; // Fallback
                    orb.title = '模型暫時過載，自動重試中...';
                }
                break;
                
            case 'error':
                orb.innerHTML = '<div>!</div>';
                orb.title = `發生錯誤: ${errorMsg}`;
                break;
        }
    }

    createSubtitleContainer(container) {
        // 功能: 建立用於顯示雙語字幕的 UI 容器。
        if (document.getElementById('enhancer-subtitle-container')) return;
        this.state.subtitleContainer = document.createElement('div');
        this.state.subtitleContainer.id = 'enhancer-subtitle-container';
        container.appendChild(this.state.subtitleContainer);
    }

    applySettingsToUI() {
        // 功能: 將使用者的外觀設定應用到字幕容器上。
        if (this.state.subtitleContainer) {
            this.state.subtitleContainer.style.fontSize = `${this.settings.fontSize}px`;
            this.state.subtitleContainer.style.fontFamily = this.settings.fontFamily;
        }
    }

    toggleNativeSubtitles(hide) {
        // 功能: 透過為播放器容器增刪 class 來控制原生字幕的顯隱。
        const playerContainer = document.getElementById('movie_player');
        if (playerContainer) {
            playerContainer.classList.toggle('yt-enhancer-active', hide);
        }
    }

    async sendMessageToBackground(message) {
        // 功能: 向 background.js 發送訊息的標準化輔助函式。
        try {
            return await chrome.runtime.sendMessage(message);
        } catch (e) {
            if (e.message && !e.message.includes("Receiving end does not exist")) {
                this._log('❌ 與背景服務通訊失敗:', e);
            }
            return null;
        }
    }
}

// 確保在 DOM 載入後才執行
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
        new YouTubeSubtitleEnhancer().initialSetup();
    });
} else {
    new YouTubeSubtitleEnhancer().initialSetup();
}