'use strict';

// ============================================================
// 測試涵蓋範圍（Batch E — Cache TTL）：
//   七、content.js getCache — TTL 驗證（過期、有效、向下相容）
//   七、content.js setCache — 自動注入 cachedAt 時間戳
//   七、background.js purgeExpiredCache — 清除過期快取項目
// ============================================================

const CACHE_TTL_MS = 365 * 24 * 60 * 60 * 1000; // 365 天

// ============================================================
// 一、content.js getCache / setCache 邏輯（從 content.js 擷取）
// ============================================================

// 模擬 sendMessageToBackground 以隔離測試
class FakeEnhancer {
    constructor(storageData = {}) {
        this._storage = storageData;
        this._logs = [];
        this._setCalls = [];
    }

    _log(...args) {
        this._logs.push(args.join(' '));
    }

    async sendMessageToBackground(msg) {
        if (msg.action === 'getCache') {
            return { success: true, data: this._storage[msg.key] ?? null };
        }
        if (msg.action === 'setCache') {
            if (msg.data === null) {
                delete this._storage[msg.key];
            } else {
                this._storage[msg.key] = msg.data;
            }
            this._setCalls.push({ key: msg.key, data: msg.data });
            return { success: true };
        }
    }

    // --- 複製自 content.js ---
    async getCache(key) {
        try {
            const response = await this.sendMessageToBackground({ action: 'getCache', key });
            const cached = response?.data;
            if (!cached) return null;

            if (cached.cachedAt && (Date.now() - cached.cachedAt) > CACHE_TTL_MS) {
                this._log(`[Cache] 快取已過期（存入於 ${new Date(cached.cachedAt).toLocaleDateString()}），清除並重新翻譯。`);
                await this.setCache(key, null);
                return null;
            }

            return cached;
        } catch (e) {
            this._log('❌ 讀取暫存失敗:', e);
            return null;
        }
    }

    async setCache(key, data) {
        try {
            const dataWithTimestamp = data ? { ...data, cachedAt: Date.now() } : null;
            await this.sendMessageToBackground({ action: 'setCache', key, data: dataWithTimestamp });
        } catch (e) {
            this._log('❌ 寫入暫存失敗:', e);
        }
    }
}

describe('content.js — getCache TTL 驗證', () => {
    test('有效快取（cachedAt 在 7 天內）→ 回傳資料', async () => {
        const recentTime = Date.now() - 1 * 24 * 60 * 60 * 1000; // 1 天前
        const enhancer = new FakeEnhancer({
            'yt-enhancer-cache-abc': { translatedTrack: ['hello'], cachedAt: recentTime },
        });

        const result = await enhancer.getCache('yt-enhancer-cache-abc');

        expect(result).not.toBeNull();
        expect(result.translatedTrack).toEqual(['hello']);
    });

    test('過期快取（cachedAt 超過 7 天）→ 回傳 null 並清除', async () => {
        const expiredTime = Date.now() - 366 * 24 * 60 * 60 * 1000; // 366 天前
        const key = 'yt-enhancer-cache-abc';
        const enhancer = new FakeEnhancer({
            [key]: { translatedTrack: ['old'], cachedAt: expiredTime },
        });

        const result = await enhancer.getCache(key);

        expect(result).toBeNull();
        // 應主動清除該 key
        expect(enhancer._storage[key]).toBeUndefined();
    });

    test('向下相容：無 cachedAt 欄位的舊快取 → 直接回傳不報錯', async () => {
        const key = 'yt-enhancer-cache-old';
        const enhancer = new FakeEnhancer({
            [key]: { translatedTrack: ['legacy data'] }, // 無 cachedAt
        });

        const result = await enhancer.getCache(key);

        expect(result).not.toBeNull();
        expect(result.translatedTrack).toEqual(['legacy data']);
    });

    test('快取不存在 → 回傳 null', async () => {
        const enhancer = new FakeEnhancer({});
        const result = await enhancer.getCache('yt-enhancer-cache-missing');
        expect(result).toBeNull();
    });

    test('sendMessageToBackground 拋出例外 → 回傳 null 不崩潰', async () => {
        const enhancer = new FakeEnhancer();
        enhancer.sendMessageToBackground = async () => { throw new Error('chrome disconnected'); };

        const result = await enhancer.getCache('any-key');
        expect(result).toBeNull();
    });
});

