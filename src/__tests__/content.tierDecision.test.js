'use strict';

// ============================================================
// Batch G — 三層決策邏輯重構 單元測試
// 測試涵蓋：
//   1. checkLangEquivalency — 語言等價性
//   2. start() 語言選擇    — Tier 1 > Tier 2 > Tier 3 優先序
//   3. _runTierDecision    — 三層 Tier 判定
// ============================================================

// --- 複製自 content.js：checkLangEquivalency ---
function checkLangEquivalency(videoLang, settingLang) {
    if (videoLang === settingLang) return true;
    const traditionalGroup = ['zh-Hant', 'zh-TW', 'zh-HK'];
    if (traditionalGroup.includes(videoLang) && traditionalGroup.includes(settingLang)) return true;
    const simplifiedGroup = ['zh-Hans', 'zh-CN', 'zh'];
    if (simplifiedGroup.includes(videoLang) && simplifiedGroup.includes(settingLang)) return true;
    return false;
}

// --- 提取自 start() 的語言選擇邏輯 ---
function selectTargetLang(availableTracks, nativeLangs, autoTranslateList) {
    let targetLang = null;

    for (const nl of nativeLangs) {
        const match = availableTracks.find(t => checkLangEquivalency(t.languageCode, nl));
        if (match) { targetLang = match.languageCode; break; }
    }

    if (!targetLang) {
        for (const item of autoTranslateList) {
            const match = availableTracks.find(t => checkLangEquivalency(t.languageCode, item.langCode));
            if (match) { targetLang = match.languageCode; break; }
        }
    }

    if (!targetLang) {
        const nonAutoTrack = availableTracks.find(t => !t.vssId.startsWith('a.'));
        targetLang = (nonAutoTrack || availableTracks[0])?.languageCode || null;
    }

    return targetLang;
}

// --- 提取自 _runTierDecision 的 Tier 判定邏輯 ---
function determineTier(lang, nativeLangs, autoTranslateList) {
    if (nativeLangs.some(sl => checkLangEquivalency(lang, sl))) return 1;
    if (autoTranslateList.find(item => checkLangEquivalency(lang, item.langCode))) return 2;
    return 3;
}

// ============================================================
// 1. checkLangEquivalency
// ============================================================
describe('checkLangEquivalency', () => {
    test('完全相同的語言碼互相等價', () => {
        expect(checkLangEquivalency('ja', 'ja')).toBe(true);
        expect(checkLangEquivalency('ko', 'ko')).toBe(true);
        expect(checkLangEquivalency('en', 'en')).toBe(true);
    });

    test('繁體中文群組：zh-TW / zh-Hant / zh-HK 互相等價', () => {
        expect(checkLangEquivalency('zh-TW', 'zh-Hant')).toBe(true);
        expect(checkLangEquivalency('zh-Hant', 'zh-TW')).toBe(true);
        expect(checkLangEquivalency('zh-HK', 'zh-TW')).toBe(true);
        expect(checkLangEquivalency('zh-HK', 'zh-Hant')).toBe(true);
    });

    test('簡體中文群組：zh-CN / zh-Hans / zh 互相等價', () => {
        expect(checkLangEquivalency('zh-CN', 'zh-Hans')).toBe(true);
        expect(checkLangEquivalency('zh', 'zh-CN')).toBe(true);
        expect(checkLangEquivalency('zh-Hans', 'zh')).toBe(true);
    });

    test('繁體與簡體不等價', () => {
        expect(checkLangEquivalency('zh-TW', 'zh-CN')).toBe(false);
        expect(checkLangEquivalency('zh-Hant', 'zh-Hans')).toBe(false);
        expect(checkLangEquivalency('zh-HK', 'zh')).toBe(false);
    });

    test('不同語言不等價', () => {
        expect(checkLangEquivalency('ja', 'ko')).toBe(false);
        expect(checkLangEquivalency('en', 'ja')).toBe(false);
        expect(checkLangEquivalency('zh-TW', 'ja')).toBe(false);
    });
});

