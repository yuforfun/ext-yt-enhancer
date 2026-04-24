'use strict';

// ============================================================
// 測試涵蓋範圍（對應 Batch C 修改）：
//   #一 CircuitBreaker ensureLoaded() + _readyPromise 模式
//   #三 SDK Client _clientCache Map
//   #四 reorderKeysByStickiness 改同步 + 記憶體快取
// ============================================================

// ── Mock chrome API ──────────────────────────────────────────

let _mockSession = {};

global.chrome = {
    storage: {
        session: {
            get: jest.fn(async (defaults) => {
                const out = {};
                for (const [k, v] of Object.entries(defaults)) {
                    out[k] = _mockSession[k] !== undefined ? _mockSession[k] : v;
                }
                return out;
            }),
            set: jest.fn(async (data) => { Object.assign(_mockSession, data); }),
        },
    },
};

beforeEach(() => {
    _mockSession = {};
    jest.clearAllMocks();
});

// ── 複製受測程式碼（與 background.js 保持一致）────────────────

// #一 CircuitBreaker
class CircuitBreaker {
    constructor() {
        this.state = new Map();
        this._readyPromise = this._loadFromStorage();
    }

    async _loadFromStorage() {
        try {
            const result = await chrome.storage.session.get({ 'circuitBreakerState': {} });
            const now = Date.now();
            for (const [k, v] of Object.entries(result.circuitBreakerState)) {
                if (v > now) this.state.set(k, v);
            }
        } catch (e) { /* silent */ }
    }

    ensureLoaded() { return this._readyPromise; }

    async _saveToStorage() {
        try {
            await chrome.storage.session.set({ 'circuitBreakerState': Object.fromEntries(this.state) });
        } catch (e) { /* silent */ }
    }

    getUniqueId(keyId, modelId) { return `${keyId}::${modelId}`; }

    isOpen(keyId, modelId) {
        const uid = this.getUniqueId(keyId, modelId);
        const cooldownUntil = this.state.get(uid);
        if (cooldownUntil && cooldownUntil > Date.now()) {
            return { isOpen: true, remaining: Math.ceil((cooldownUntil - Date.now()) / 1000) };
        }
        return { isOpen: false, remaining: 0 };
    }

    trip(keyId, modelId, penaltyMs) {
        const uid = this.getUniqueId(keyId, modelId);
        this.state.set(uid, Date.now() + penaltyMs);
        this._saveToStorage();
    }
}

// #三 _clientCache
class MockGoogleGenAI {
    constructor({ apiKey }) { this.apiKey = apiKey; }
}

const _clientCache = new Map();

function getOrCreateClient(keyInfo) {
    if (!_clientCache.has(keyInfo.id)) {
        _clientCache.set(keyInfo.id, new MockGoogleGenAI({ apiKey: keyInfo.key }));
    }
    return _clientCache.get(keyInfo.id);
}

function invalidateClientCache(keyId) {
    if (keyId) { _clientCache.delete(keyId); }
    else { _clientCache.clear(); }
}

// #四 reorderKeysByStickiness + recordSuccessfulKey
const LAST_SUCCESSFUL_KEY_ID = 'lastSuccessfulKeyId';
let _lastSuccessfulKeyIdCache = null;

function reorderKeysByStickiness(apiKeys) {
    if (!apiKeys || apiKeys.length <= 1) return apiKeys;
    const lastId = _lastSuccessfulKeyIdCache;
    if (!lastId) return apiKeys;
    const idx = apiKeys.findIndex(k => k.id === lastId);
    if (idx <= 0) return apiKeys;
    const reordered = [...apiKeys];
    const [stickyKey] = reordered.splice(idx, 1);
    reordered.unshift(stickyKey);
    return reordered;
}

async function recordSuccessfulKey(keyId) {
    _lastSuccessfulKeyIdCache = keyId;
    try {
        await chrome.storage.session.set({ [LAST_SUCCESSFUL_KEY_ID]: keyId });
    } catch (e) { /* silent */ }
}

// ── #一 CircuitBreaker 測試 ───────────────────────────────────

