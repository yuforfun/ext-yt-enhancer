// 請用以下完整內容，替換您現有的整個 injector.js 檔案。
/**
 * @file injector.js
 * @author [yuforfun]
 * @copyright 2026 [yuforfun]
 * @license MIT
 */
(function() {
    'use strict';
    if (window.ytEnhancerInjector) return;

    // 偵錯模式開關和計時器
    const DEBUG_MODE = false;
    const scriptStartTime = performance.now();

    // 建立一個詳細的日誌記錄器
    const debugLog = (message, ...args) => {
        if (DEBUG_MODE) {
            const timestamp = (performance.now() - scriptStartTime).toFixed(2).padStart(7, ' ');
            console.log(`%c[特工@${timestamp}ms]`, 'color: #e11d48; font-weight: bold;', message, ...args);
        }
    };

    class YtEnhancerInjector {
        constructor() {
            // 功能: 初始化 class 實例。
            // input: 無
            // output: YtEnhancerInjector 物件實例。
            // 其他補充: 移除舊的 this.log 和 this.error，完全改用新的 debugLog。
            this.state = {
                player: null,
                lastProcessedVideoId: null,
                isPolling: false,
                isDataSent: false,
                playerResponse: null,
                isDataReady: false,
                isContentScriptReady: false
            };
            // 綁定 this 上下文
            Object.getOwnPropertyNames(Object.getPrototypeOf(this)).forEach(prop => {
                if (typeof this[prop] === 'function' && prop !== 'constructor') {
                    this[prop] = this[prop].bind(this);
                }
            });
        }

        init() {
            // 功能: 腳本總入口。
            // output: 無
            // 其他補充: 整合新的日誌系統
            debugLog('(偵錯模式) 已啟動，採用「播放器優先 + 雙攔截器」架構。');
            document.addEventListener('yt-navigate-finish', this.onNavigate);
            this.setupInterceptors();
            window.addEventListener('message', this.handleContentMessage);
            this.onNavigate(); // 首次載入時手動觸發一次
        }


        onNavigate(event) {
        // 功能: 導航事件的統一處理入口，增加狀態重置與主動通知機制。
        // input: event (可選)
        // output: 條件滿足時呼叫 this.main() 並發送通知信號。
        // 其他補充: 這是解決軟導航狀態殘留問題的核心第一步。
            debugLog(`--- 導航事件 (yt-navigate-finish) 觸發 ---`, event?.detail);

            setTimeout(() => {
                debugLog('重置內部狀態: isDataReady=false, isContentScriptReady=false, playerResponse=null');
                this.state.playerResponse = null;
                this.state.isDataReady = false;
                this.state.isContentScriptReady = false;

                if (this.state.isPolling) {
                    debugLog('偵測到輪詢已在進行中，本次導航事件忽略。');
                    return;
                }
                const videoId = new URLSearchParams(window.location.search).get('v');
                if (videoId && this.state.lastProcessedVideoId === videoId) {
                    debugLog(`影片 ID [${videoId}] 與上次相同，忽略。`);
                    return;
                }

                if (videoId) {
                    // 在確認是新影片時，立刻發送信號通知指揮中心
                    debugLog(`📢 [導航通知] 偵測到新影片，正在通知指揮中心...`);
                    this.sendMessageToContent('YT_NAVIGATED', { videoId });

                    debugLog(`導航至新影片 [${videoId}]，啟動主流程...`);
                    this.main(videoId);
                } else if (this.state.lastProcessedVideoId) {
                    debugLog('導航至非影片頁面，重置 ID 記錄。');
                    this.state.lastProcessedVideoId = null;
                }
            }, 100);
        }

        main(videoId, retryCount = 0) {
            // 功能: (偵錯版) 核心啟動函式，獲取資料後儲存並等待請求，包含詳細日誌。
            // input: videoId (字串), retryCount (內部遞迴計數)。
            // output: 更新內部狀態，並在條件滿足時發送資料。
            this.state.isPolling = true;
            const MAX_RETRIES = 50;
            const RETRY_INTERVAL = 100;

            // 輪詢嘗試日誌
            if (retryCount === 0) {
                debugLog(`[main] 開始輪詢播放器元件...`);
            }

            try {
                const player = this.getPlayerInstance();
                if (player && typeof player.getPlayerResponse === 'function') {
                    const playerResponse = player.getPlayerResponse();
                    if (playerResponse && playerResponse.videoDetails && playerResponse.captions) {
                        debugLog(`✅ [main] 成功獲取播放器資料 (嘗試 ${retryCount + 1} 次)，資料已儲存。`);

                        this.state.player = player;
                        this.state.lastProcessedVideoId = videoId;
                        this.state.isDataSent = false;

                        this.state.playerResponse = playerResponse;
                        this.state.isDataReady = true; // 標記資料就緒
                        debugLog(`[main] 狀態更新: isDataReady -> true`);

                        this.state.isPolling = false;

                        if (this.state.isContentScriptReady) {
                            debugLog('[main] 指揮中心已就緒，立即發送已儲存的資料。');
                            this.sendPlayerResponse();
                        }
                        return;
                    }
                }

                if (retryCount < MAX_RETRIES) {
                    setTimeout(() => this.main(videoId, retryCount + 1), RETRY_INTERVAL);
                } else {
                    debugLog(`❌ [main] 輪詢超時 (5秒)，仍無法獲取有效的播放器資料。`);
                    this.state.isPolling = false;
                }
            } catch (e) {
                debugLog('❌ [main] 函式中發生嚴重錯誤:', e);
                this.state.isPolling = false;
            }
        }

        setupInterceptors() {
            // 功能: 設置 Fetch 和 XHR 攔截器以捕獲字幕請求。
            // input: 無
            // output: 無
            const self = this;
            const originalFetch = window.fetch;
            window.fetch = function(...args) {
                const url = args[0] instanceof Request ? args[0].url : String(args[0]);
                if (url.includes('/api/timedtext')) {
                    debugLog('[攔截器] 透過 Fetch 攔截到 timedtext 請求。');
                    return self.handleTimedTextRequest(originalFetch.apply(this, args));
                }
                return originalFetch.apply(this, args);
            };
            
            const originalXHROpen = window.XMLHttpRequest.prototype.open;
            window.XMLHttpRequest.prototype.open = function(method, url) {
                if (typeof url === 'string' && url.includes('/api/timedtext')) {
                    this._isTimedTextRequest = true;
                    this._timedTextUrl = url;
                }
                originalXHROpen.apply(this, arguments);
            };

            const originalXHRSend = window.XMLHttpRequest.prototype.send;
            window.XMLHttpRequest.prototype.send = function() {
                if (this._isTimedTextRequest) {
                    debugLog('[攔截器] 透過 XHR 攔截到 timedtext 請求...');
                    this.addEventListener('load', function() {
                        if (this.status === 200) {
                            const responsePromise = Promise.resolve(new Response(this.responseText));
                            self.handleTimedTextRequest(responsePromise, this._timedTextUrl);
                        }
                    });
                }
                originalXHRSend.apply(this, arguments);
            };
            debugLog('[系統] Fetch 和 XHR 雙攔截器已啟動。');
        }

        handleTimedTextRequest(responsePromise, requestUrl = null) {
            // 功能: (vssId 最終修正版) 統一處理 timedtext 回應，確保 vssId 永不為 null。
            // input: responsePromise (Promise), requestUrl (可選的字串)。
            // output: 發送包含 vssId 的 TIMEDTEXT_DATA 訊息給 content.js。
            // 其他補充: 這是確保系統穩健性的關鍵函式，能夠過濾掉 YouTube 發出的無效或空的 timedtext 請求。
            responsePromise.then(response => {
                if (!response.ok) return;

                const urlString = requestUrl || response.url;
                if (!urlString) {
                    debugLog('❌ [攔截器] 無法獲取 timedtext 的請求 URL。');
                    return;
                }

                const url = new URL(urlString);
                const lang = url.searchParams.get('lang') || 'unknown';
                const vssId = url.searchParams.get('vssId') || '';

                const clonedResponse = response.clone();

                clonedResponse.json()
                    .then(data => {
                        // 確保 data 和 events 存在，避免後續錯誤
                        if (!data || !data.events) {
                            debugLog(`🟡 [攔截器] 偵測到 timedtext 回應內容有效但缺少 events 欄位，已忽略。語言: [${lang}]`);
                            return;
                        }
                        debugLog(`✅ [攔截器] 成功捕獲並解析語言 [${lang}] (vssId: ${vssId || 'N/A'}) 的字幕，準備發送至指揮中心。`);
                        this.sendMessageToContent('TIMEDTEXT_DATA', { payload: data, lang, vssId });
                    })
                    .catch(err => {
                        // 這個 catch 區塊至關重要。它能處理 YouTube 返回空回應或無效 JSON 的情況。
                        // 我們不把這個視為致命錯誤，而是將其記錄為一個被「過濾掉」的事件，
                        // 讓系統繼續等待由我們的 setOption() 指令觸發的下一個、可能有效的 timedtext 請求。
                        if (err instanceof SyntaxError) {
                            debugLog(`🟡 [攔截器] 偵測到無效/空的 timedtext JSON 回應並已忽略。語言: [${lang}]`, err.message);
                        } else {
                            debugLog(`❌ [攔截器] 處理 timedtext 時發生非預期錯誤:`, err);
                        }
                    });
            });
            // 保持返回原始 promise 以維持 promise chain
            return responsePromise;
        }

        handleContentMessage(event) {
            // 功能: (保險機制版) 監聽並處理來自 content.js 的指令，為 FORCE_ENABLE_TRACK 增加重試機制以應對時序問題。
            // input: event (MessageEvent)。
            // output: 根據指令執行對應操作。
            // 其他補充: 這是為了解決 player.setOption() 指令偶爾因時機過早而被播放器靜默忽略的問題。
            if (event.source !== window || !event.data || event.data.from !== 'YtEnhancerContent') return;
            const { type, payload } = event.data;
            switch (type) {
                case 'REQUEST_PLAYER_RESPONSE':
                    debugLog('🤝 [握手] 收到指揮中心的「請求資料」信號。');
                    this.state.isContentScriptReady = true;
                    debugLog(`[握手] 狀態更新: isContentScriptReady -> true`);

                    if (this.state.isDataReady) {
                        debugLog('🤝 [握手] 資料已就緒，立即回傳。');
                        this.sendPlayerResponse();
                    } else {
                        debugLog('🤝 [握手] 資料尚未就緒，等待 main() 流程完成...');
                    }
                    break;

                case 'FORCE_ENABLE_TRACK':
                    debugLog(`[指令] 收到「強制啟用軌道」指令，目標語言: ${payload.languageCode}`);
                    if (this.state.player && payload) {
                        this.state.isDataSent = false;

                        const command = (attempt) => {
                            // 每次執行前都重新獲取播放器實例，以防在延遲期間發生頁面導航
                            const player = this.getPlayerInstance();
                            if (player) {
                                player.setOption('captions', 'track', {
                                    languageCode: payload.languageCode
                                });
                                debugLog(`[指令] 已執行第 ${attempt} 次 player.setOption()。`);
                            } else {
                                debugLog(`[指令] 第 ${attempt} 次嘗試時，播放器實例已消失，取消執行。`);
                            }
                        };

                        // 開始: 執行指令時，增加短期重試的保險機制
                        // 第一次立即執行
                        command(1);

                        // 第二次延遲執行 (保險)
                        setTimeout(() => command(2), 250);

                        // 第三次再次延遲執行 (最終保險)
                        setTimeout(() => command(3), 500);

                    } else {
                        debugLog('❌ [指令] 無法執行，缺少播放器實例或軌道資料。');
                    }
                    break;
            }
        }

        sendPlayerResponse() {
            // 功能: 統一的 PLAYER_RESPONSE_CAPTURED 訊息發送函式，增加日誌。
            if (this.state.playerResponse) {
                debugLog('🤝 [握手] 正在發送 PLAYER_RESPONSE_CAPTURED 至指揮中心...');
                this.sendMessageToContent('PLAYER_RESPONSE_CAPTURED', this.state.playerResponse);
                this.state.playerResponse = null;
            }
        }

        getPlayerInstance() {
            // 功能: 獲取 YouTube 頁面 DOM 中的播放器元素 (#movie_player)。
            const playerElement = document.getElementById('movie_player');
            return (playerElement && typeof playerElement.getPlayerResponse === 'function') ? playerElement : null;
        }

        sendMessageToContent(type, payload = {}) {
            // 功能: 向 content.js 發送訊息。
            const message = {
                from: 'YtEnhancerInjector',
                type,
                payload
            };
            window.postMessage(message, '*');
        }
    }

    window.ytEnhancerInjector = new YtEnhancerInjector();
    window.ytEnhancerInjector.init();

})();