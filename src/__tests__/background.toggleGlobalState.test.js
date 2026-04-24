'use strict';

// ============================================================
// 測試涵蓋範圍：
//   toggleGlobalState — async/await + _toggleLock 防重入
//
// 依序測試：
//   一、正常切換（false → true, true → false）
//   二、鎖定防重入（busy 回應）
//   三、鎖定在操作完成後釋放
//   四、廣播 settingsChanged 至 YouTube tabs
//   五、storage 讀取失敗時 lock 仍釋放
// ============================================================

// --- Mock chrome API ---
let storageData = {};
let mockTabs = [];
let sentMessages = [];

const chrome = {
    storage: {
        local: {
            get: jest.fn(async (defaults) => {
                const key = Object.keys(defaults)[0];
                return { [key]: storageData[key] ?? defaults[key] };
            }),
            set: jest.fn(async (data) => {
                Object.assign(storageData, data);
            }),
        },
    },
    tabs: {
        query: jest.fn(async () => mockTabs),
        sendMessage: jest.fn(() => Promise.resolve()),
    },
};

// --- 模擬 globalCircuitBreaker ---
const globalCircuitBreaker = { _toggleLock: false };

// --- 從 background.js 擷取的 toggleGlobalState 邏輯（函式化以便測試）---
const defaultSettings = { isEnabled: false };

async function toggleGlobalState(sendResponse) {
    if (globalCircuitBreaker._toggleLock) {
        sendResponse({ isEnabled: null, error: 'busy' });
        return;
    }
    globalCircuitBreaker._toggleLock = true;
    try {
        const result = await chrome.storage.local.get({ 'ytEnhancerSettings': defaultSettings });
        const newSettings = { ...result.ytEnhancerSettings };
        newSettings.isEnabled = !newSettings.isEnabled;
        await chrome.storage.local.set({ 'ytEnhancerSettings': newSettings });
        sendResponse({ isEnabled: newSettings.isEnabled });

        const tabs = await chrome.tabs.query({ url: '*://www.youtube.com/*' });
        for (const tab of tabs) {
            chrome.tabs.sendMessage(tab.id, {
                action: 'settingsChanged',
                settings: newSettings,
            }).catch(() => {});
        }
    } finally {
        globalCircuitBreaker._toggleLock = false;
    }
}

// --- 測試輔助 ---
function makeResponse() {
    let captured = null;
    const fn = (val) => { captured = val; };
    fn.get = () => captured;
    return fn;
}

beforeEach(() => {
    storageData = {};
    mockTabs = [];
    sentMessages = [];
    globalCircuitBreaker._toggleLock = false;
    jest.clearAllMocks();
    chrome.tabs.sendMessage.mockReturnValue(Promise.resolve());
});

// ============================================================
// 一、正常切換
// ============================================================
describe('toggleGlobalState — 正常切換', () => {
    test('isEnabled false → true', async () => {
        storageData['ytEnhancerSettings'] = { isEnabled: false };
        const res = makeResponse();
        await toggleGlobalState(res);
        expect(res.get()).toEqual({ isEnabled: true });
    });

    test('isEnabled true → false', async () => {
        storageData['ytEnhancerSettings'] = { isEnabled: true };
        const res = makeResponse();
        await toggleGlobalState(res);
        expect(res.get()).toEqual({ isEnabled: false });
    });

    test('切換後寫入 storage', async () => {
        storageData['ytEnhancerSettings'] = { isEnabled: false };
        const res = makeResponse();
        await toggleGlobalState(res);
        expect(chrome.storage.local.set).toHaveBeenCalledWith({
            ytEnhancerSettings: expect.objectContaining({ isEnabled: true }),
        });
    });

    test('無 storage 資料時使用 defaultSettings (isEnabled=false) → 切換為 true', async () => {
        const res = makeResponse();
        await toggleGlobalState(res);
        expect(res.get()).toEqual({ isEnabled: true });
    });
});