describe('CircuitBreaker #一 — _readyPromise / ensureLoaded', () => {
    test('ensureLoaded() 回傳 Promise', () => {
        const cb = new CircuitBreaker();
        expect(cb.ensureLoaded()).toBeInstanceOf(Promise);
    });

    test('多次呼叫 ensureLoaded() 回傳相同 Promise 實例', () => {
        const cb = new CircuitBreaker();
        expect(cb.ensureLoaded()).toBe(cb.ensureLoaded());
    });

    test('resolve 後：尚未過期的紀錄被載入 state', async () => {
        const future = Date.now() + 60_000;
        _mockSession = { circuitBreakerState: { 'key1::model1': future } };
        const cb = new CircuitBreaker();
        await cb.ensureLoaded();
        expect(cb.state.get('key1::model1')).toBe(future);
    });

    test('resolve 後：已過期的紀錄不被載入 state', async () => {
        const past = Date.now() - 1_000;
        _mockSession = { circuitBreakerState: { 'key2::model2': past } };
        const cb = new CircuitBreaker();
        await cb.ensureLoaded();
        expect(cb.state.has('key2::model2')).toBe(false);
    });

    test('session 無資料時 state 保持空 Map', async () => {
        const cb = new CircuitBreaker();
        await cb.ensureLoaded();
        expect(cb.state.size).toBe(0);
    });

    test('混合過期與有效紀錄：只保留有效', async () => {
        const future = Date.now() + 30_000;
        const past = Date.now() - 1;
        _mockSession = {
            circuitBreakerState: { 'kA::m1': future, 'kB::m1': past },
        };
        const cb = new CircuitBreaker();
        await cb.ensureLoaded();
        expect(cb.state.has('kA::m1')).toBe(true);
        expect(cb.state.has('kB::m1')).toBe(false);
    });

    test('storage 拋出例外時 ensureLoaded() 仍正常 resolve，state 為空', async () => {
        chrome.storage.session.get.mockRejectedValueOnce(new Error('storage error'));
        const cb = new CircuitBreaker();
        await expect(cb.ensureLoaded()).resolves.toBeUndefined();
        expect(cb.state.size).toBe(0);
    });

    test('isOpen：有效冷卻紀錄回傳 isOpen=true', async () => {
        const future = Date.now() + 10_000;
        _mockSession = { circuitBreakerState: { 'k::m': future } };
        const cb = new CircuitBreaker();
        await cb.ensureLoaded();
        expect(cb.isOpen('k', 'm').isOpen).toBe(true);
    });

    test('trip：寫入 state 並觸發 _saveToStorage', () => {
        const cb = new CircuitBreaker();
        cb.trip('k1', 'm1', 5_000);
        expect(cb.state.has('k1::m1')).toBe(true);
        expect(chrome.storage.session.set).toHaveBeenCalled();
    });
});

// ── #三 _clientCache 測試 ─────────────────────────────────────

describe('_clientCache #三 — getOrCreateClient / invalidateClientCache', () => {
    const keyA = { id: 'id-A', key: 'apikey-A', name: 'Key A' };
    const keyB = { id: 'id-B', key: 'apikey-B', name: 'Key B' };

    beforeEach(() => _clientCache.clear());

    test('第一次呼叫為指定 keyId 建立 client', () => {
        const client = getOrCreateClient(keyA);
        expect(client).toBeDefined();
        expect(client.apiKey).toBe('apikey-A');
    });

    test('同一 keyId 第二次呼叫回傳相同實例（快取命中）', () => {
        const c1 = getOrCreateClient(keyA);
        const c2 = getOrCreateClient(keyA);
        expect(c1).toBe(c2);
    });

    test('不同 keyId 各自擁有獨立 client 實例', () => {
        const cA = getOrCreateClient(keyA);
        const cB = getOrCreateClient(keyB);
        expect(cA).not.toBe(cB);
        expect(cA.apiKey).toBe('apikey-A');
        expect(cB.apiKey).toBe('apikey-B');
    });

    test('invalidateClientCache(keyId) 只移除指定 key，其他保留', () => {
        getOrCreateClient(keyA);
        getOrCreateClient(keyB);
        invalidateClientCache('id-A');
        expect(_clientCache.has('id-A')).toBe(false);
        expect(_clientCache.has('id-B')).toBe(true);
    });

    test('invalidateClientCache() 無參數時清除全部快取', () => {
        getOrCreateClient(keyA);
        getOrCreateClient(keyB);
        invalidateClientCache();
        expect(_clientCache.size).toBe(0);
    });

    test('invalidateClientCache 後再次 getOrCreateClient 建立新實例', () => {
        const c1 = getOrCreateClient(keyA);
        invalidateClientCache('id-A');
        const c2 = getOrCreateClient(keyA);
        expect(c1).not.toBe(c2);
    });
});