// ============================================================
// 2. start() 語言選擇 — Tier 1 > Tier 2 > Tier 3
// ============================================================
describe('start() 語言選擇優先順序', () => {
    const nativeLangs = ['zh-Hant'];
    const autoList = [{ langCode: 'ja' }, { langCode: 'ko' }];

    test('只有 Tier 1 語言可用 → 選 Tier 1', () => {
        const tracks = [{ languageCode: 'zh-TW', vssId: '.zh-TW' }];
        expect(selectTargetLang(tracks, nativeLangs, autoList)).toBe('zh-TW');
    });

    test('只有 Tier 2 語言可用 → 選 Tier 2', () => {
        const tracks = [{ languageCode: 'ja', vssId: '.ja' }];
        expect(selectTargetLang(tracks, nativeLangs, autoList)).toBe('ja');
    });

    test('Tier 1 與 Tier 2 同時可用 → Tier 1 優先', () => {
        const tracks = [
            { languageCode: 'ja', vssId: '.ja' },
            { languageCode: 'zh-TW', vssId: '.zh-TW' },
        ];
        expect(selectTargetLang(tracks, nativeLangs, autoList)).toBe('zh-TW');
    });

    test('語言等價性：設定 zh-Hant 能匹配影片的 zh-TW', () => {
        const tracks = [{ languageCode: 'zh-TW', vssId: '.zh-TW' }];
        expect(selectTargetLang(tracks, ['zh-Hant'], autoList)).toBe('zh-TW');
    });

    test('Tier 2 尊重使用者排序（ja 排在 ko 前）', () => {
        const tracks = [
            { languageCode: 'ko', vssId: '.ko' },
            { languageCode: 'ja', vssId: '.ja' },
        ];
        expect(selectTargetLang(tracks, nativeLangs, autoList)).toBe('ja');
    });

    test('無 Tier 1/2 匹配 → fallback 選非 auto 軌道 (Tier 3)', () => {
        const tracks = [
            { languageCode: 'en', vssId: 'a.en' },
            { languageCode: 'fr', vssId: '.fr' },
        ];
        expect(selectTargetLang(tracks, nativeLangs, autoList)).toBe('fr');
    });

    test('全部為 auto 軌道時 → fallback 選第一個', () => {
        const tracks = [
            { languageCode: 'en', vssId: 'a.en' },
            { languageCode: 'fr', vssId: 'a.fr' },
        ];
        expect(selectTargetLang(tracks, nativeLangs, autoList)).toBe('en');
    });

    test('無任何可用軌道時 → 回傳 null', () => {
        expect(selectTargetLang([], nativeLangs, autoList)).toBeNull();
    });

    test('Tier 1 設定為空時，不誤判 Tier 2 語言為 Tier 1', () => {
        const tracks = [{ languageCode: 'ja', vssId: '.ja' }];
        expect(selectTargetLang(tracks, [], autoList)).toBe('ja');
    });
});

// ============================================================
// 3. _runTierDecision Tier 判定
// ============================================================
describe('_runTierDecision Tier 判定 (determineTier)', () => {
    const nativeLangs = ['zh-Hant', 'zh-CN'];
    const autoList = [{ langCode: 'ja' }, { langCode: 'ko' }];

    test('lang 在 native_langs → Tier 1', () => {
        expect(determineTier('zh-TW', nativeLangs, autoList)).toBe(1);  // zh-TW ≡ zh-Hant
        expect(determineTier('zh-HK', nativeLangs, autoList)).toBe(1);  // zh-HK ≡ zh-Hant
        expect(determineTier('zh', nativeLangs, autoList)).toBe(1);     // zh ≡ zh-CN
    });

    test('lang 在 auto_translate_priority_list → Tier 2', () => {
        expect(determineTier('ja', nativeLangs, autoList)).toBe(2);
        expect(determineTier('ko', nativeLangs, autoList)).toBe(2);
    });

    test('lang 兩者皆無 → Tier 3', () => {
        expect(determineTier('en', nativeLangs, autoList)).toBe(3);
        expect(determineTier('fr', nativeLangs, autoList)).toBe(3);
        expect(determineTier('th', nativeLangs, autoList)).toBe(3);
    });

    test('Tier 1 比 Tier 2 優先：lang 同時在兩個清單時，判為 Tier 1', () => {
        const overlappingAutoList = [{ langCode: 'zh-TW' }, { langCode: 'ja' }];
        expect(determineTier('zh-TW', ['zh-Hant'], overlappingAutoList)).toBe(1);
    });

    test('手動 CC 切換場景：原 Tier 1 語言切換到 ja → 應為 Tier 2', () => {
        expect(determineTier('ja', nativeLangs, autoList)).toBe(2);
    });

    test('手動 CC 切換場景：切換到未設定語言 en → 應為 Tier 3', () => {
        expect(determineTier('en', nativeLangs, autoList)).toBe(3);
    });

    test('設定為空時，所有語言都落入 Tier 3', () => {
        expect(determineTier('ja', [], [])).toBe(3);
        expect(determineTier('zh-TW', [], [])).toBe(3);
    });
});