describe('content.js — setCache 注入 cachedAt', () => {
    test('存入非 null 資料時自動附加 cachedAt', async () => {
        const enhancer = new FakeEnhancer();
        const before = Date.now();

        await enhancer.setCache('yt-enhancer-cache-xyz', { translatedTrack: ['hi'] });

        const after = Date.now();
        const stored = enhancer._storage['yt-enhancer-cache-xyz'];
        expect(stored).not.toBeNull();
        expect(stored.translatedTrack).toEqual(['hi']);
        expect(stored.cachedAt).toBeGreaterThanOrEqual(before);
        expect(stored.cachedAt).toBeLessThanOrEqual(after);
    });

    test('存入 null 時傳遞 null（清除快取）不附加 cachedAt', async () => {
        const enhancer = new FakeEnhancer({
            'yt-enhancer-cache-xyz': { translatedTrack: ['old'], cachedAt: Date.now() },
        });

        await enhancer.setCache('yt-enhancer-cache-xyz', null);

        const lastCall = enhancer._setCalls.at(-1);
        expect(lastCall.data).toBeNull();
        expect(enhancer._storage['yt-enhancer-cache-xyz']).toBeUndefined();
    });

    test('sendMessageToBackground 拋出例外 → 不崩潰', async () => {
        const enhancer = new FakeEnhancer();
        enhancer.sendMessageToBackground = async () => { throw new Error('no channel'); };

        await expect(enhancer.setCache('key', { x: 1 })).resolves.toBeUndefined();
    });
});

// ============================================================
// 二、background.js — purgeExpiredCache 邏輯
// ============================================================

// 從 src/background.js 擷取 purgeExpiredCache 核心邏輯
async function purgeExpiredCacheLogic(chromeStorage, sendResponse) {
    const items = await chromeStorage.local.get(null);
    const now = Date.now();
    const expiredKeys = Object.entries(items)
        .filter(([key, val]) =>
            key.startsWith('yt-enhancer-cache-') &&
            val?.cachedAt &&
            (now - val.cachedAt) > CACHE_TTL_MS
        )
        .map(([key]) => key);

    if (expiredKeys.length > 0) {
        await chromeStorage.local.remove(expiredKeys);
    }
    sendResponse({ success: true, purgedCount: expiredKeys.length });
}

describe('background.js — purgeExpiredCache', () => {
    function makeStorage(data) {
        let store = { ...data };
        return {
            local: {
                get: jest.fn(async () => ({ ...store })),
                remove: jest.fn(async (keys) => {
                    (Array.isArray(keys) ? keys : [keys]).forEach(k => delete store[k]);
                }),
                _store: () => store,
            },
        };
    }

    test('清除過期快取，保留有效快取', async () => {
        const now = Date.now();
        const chromeStorage = makeStorage({
            'yt-enhancer-cache-expired': { cachedAt: now - 366 * 24 * 60 * 60 * 1000 },
            'yt-enhancer-cache-valid': { cachedAt: now - 1 * 24 * 60 * 60 * 1000 },
            'other-key': { cachedAt: now - 30 * 24 * 60 * 60 * 1000 }, // 非快取 key，不應被刪
        });

        let response;
        await purgeExpiredCacheLogic(chromeStorage, (r) => { response = r; });

        expect(response.success).toBe(true);
        expect(response.purgedCount).toBe(1);
        expect(chromeStorage.local.remove).toHaveBeenCalledWith(['yt-enhancer-cache-expired']);
    });

    test('無過期快取時 purgedCount = 0，不呼叫 remove', async () => {
        const now = Date.now();
        const chromeStorage = makeStorage({
            'yt-enhancer-cache-fresh': { cachedAt: now - 2 * 24 * 60 * 60 * 1000 },
        });

        let response;
        await purgeExpiredCacheLogic(chromeStorage, (r) => { response = r; });

        expect(response.success).toBe(true);
        expect(response.purgedCount).toBe(0);
        expect(chromeStorage.local.remove).not.toHaveBeenCalled();
    });

    test('無 cachedAt 欄位的舊快取不被清除（向下相容）', async () => {
        const chromeStorage = makeStorage({
            'yt-enhancer-cache-legacy': { translatedTrack: ['data'] }, // 無 cachedAt
        });

        let response;
        await purgeExpiredCacheLogic(chromeStorage, (r) => { response = r; });

        expect(response.purgedCount).toBe(0);
        expect(chromeStorage.local.remove).not.toHaveBeenCalled();
    });

    test('storage 完全空白時正常回傳', async () => {
        const chromeStorage = makeStorage({});

        let response;
        await purgeExpiredCacheLogic(chromeStorage, (r) => { response = r; });

        expect(response.success).toBe(true);
        expect(response.purgedCount).toBe(0);
    });

    test('同時存在多個過期快取時一次全部清除', async () => {
        const now = Date.now();
        const chromeStorage = makeStorage({
            'yt-enhancer-cache-a': { cachedAt: now - 400 * 24 * 60 * 60 * 1000 },
            'yt-enhancer-cache-b': { cachedAt: now - 500 * 24 * 60 * 60 * 1000 },
            'yt-enhancer-cache-c': { cachedAt: now - 1 * 24 * 60 * 60 * 1000 }, // 有效
        });

        let response;
        await purgeExpiredCacheLogic(chromeStorage, (r) => { response = r; });

        expect(response.purgedCount).toBe(2);
        const removedArg = chromeStorage.local.remove.mock.calls[0][0];
        expect(removedArg).toHaveLength(2);
        expect(removedArg).toContain('yt-enhancer-cache-a');
        expect(removedArg).toContain('yt-enhancer-cache-b');
    });
});
