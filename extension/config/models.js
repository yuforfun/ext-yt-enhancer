// 功能: Gemini 模型清單單一來源 (Single Source of Truth)。
// input: 無 (純資料)
// output: 掛載到 globalThis.YT_ENHANCER_MODELS，供 popup.js / lab.js / background.js 讀取
// 備註:
//   - 修改此檔會同時影響 popup、options、lab、background 四處。
//   - tier 欄位為稽核腳本判斷免費/付費用；UI 顯示仍以 tip 為主。
//   - 陣列順序即為 options.html「可添加模型」的預設排列順序。
//   - background.js 透過 esbuild --inject 自動注入此檔，無需手動 import。
(function () {
    'use strict';

    // 順序 = 稽核實測耗時由快至慢 (Flash-Lite 家族最快 → Flash 家族 → Pro 家族)。
    // 供輪替消耗每把 key 的免費 quota; 用完前一個換下一個, 全部用完換 key。
    // Tier 依 2026-09-05 稽核結果; Google 若調整需以下次稽核為準。
    const MODELS = [
        { id: 'gemini-2.5-flash-lite',         name: '2.5 Flash-Lite',         tier: 'free', tip: '免費，速度最快' },
        { id: 'gemini-3.1-flash-lite',         name: '3.1 Flash-Lite',         tier: 'free', tip: '免費，輕量快速' },
        { id: 'gemini-3.1-flash-lite-preview', name: '3.1 Flash-Lite Preview', tier: 'free', tip: '免費，輕量預覽' },
        { id: 'gemini-3.5-flash-lite',         name: '3.5 Flash-Lite',         tier: 'free', tip: '免費，輕量最新' },
        { id: 'gemini-3-flash-preview',        name: '3.0 Flash',              tier: 'free', tip: '免費，中速' },
        { id: 'gemini-3.7-flash',              name: '3.7 Flash',              tier: 'free', tip: '免費，中速' },
        { id: 'gemini-3.8-flash',              name: '3.8 Flash',              tier: 'free', tip: '免費，中速' },
        { id: 'gemini-3.6-flash',              name: '3.6 Flash',              tier: 'free', tip: '免費，中速' },
        { id: 'gemini-2.5-flash',              name: '2.5 Flash',              tier: 'free', tip: '免費，速度較慢' },
        { id: 'gemini-3.5-flash',              name: '3.5 Flash',              tier: 'free', tip: '免費，速度較慢' },
        { id: 'gemini-3.1-pro-preview',        name: '3.1 Pro',                tier: 'paid', tip: '需付費，高品質' },
        { id: 'gemini-2.5-pro',                name: '2.5 Pro',                tier: 'paid', tip: '需付費，高品質' }
    ];

    // 建立 { id: {name, tip, tier} } 形式，相容原 popup.js 的 ALL_MODELS 用法
    const MODELS_DICT = MODELS.reduce((acc, m) => {
        acc[m.id] = { name: m.name, tip: m.tip, tier: m.tier };
        return acc;
    }, {});

    // 預設偏好清單：所有 free tier 模型 (供 background.js defaultSettings 使用)
    const DEFAULT_MODELS_PREFERENCE = MODELS
        .filter(m => m.tier === 'free')
        .map(m => m.id);

    const api = {
        MODELS,                     // Array 形式
        MODELS_DICT,                // Dict 形式 (相容 popup.js 舊介面)
        DEFAULT_MODELS_PREFERENCE   // 預設偏好陣列
    };

    // 雙掛載: browser (window/self) + service worker (globalThis)
    if (typeof globalThis !== 'undefined') {
        globalThis.YT_ENHANCER_MODELS = api;
    }
})();
