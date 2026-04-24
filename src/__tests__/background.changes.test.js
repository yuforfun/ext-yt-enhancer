'use strict';

// ============================================================
// 測試涵蓋範圍（對應本次修改）：
//   五、LANG_MAP 動態查找優先順序
//   十、DEFAULT_CUSTOM_PROMPTS 移除個人化預設值 + EXAMPLE_CUSTOM_PROMPTS
//       + getExamplePrompt action 邏輯
// ============================================================

// --- 複製自 src/background.js，作為受測常數 ---
const LANG_MAP = { ja: '日文', ko: '韓文', en: '英文' };

const DEFAULT_CUSTOM_PROMPTS = {
    ja: `**風格指南:**
- 翻譯需符合台灣人的說話習慣，並保留說話者的情感語氣。

**人名/專有名詞對照表 (優先級最高):**
無論上下文如何，只要看到左側的原文或讀音，就必須嚴格地翻譯為右側的詞彙。
(此處新增您的對照表，格式範例：原文 -> 譯名)
`,
    ko: `**風格指南:**
- 翻譯需符合台灣人的說話習慣，並保留說話者的情感語氣。

**人名/專有名詞對照表 (優先級最高):**
無論上下文如何，只要看到左側的原文或讀音，就必須嚴格地翻譯為右側的詞彙。
`,
    en: `**風格指南:**
- 翻譯需符合台灣人的說話習慣，並保留說話者的情感語氣。

**人名/專有名詞對照表 (優先級最高):**
無論上下文如何，只要看到左側的原文或讀音，就必須嚴格地翻譯為右側的詞彙。
`,
};

const EXAMPLE_CUSTOM_PROMPTS = {
    ja: `**風格指南:**
- 翻譯需符合台灣人的說話習慣，並保留說話者(日本偶像)的情感語氣。

**人名/專有名詞對照表 (優先級最高):**
- まちだ けいた -> 町田啟太
- さとう たける -> 佐藤健
`,
};

// --- 複製自 background.js 中的 sourceLangName 優先順序邏輯 ---
function resolveLangName(tier2List, source_lang) {
    const langConfig = tier2List.find(item => item.langCode === source_lang);
    return langConfig?.name || LANG_MAP[source_lang] || source_lang || '原文';
}

// --- 複製自 getExamplePrompt action 邏輯 ---
function getExamplePromptLogic(langCode) {
    return EXAMPLE_CUSTOM_PROMPTS[langCode] || '';
}

// ============================================================
// 五、LANG_MAP 動態查找優先順序
// ============================================================
describe('sourceLangName 優先順序', () => {
    const tier2WithName = [{ langCode: 'fr', name: '法文', customPrompt: '' }];
    const tier2WithoutName = [{ langCode: 'fr', customPrompt: '' }];

    test('tier2 name 存在時，優先使用 tier2 name', () => {
        expect(resolveLangName(tier2WithName, 'fr')).toBe('法文');
    });

    test('tier2 name 不存在但 LANG_MAP 有對應時，回退至 LANG_MAP', () => {
        expect(resolveLangName([], 'ja')).toBe('日文');
        expect(resolveLangName([], 'ko')).toBe('韓文');
        expect(resolveLangName([], 'en')).toBe('英文');
    });

    test('tier2 有 langCode 但 name 欄位空值時，回退至 LANG_MAP', () => {
        const noNameList = [{ langCode: 'ja', name: '', customPrompt: '' }];
        expect(resolveLangName(noNameList, 'ja')).toBe('日文');
    });

    test('tier2 無記錄且 LANG_MAP 無對應時，使用 source_lang code', () => {
        expect(resolveLangName([], 'th')).toBe('th');
    });

    test('source_lang 為空字串時，最終回退至 "原文"', () => {
        expect(resolveLangName([], '')).toBe('原文');
    });

    test('tier2 name 優先於 LANG_MAP（即使 LANG_MAP 有值）', () => {
        const overriddenJa = [{ langCode: 'ja', name: 'Japanese', customPrompt: '' }];
        expect(resolveLangName(overriddenJa, 'ja')).toBe('Japanese');
    });
});

// ============================================================
// 十、DEFAULT_CUSTOM_PROMPTS 移除個人化預設值
// ============================================================
describe('DEFAULT_CUSTOM_PROMPTS 不含個人化藝人名稱', () => {
    const personalNames = ['町田啟太', '佐藤健', '志尊淳', '城田優', '宮崎優', 'TENBLANK', '玻璃之心', '菅田將暉'];

    test.each(['ja', 'ko', 'en'])('DEFAULT_CUSTOM_PROMPTS[%s] 不應含有硬編碼藝人名稱', (lang) => {
        const prompt = DEFAULT_CUSTOM_PROMPTS[lang];
        for (const name of personalNames) {
            expect(prompt).not.toContain(name);
        }
    });

    test('DEFAULT_CUSTOM_PROMPTS.ja 包含通用格式說明文字', () => {
        expect(DEFAULT_CUSTOM_PROMPTS.ja).toContain('格式範例');
    });

    test('DEFAULT_CUSTOM_PROMPTS 包含三個語言鍵', () => {
        expect(Object.keys(DEFAULT_CUSTOM_PROMPTS)).toEqual(expect.arrayContaining(['ja', 'ko', 'en']));
    });
});

// ============================================================
// 十、EXAMPLE_CUSTOM_PROMPTS 保留個人化範例
// ============================================================
describe('EXAMPLE_CUSTOM_PROMPTS 包含個人化範例', () => {
    test('EXAMPLE_CUSTOM_PROMPTS.ja 含有藝人名稱範例', () => {
        expect(EXAMPLE_CUSTOM_PROMPTS.ja).toContain('町田啟太');
        expect(EXAMPLE_CUSTOM_PROMPTS.ja).toContain('佐藤健');
    });

    test('EXAMPLE_CUSTOM_PROMPTS 目前只定義 ja', () => {
        expect(Object.keys(EXAMPLE_CUSTOM_PROMPTS)).toEqual(['ja']);
    });
});

// ============================================================
// 十、getExamplePrompt action 邏輯
// ============================================================
describe('getExamplePrompt 邏輯', () => {
    test('langCode = "ja" 回傳非空字串', () => {
        const result = getExamplePromptLogic('ja');
        expect(result).toBeTruthy();
        expect(typeof result).toBe('string');
    });

    test('未定義的 langCode 回傳空字串', () => {
        expect(getExamplePromptLogic('ko')).toBe('');
        expect(getExamplePromptLogic('xx')).toBe('');
        expect(getExamplePromptLogic('')).toBe('');
    });

    test('回傳值包含範例對照表內容', () => {
        const result = getExamplePromptLogic('ja');
        expect(result).toContain('まちだ けいた');
    });
});
