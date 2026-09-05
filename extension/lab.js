// 建議檔名: lab.js
// 功能: [v4.2.1] 驅動進階實驗室 (Prompt 競技場 & Model 競技場) 的所有前端邏輯。
// input: DOM 事件 (來自 lab.html)
// output: 呼叫 background.js API 並將結果渲染到 DOM
// 其他補充: 包含隱藏的開發者彩蛋、純文字轉 JSON 解析，以及多模型並發測試。

document.addEventListener('DOMContentLoaded', () => {
    
    // --- 1. DOM 元素獲取 ---
    const headerEl = document.getElementById('lab-header');
    const inputTextEl = document.getElementById('lab-input-text');
    
    const customAEl = document.getElementById('lab-custom-a');
    const universalAEl = document.getElementById('lab-universal-a');
    const customBEl = document.getElementById('lab-custom-b');
    const universalBEl = document.getElementById('lab-universal-b');
    
    const runPromptBtn = document.getElementById('lab-run-prompt-button');
    const runModelBtn = document.getElementById('lab-run-model-button');
    const copyButtonEl = document.getElementById('lab-copy-button');
    
    const promptOutputArea = document.getElementById('lab-prompt-output-area');
    const modelOutputArea = document.getElementById('lab-model-output-area');

    let lastPromptResults = null;

    if (!runPromptBtn || !customAEl || !copyButtonEl) {
        console.error("Lab UI 關鍵元素未找到。");
        promptOutputArea.innerHTML = `<p class="status-error">錯誤：lab.html 檔案結構不完整。</p>`;
        return;
    }

    // --- 2. 事件綁定: 頁籤切換 ---
    document.getElementById('tab-btn-prompt').addEventListener('click', (e) => {
        e.target.classList.add('active');
        document.getElementById('tab-btn-model').classList.remove('active');
        document.getElementById('pane-prompt').style.display = 'block';
        document.getElementById('pane-model').style.display = 'none';
    });
    
    document.getElementById('tab-btn-model').addEventListener('click', (e) => {
        e.target.classList.add('active');
        document.getElementById('tab-btn-prompt').classList.remove('active');
        document.getElementById('pane-prompt').style.display = 'none';
        document.getElementById('pane-model').style.display = 'block';
    });

    // --- 3. 事件綁定: 彩蛋 (連點 5 次解鎖開發者模式) ---
    let clickCount = 0;
    let clickTimer = null;
    headerEl.addEventListener('click', () => {
        clickCount++;
        clearTimeout(clickTimer);
        if (clickCount >= 5) {
            document.querySelectorAll('.dev-only').forEach(el => el.style.display = 'block');
            alert('🔓 開發者模式已解鎖：已顯示底層 Universal Prompt 編輯區。');
            clickCount = 0;
        } else {
            clickTimer = setTimeout(() => clickCount = 0, 800);
        }
    });

    // --- 4. 事件綁定: 快捷測試集 ---
    document.getElementById('btn-load-short').addEventListener('click', () => {
        inputTextEl.value = "こんにちは世界\nお元気ですか？\nなるほど、そういうことか！";
    });
    document.getElementById('btn-load-long').addEventListener('click', () => {
        inputTextEl.value = "この動画は志尊淳さんと町田啓太さんの主演作品です。\nグラスハートというバンドの物語を描いています。";
    });

    // --- 5. 事件綁定: 主執行按鈕 ---
    runPromptBtn.addEventListener('click', runComparison);
    runModelBtn.addEventListener('click', runModelTest);
    copyButtonEl.addEventListener('click', handleCopyResults);

    /**
     * @function loadInitialPrompts
     * 功能: 頁面載入時，獲取並填入預設 Prompts
     */
    async function loadInitialPrompts() {
        setLoadingState(promptOutputArea, '正在載入您儲存的預設 Prompts...');
        try {
            const response = await chrome.runtime.sendMessage({ action: 'getDebugPrompts' });
            if (response && response.success) {
                customAEl.value = response.savedCustomPrompt || '';
                customBEl.value = response.savedCustomPrompt || '';
                universalAEl.value = response.universalPrompt || '';
                universalBEl.value = response.universalPrompt || '';
                setInfoState(promptOutputArea, `預設 Prompts 已載入。請貼上測試句並開始測試...`);
            } else {
                throw new Error(response?.error || '無法從背景獲取 Prompts。');
            }
        } catch (e) {
            setErrorState(promptOutputArea, `載入 Prompts 失敗: ${e.message}`);
        }
    }

    /**
     * @function parseInputText
     * 功能: 將使用者輸入的純文字或 JSON 轉換為字串陣列
     */
    function parseInputText(rawText) {
        if (!rawText) throw new Error("輸入不能為空。");
        if (rawText.trim().startsWith('[')) {
            return JSON.parse(rawText.trim());
        } else {
            return rawText.split('\n').map(s => s.trim()).filter(s => s.length > 0);
        }
    }

    // ========================================================================
    // 模塊 A: Prompt 競技場 (A/B Test)
    // ========================================================================
    async function runComparison() {
        // 功能: 執行 Prompt A/B 測試
        // input: 無 (讀取 DOM 輸入)
        // output: 更新 UI 顯示對比結果
        // 其他補充: 新增動態讀取使用者首選模型的邏輯
        runPromptBtn.disabled = true; 
        
        let originalTexts;
        try {
            setInfoState(promptOutputArea, '步驟 1: 解析輸入文本...'); 
            originalTexts = parseInputText(inputTextEl.value);
            if (!Array.isArray(originalTexts) || !originalTexts.every(item => typeof item === 'string')) {
                throw new Error("解析結果必須是字串陣列。");
            }
        } catch (e) {
            setErrorState(promptOutputArea, `輸入無效: ${e.message}`, runPromptBtn, '執行 A/B 比較翻譯');
            return;
        }

        const fullPrompt_A = `${customAEl.value}\n\n${universalAEl.value}`;
        const fullPrompt_B = `${customBEl.value}\n\n${universalBEl.value}`;
        
        // 【關鍵修正點】: 動態讀取設定檔，抓取模型偏好的第 0 個作為測試標的
        let targetModel = "gemini-3.1-flash-lite"; // 預設值防呆
        try {
            const result = await chrome.storage.local.get(['ytEnhancerSettings']);
            if (result.ytEnhancerSettings && result.ytEnhancerSettings.models_preference && result.ytEnhancerSettings.models_preference.length > 0) {
                targetModel = result.ytEnhancerSettings.models_preference[0];
            }
        } catch (e) {
            console.warn('[Lab] 無法讀取模型設定，將使用預設模型。');
        }

        let translationsA = null;
        let translationsB = null;

        try {
            // 【關鍵修正點】: 在狀態列顯示當前正在使用的模型名稱
            setLoadingState(promptOutputArea, `正在使用 [${targetModel}] 翻譯 Prompt A...`); 
            const resA = await sendApiRequest(originalTexts, [targetModel], fullPrompt_A);
            if (resA.error) throw new Error(`[Prompt A] ${resA.message || resA.error}`);
            translationsA = resA.data;

            setLoadingState(promptOutputArea, `正在使用 [${targetModel}] 翻譯 Prompt B...`); 
            const resB = await sendApiRequest(originalTexts, [targetModel], fullPrompt_B);
            if (resB.error) throw new Error(`[Prompt B] ${resB.message || resB.error}`);
            translationsB = resB.data;

        } catch (e) {
            console.error('[Lab] 翻譯失敗:', e);
            setErrorState(promptOutputArea, `翻譯失敗: ${e.message}`, runPromptBtn, '執行 A/B 比較翻譯');
            return; 
        }

        lastPromptResults = { originals: originalTexts, translationsA, translationsB };
        renderPromptResults(originalTexts, translationsA, translationsB);
        copyButtonEl.style.display = 'inline-block';
        
        runPromptBtn.disabled = false;
        runPromptBtn.textContent = '重新執行比較翻譯';
    }

    function renderPromptResults(originals, translationsA, translationsB) {
        let html = `<table>
            <thead><tr><th width="30%">原文</th><th width="35%">譯文 A (基準)</th><th width="35%">譯文 B (對照)</th></tr></thead>
            <tbody>`;
        for (let i = 0; i < originals.length; i++) {
            const isDiff = translationsA[i] !== translationsB[i];
            // 【關鍵修正點】: 若譯文 A 與 B 不相同，B 背景變為淡黃色高亮
            const bgStyle = isDiff ? 'background-color: #fffacd; color: #000;' : 'color: #777;';
            html += `<tr>
                <td>${escapeHTML(originals[i])}</td>
                <td>${escapeHTML(translationsA[i])}</td>
                <td style="${bgStyle}">${escapeHTML(translationsB[i])}</td>
            </tr>`;
        }
        html += `</tbody></table>`;
        promptOutputArea.innerHTML = html;
    }

    async function handleCopyResults() {
        if (!lastPromptResults) return;
        const { originals, translationsA, translationsB } = lastPromptResults;
        let formattedText = '';
        for (let i = 0; i < originals.length; i++) {
            formattedText += `${originals[i]}\n`;
            formattedText += `譯文 A: ${translationsA[i]}\n`;
            formattedText += `譯文 B: ${translationsB[i]}\n\n`;
        }
        try {
            await navigator.clipboard.writeText(formattedText.trim());
            const originalText = copyButtonEl.textContent;
            copyButtonEl.textContent = '已複製！';
            setTimeout(() => { copyButtonEl.textContent = originalText; }, 2000);
        } catch (e) {
            alert('複製失敗，請檢查權限。');
        }
    }

    // ========================================================================
    // 模塊 B: Model 競技場 (Model Test)
    // ========================================================================
    async function runModelTest() {
        // 功能:逐一測試指定模型的連線狀態與耗時，並顯示完整的輸出或詳細的錯誤原因。
        // input: 無 (從 DOM 讀取輸入與 Prompt)
        // output: 渲染模型診斷表格到 modelOutputArea
        // 其他補充: 修復了多行輸入時只顯示第一句翻譯結果的漏洞。
        
        // 模型清單來自 config/models.js (單一來源)，按 tier 排序並在 free/paid 之間插入分隔列
        if (!globalThis.YT_ENHANCER_MODELS) {
            setErrorState(modelOutputArea, 'config/models.js 未載入，無法取得模型清單。', runModelBtn, '開始測試所有模型');
            return;
        }
        const _allModels = globalThis.YT_ENHANCER_MODELS.MODELS;
        const _freeIds = _allModels.filter(m => m.tier === 'free').map(m => m.id);
        const _paidIds = _allModels.filter(m => m.tier === 'paid').map(m => m.id);
        const MODELS_TO_TEST = [
            ..._freeIds,
            '以下需付費',
            ..._paidIds
        ];
        
        runModelBtn.disabled = true;
        let originalTexts;
        try {
            originalTexts = parseInputText(inputTextEl.value);
        } catch (e) {
            setErrorState(modelOutputArea, `輸入無效: ${e.message}`, runModelBtn, '開始測試所有模型');
            return;
        }

        const fullPrompt = `${customAEl.value}\n\n${universalAEl.value}`;
        
        let resultsData = MODELS_TO_TEST.map(m => {
            const isModel = /^gemini-/.test(m);
            return { model: m, status: isModel ? '等待中...' : '', time: isModel ? '-' : '', detail: '' };
        });
        renderModelTable(resultsData);

        for (let i = 0; i < MODELS_TO_TEST.length; i++) {
            const modelName = MODELS_TO_TEST[i];

            // 非真實 model (如 tier 分隔列 '以下需付費')：只當視覺標題，跳過 API 呼叫
            if (!/^gemini-/.test(modelName)) {
                resultsData[i].status = '';
                resultsData[i].time = '';
                resultsData[i].detail = '';
                renderModelTable(resultsData);
                continue;
            }

            resultsData[i].status = '<span style="color: blue;">測試中...</span>';
            renderModelTable(resultsData);

            const startTime = Date.now();
            try {
                const response = await sendApiRequest(originalTexts, [modelName], fullPrompt);
                const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
                resultsData[i].time = `${elapsed}s`;

                if (response.error) {
                    resultsData[i].status = '<span style="color: red;">❌ 失敗</span>';
                    // 完整串接 error, reason 與 message
                    let errorDetails = `[${response.error}]`;
                    if (response.reason) errorDetails += ` Reason: ${response.reason}`;
                    if (response.message) errorDetails += ` - ${response.message}`;
                    resultsData[i].detail = escapeHTML(errorDetails);
                } else if (response.data && response.data.length > 0) {
                    resultsData[i].status = '<span style="color: green;">✅ 成功</span>';
                    // 【關鍵修正點】: 將陣列合併為單一字串，確保多行輸入時所有句子都能顯示
                    const fullText = response.data.join('\n') || '';
                    resultsData[i].detail = escapeHTML(fullText.length > 300 ? fullText.substring(0, 300) + '... (已截斷)' : fullText); 
                } else {
                    resultsData[i].status = '<span style="color: orange;">⚠️ 異常</span>';
                    resultsData[i].detail = '格式錯誤：未收到預期的資料陣列';
                }
            } catch (e) {
                resultsData[i].time = ((Date.now() - startTime) / 1000).toFixed(2) + 's';
                resultsData[i].status = '<span style="color: red;">❌ 錯誤</span>';
                resultsData[i].detail = escapeHTML(e.message);
            }
            renderModelTable(resultsData);
        }

        runModelBtn.disabled = false;
        runModelBtn.textContent = '重新測試所有模型';
    }

    function renderModelTable(data) {
        let html = `<table>
            <thead><tr><th width="30%">模型名稱</th><th width="15%">狀態</th><th width="15%">耗時</th><th>輸出預覽/錯誤</th></tr></thead>
            <tbody>`;
        data.forEach(row => {
            html += `<tr>
                <td><strong>${row.model}</strong></td>
                <td>${row.status}</td>
                <td>${row.time}</td>
                <td style="font-size: 0.9em; color: #555;">${row.detail}</td>
            </tr>`;
        });
        html += `</tbody></table>`;
        modelOutputArea.innerHTML = html;
    }

    // ========================================================================
    // 共用輔助函式
    // ========================================================================
    function sendApiRequest(texts, models_preference, overridePrompt) {
        return chrome.runtime.sendMessage({
            action: 'translateBatch',
            texts: texts,
            source_lang: 'ja',
            models_preference: models_preference,
            overridePrompt: overridePrompt 
        });
    }

    function setLoadingState(area, message) {
        area.innerHTML = `<p class="status-loading">${escapeHTML(message)}</p>`;
    }

    function setInfoState(area, message) {
        area.innerHTML = `<p class="status-info">${escapeHTML(message)}</p>`;
    }

    function setErrorState(area, message, btnEl = null, btnText = '') {
        area.innerHTML = `<p class="status-error">${escapeHTML(message)}</p>`;
        if(btnEl) {
            btnEl.disabled = false;
            btnEl.textContent = btnText;
        }
    }
    
    function escapeHTML(str) {
        if (!str) return '';
        return String(str).replace(/&/g, '&amp;')
                  .replace(/</g, '&lt;')
                  .replace(/>/g, '&gt;')
                  .replace(/"/g, '&quot;')
                  .replace(/'/g, '&#039;');
    }
    
    // 啟動載入
    loadInitialPrompts();
});