// ============================================================
// 二、鎖定防重入（busy 回應）
// ============================================================
describe('toggleGlobalState — 鎖定防重入', () => {
    test('_toggleLock=true 時回傳 { isEnabled: null, error: "busy" }', async () => {
        globalCircuitBreaker._toggleLock = true;
        const res = makeResponse();
        await toggleGlobalState(res);
        expect(res.get()).toEqual({ isEnabled: null, error: 'busy' });
    });

    test('busy 時不呼叫 storage.local.get', async () => {
        globalCircuitBreaker._toggleLock = true;
        const res = makeResponse();
        await toggleGlobalState(res);
        expect(chrome.storage.local.get).not.toHaveBeenCalled();
    });

    test('busy 時不呼叫 storage.local.set', async () => {
        globalCircuitBreaker._toggleLock = true;
        const res = makeResponse();
        await toggleGlobalState(res);
        expect(chrome.storage.local.set).not.toHaveBeenCalled();
    });
});

// ============================================================
// 三、鎖定在操作完成後釋放
// ============================================================
describe('toggleGlobalState — 鎖定釋放', () => {
    test('操作完成後 _toggleLock 應為 false', async () => {
        storageData['ytEnhancerSettings'] = { isEnabled: false };
        const res = makeResponse();
        await toggleGlobalState(res);
        expect(globalCircuitBreaker._toggleLock).toBe(false);
    });

    test('第一次完成後第二次可正常執行', async () => {
        storageData['ytEnhancerSettings'] = { isEnabled: false };
        const res1 = makeResponse();
        await toggleGlobalState(res1);
        expect(res1.get()).toEqual({ isEnabled: true });

        const res2 = makeResponse();
        await toggleGlobalState(res2);
        expect(res2.get()).toEqual({ isEnabled: false });
    });
});

// ============================================================
// 四、廣播 settingsChanged 至 YouTube tabs
// ============================================================
describe('toggleGlobalState — 廣播至 tabs', () => {
    test('有 tabs 時呼叫 sendMessage', async () => {
        storageData['ytEnhancerSettings'] = { isEnabled: false };
        mockTabs = [{ id: 1 }, { id: 2 }];
        const res = makeResponse();
        await toggleGlobalState(res);
        expect(chrome.tabs.sendMessage).toHaveBeenCalledTimes(2);
    });

    test('sendMessage 攜帶 action=settingsChanged 與新設定', async () => {
        storageData['ytEnhancerSettings'] = { isEnabled: false };
        mockTabs = [{ id: 42 }];
        const res = makeResponse();
        await toggleGlobalState(res);
        expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(42, {
            action: 'settingsChanged',
            settings: expect.objectContaining({ isEnabled: true }),
        });
    });

    test('無 tabs 時不呼叫 sendMessage', async () => {
        storageData['ytEnhancerSettings'] = { isEnabled: false };
        mockTabs = [];
        const res = makeResponse();
        await toggleGlobalState(res);
        expect(chrome.tabs.sendMessage).not.toHaveBeenCalled();
    });

    test('sendMessage 失敗（reject）不影響整體流程', async () => {
        storageData['ytEnhancerSettings'] = { isEnabled: false };
        mockTabs = [{ id: 99 }];
        chrome.tabs.sendMessage.mockReturnValue(Promise.reject(new Error('tab gone')));
        const res = makeResponse();
        await expect(toggleGlobalState(res)).resolves.not.toThrow();
        expect(globalCircuitBreaker._toggleLock).toBe(false);
    });
});

// ============================================================
// 五、storage 失敗時 lock 仍釋放
// ============================================================
describe('toggleGlobalState — storage 失敗後 lock 釋放', () => {
    test('storage.local.get 拋出例外後 _toggleLock 應為 false', async () => {
        chrome.storage.local.get.mockRejectedValueOnce(new Error('storage error'));
        const res = makeResponse();
        await expect(toggleGlobalState(res)).rejects.toThrow('storage error');
        expect(globalCircuitBreaker._toggleLock).toBe(false);
    });

    test('storage.local.set 拋出例外後 _toggleLock 應為 false', async () => {
        storageData['ytEnhancerSettings'] = { isEnabled: false };
        chrome.storage.local.set.mockRejectedValueOnce(new Error('write error'));
        const res = makeResponse();
        await expect(toggleGlobalState(res)).rejects.toThrow('write error');
        expect(globalCircuitBreaker._toggleLock).toBe(false);
    });
});