// ── #四 reorderKeysByStickiness 測試 ─────────────────────────

describe('reorderKeysByStickiness #四 — 同步 + 記憶體快取', () => {
    const keys = [
        { id: 'k1', name: 'Key1' },
        { id: 'k2', name: 'Key2' },
        { id: 'k3', name: 'Key3' },
    ];

    beforeEach(() => { _lastSuccessfulKeyIdCache = null; });

    test('快取為 null 時回傳原陣列', () => {
        expect(reorderKeysByStickiness(keys)).toEqual(keys);
    });

    test('陣列長度為 0 時原樣回傳', () => {
        _lastSuccessfulKeyIdCache = 'k1';
        expect(reorderKeysByStickiness([])).toEqual([]);
    });

    test('陣列長度為 1 時原樣回傳', () => {
        _lastSuccessfulKeyIdCache = 'k1';
        expect(reorderKeysByStickiness([keys[0]])).toEqual([keys[0]]);
    });

    test('sticky key 移至陣列首位', () => {
        _lastSuccessfulKeyIdCache = 'k3';
        const result = reorderKeysByStickiness(keys);
        expect(result[0].id).toBe('k3');
    });

    test('sticky key 已在首位時直接回傳原陣列（同一引用）', () => {
        _lastSuccessfulKeyIdCache = 'k1';
        const result = reorderKeysByStickiness(keys);
        expect(result).toBe(keys);
    });

    test('不修改原始陣列（回傳新陣列）', () => {
        _lastSuccessfulKeyIdCache = 'k2';
        const snapshot = keys.map(k => ({ ...k }));
        const result = reorderKeysByStickiness(keys);
        expect(result).not.toBe(keys);
        expect(keys).toEqual(snapshot);
    });

    test('重排後陣列包含所有原始元素（長度不變）', () => {
        _lastSuccessfulKeyIdCache = 'k2';
        const result = reorderKeysByStickiness(keys);
        expect(result).toHaveLength(keys.length);
        expect(result).toEqual(expect.arrayContaining(keys));
    });

    test('快取 id 不存在於陣列時回傳原陣列', () => {
        _lastSuccessfulKeyIdCache = 'k-nonexistent';
        const result = reorderKeysByStickiness(keys);
        expect(result).toBe(keys);
    });
});

// ── #四 recordSuccessfulKey 測試 ──────────────────────────────

describe('recordSuccessfulKey #四 — 更新快取 + 寫入 storage', () => {
    beforeEach(() => { _lastSuccessfulKeyIdCache = null; });

    test('呼叫後立即更新記憶體快取', async () => {
        await recordSuccessfulKey('k2');
        expect(_lastSuccessfulKeyIdCache).toBe('k2');
    });

    test('呼叫後寫入 chrome.storage.session', async () => {
        await recordSuccessfulKey('k2');
        expect(chrome.storage.session.set).toHaveBeenCalledWith({ [LAST_SUCCESSFUL_KEY_ID]: 'k2' });
    });

    test('storage 拋出例外時，記憶體快取仍已更新', async () => {
        chrome.storage.session.set.mockRejectedValueOnce(new Error('write error'));
        await recordSuccessfulKey('k3');
        expect(_lastSuccessfulKeyIdCache).toBe('k3');
    });

    test('連續呼叫：快取保持最後一次的 keyId', async () => {
        await recordSuccessfulKey('k1');
        await recordSuccessfulKey('k2');
        expect(_lastSuccessfulKeyIdCache).toBe('k2');
    });

    test('recordSuccessfulKey 後 reorderKeysByStickiness 使用新快取值', async () => {
        await recordSuccessfulKey('k3');
        const keys = [{ id: 'k1' }, { id: 'k2' }, { id: 'k3' }];
        const result = reorderKeysByStickiness(keys);
        expect(result[0].id).toBe('k3');
    });
});
