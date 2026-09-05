// 功能: 稽核 Gemini 模型清單並實測翻譯，異動時透過 LINE Messaging API 推送通知
// input: tools/.env.local (API keys + LINE token)
//        extension/config/models.js (現有模型清單)
// output: tools/reports/audit-YYYY-MM-DD.md (完整報告)
//         LINE 訊息 (僅在有異動時推送)
// 備註:
//   - 純本地執行，付費 API key 不會離開這台機器
//   - Node >= 18 (使用內建 fetch)
//   - 無外部相依 (不依賴 dotenv、node-fetch 等)

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const REPORTS_DIR = join(__dirname, 'reports');
const ENV_FILE = join(__dirname, '.env.local');
const CONFIG_FILE = join(ROOT, 'extension', 'config', 'models.js');

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';

// 固定測試語料 (短句 + 長句)，跟 lab.js 一致
const TEST_INPUT = [
    'こんにちは世界',
    'この動画は志尊淳さんと町田啓太さんの主演作品です。'
];
const TEST_PROMPT = `你是一位頂尖的繁體中文譯者。請將以下 JSON 陣列中的每一句日文翻譯為自然的繁體中文，並以相同順序、相同數量的 JSON 陣列格式回傳。\n\n${JSON.stringify(TEST_INPUT)}`;

// ============================================================
// 工具函式
// ============================================================

function loadEnv() {
    // 功能: 手動 parse .env.local (避免相依 dotenv)
    // input: 無 (讀 ENV_FILE)
    // output: { KEY: value } 物件
    if (!existsSync(ENV_FILE)) {
        throw new Error(`找不到 ${ENV_FILE}，請先複製 .env.local.example 為 .env.local 並填值`);
    }
    const raw = readFileSync(ENV_FILE, 'utf-8');
    const env = {};
    for (const line of raw.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eq = trimmed.indexOf('=');
        if (eq < 0) continue;
        const key = trimmed.slice(0, eq).trim();
        let val = trimmed.slice(eq + 1).trim();
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
            val = val.slice(1, -1);
        }
        env[key] = val;
    }
    return env;
}

function loadConfigModels() {
    // 功能: 從 config/models.js 抽出目前登記的模型清單 (regex，不 import 避免 IIFE 副作用)
    // input: 無 (讀 CONFIG_FILE)
    // output: [{ id, tier }, ...]
    const raw = readFileSync(CONFIG_FILE, 'utf-8');
    const rows = [];
    const re = /\{\s*id:\s*'([^']+)'[^}]*tier:\s*'(free|paid)'/g;
    let m;
    while ((m = re.exec(raw)) !== null) {
        rows.push({ id: m[1], tier: m[2] });
    }
    if (rows.length === 0) {
        throw new Error(`從 ${CONFIG_FILE} 抽不到模型清單，請檢查格式`);
    }
    return rows;
}

function todayStr() {
    const d = new Date();
    const y = d.getFullYear();
    const mo = String(d.getMonth() + 1).padStart(2, '0');
    const da = String(d.getDate()).padStart(2, '0');
    return `${y}-${mo}-${da}`;
}

// ============================================================
// Gemini API 呼叫
// ============================================================

// 只保留純文字翻譯用的通用 Gemini 模型：flash / flash-lite / pro，可帶 -preview 或 -latest 後綴
// 明確排除 TTS、image、native-audio、embedding、aqa 等特化模型 (即使 API 回傳也不納入)
const TEXT_MODEL_PATTERN = /^gemini-[\d.]+(-flash-lite|-flash|-pro)(-preview(-\d+)?|-latest)?$/;

async function listModels(apiKey) {
    // 功能: 呼叫 ListModels 拿到目前這把 key 可用的「純文字翻譯用」gemini 模型
    // input: apiKey
    // output: [modelId, ...] 已排除 TTS / image / embedding 等特化模型
    const url = `${GEMINI_BASE}/models?key=${apiKey}&pageSize=200`;
    const res = await fetch(url);
    if (!res.ok) {
        const text = await res.text();
        throw new Error(`ListModels 失敗 HTTP ${res.status}: ${text.slice(0, 300)}`);
    }
    const json = await res.json();
    const models = (json.models || [])
        .filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
        .map(m => m.name.replace(/^models\//, ''))
        .filter(id => TEXT_MODEL_PATTERN.test(id));
    return models.sort();
}

async function testTranslate(apiKey, modelId) {
    // 功能: 對指定 model 打一次翻譯請求
    // input: apiKey, modelId
    // output: { status: 'ok' | 'fail', elapsedMs, preview, error }
    const url = `${GEMINI_BASE}/models/${modelId}:generateContent`;
    const body = {
        contents: [{ parts: [{ text: TEST_PROMPT }] }],
        generationConfig: { responseMimeType: 'text/plain' }
    };
    const start = Date.now();
    try {
        const res = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-goog-api-key': apiKey
            },
            body: JSON.stringify(body)
        });
        const elapsedMs = Date.now() - start;
        if (!res.ok) {
            const text = await res.text();
            return { status: 'fail', elapsedMs, error: `HTTP ${res.status}: ${text.slice(0, 200)}` };
        }
        const json = await res.json();
        const text = json.candidates?.[0]?.content?.parts?.[0]?.text || '';
        return {
            status: 'ok',
            elapsedMs,
            preview: text.replace(/\s+/g, ' ').slice(0, 200)
        };
    } catch (e) {
        return { status: 'fail', elapsedMs: Date.now() - start, error: e.message };
    }
}

// ============================================================
// Diff 分析
// ============================================================

function diffModels(configIds, apiIds) {
    // 功能: 比對 config 清單 vs API 回傳清單
    // input: configIds (set-like array), apiIds (set-like array)
    // output: { added, removed, common }
    const cfg = new Set(configIds);
    const api = new Set(apiIds);
    return {
        added: [...api].filter(x => !cfg.has(x)).sort(),
        removed: [...cfg].filter(x => !api.has(x)).sort(),
        common: [...cfg].filter(x => api.has(x)).sort()
    };
}

// ============================================================
// 報告產生
// ============================================================

function renderReport(dateStr, audit) {
    // 功能: 產出 Markdown 報告
    // input: dateStr, audit = { apiList, diff, categorized: {freeOk, paidOnly, unknown}, testDetails }
    // output: markdown 字串
    let md = `# Gemini 模型稽核報告 ${dateStr}\n\n`;

    if (audit.error) {
        md += `## 執行失敗\n\n${audit.error}\n`;
        return md;
    }

    const { apiList, diff, categorized, testDetails } = audit;

    md += `## 摘要\n\n`;
    md += `- API 目前可見純文字模型: ${apiList.length} 個\n`;
    md += `- 免費可用: ${categorized.freeOk.length} 個\n`;
    md += `- 僅付費可用: ${categorized.paidOnly.length} 個\n`;
    md += `- 暫時 quota 上限 (今日用量已滿): ${categorized.quotaExhausted?.length || 0} 個\n`;
    md += `- 待判斷 (非 quota 失敗): ${categorized.unknown.length} 個\n`;
    md += `- API 新增 (config 未登記): ${diff.added.length} 個\n`;
    md += `- API 已無 (config 仍登記): ${diff.removed.length} 個\n\n`;

    md += `## 分類結果\n\n`;

    md += `### 免費可用\n\n`;
    if (categorized.freeOk.length === 0) md += `無\n\n`;
    else { categorized.freeOk.forEach(id => md += `- ${id}\n`); md += `\n`; }

    md += `### 僅付費可用\n\n`;
    if (categorized.paidOnly.length === 0) md += `無\n\n`;
    else { categorized.paidOnly.forEach(id => md += `- ${id}\n`); md += `\n`; }

    md += `### 暫時 quota 上限 (今日 429，明日再測應可用)\n\n`;
    if (!categorized.quotaExhausted || categorized.quotaExhausted.length === 0) md += `無\n\n`;
    else { categorized.quotaExhausted.forEach(id => md += `- ${id}\n`); md += `\n`; }

    md += `### 待判斷 (非 quota 失敗，可能已下架或服務異常)\n\n`;
    if (categorized.unknown.length === 0) md += `無\n\n`;
    else { categorized.unknown.forEach(id => md += `- ${id}\n`); md += `\n`; }

    md += `## 與 config/models.js 差異\n\n`;
    md += `### API 新增 (config 未登記)\n\n`;
    if (diff.added.length === 0) md += `無\n\n`;
    else { diff.added.forEach(id => md += `- ${id}\n`); md += `\n`; }

    md += `### API 已無 (config 仍登記)\n\n`;
    if (diff.removed.length === 0) md += `無\n\n`;
    else { diff.removed.forEach(id => md += `- ${id}\n`); md += `\n`; }

    md += `## 實測翻譯明細\n\n`;
    md += `| 模型 | 綜合狀態 | Free 結果 | Paid 結果 | 耗時 | 輸出預覽 / 錯誤 |\n`;
    md += `|---|---|---|---|---|---|\n`;
    const freeOkSet = new Set(categorized.freeOk);
    const paidOnlySet = new Set(categorized.paidOnly);
    const quotaSet = new Set(categorized.quotaExhausted || []);

    // 把任何字串壓成單行、砍長度、剝掉 API 常見的 ```json fence，避免破壞表格排版
    const cellText = (s, max = 120) => {
        if (!s) return '';
        let t = String(s).replace(/```(?:json)?/gi, '').replace(/\s+/g, ' ').trim();
        t = t.replace(/\|/g, '\\|');
        if (t.length > max) t = t.slice(0, max) + '…';
        return t;
    };
    // 錯誤訊息只取 HTTP xxx + 主要原因 (429 quota / 503 unavailable 等)，避免整包 JSON 塞進格
    const shortError = (err) => {
        if (!err) return '';
        const httpMatch = err.match(/HTTP\s+(\d+)/i);
        const codeMatch = err.match(/"status":\s*"([A-Z_]+)"/);
        const reasonMatch = err.match(/"reason":\s*"([A-Z_]+)"/);
        const parts = [];
        if (httpMatch) parts.push(`HTTP ${httpMatch[1]}`);
        if (reasonMatch) parts.push(reasonMatch[1]);
        else if (codeMatch) parts.push(codeMatch[1]);
        return parts.length ? parts.join(' ') : cellText(err, 60);
    };

    for (const d of testDetails) {
        let overall;
        if (freeOkSet.has(d.modelId)) overall = '免費可用';
        else if (paidOnlySet.has(d.modelId)) overall = '僅付費可用';
        else if (quotaSet.has(d.modelId)) overall = '暫時 quota 上限';
        else overall = '待判斷';

        const freeResult = !d.free ? '未測'
            : (d.free.status === 'ok' ? '成功' : `失敗 (${shortError(d.free.error)})`);
        const paidResult = !d.paid ? '未測 (免費已成功)'
            : (d.paid.status === 'ok' ? '成功' : `失敗 (${shortError(d.paid.error)})`);

        // 耗時只顯示「成功那次」；都失敗就顯示 Free 的耗時 (兩次都跑過)
        let elapsed;
        if (d.free?.status === 'ok') elapsed = `${(d.free.elapsedMs / 1000).toFixed(2)}s`;
        else if (d.paid?.status === 'ok') elapsed = `${(d.paid.elapsedMs / 1000).toFixed(2)}s`;
        else elapsed = d.free ? `${(d.free.elapsedMs / 1000).toFixed(2)}s (失敗)` : '-';

        // 預覽/錯誤: 優先顯示成功的輸出；都失敗顯示簡短錯誤
        let detail;
        if (d.free?.status === 'ok') detail = cellText(d.free.preview);
        else if (d.paid?.status === 'ok') detail = cellText(d.paid.preview);
        else detail = shortError(d.paid?.error || d.free?.error);

        md += `| ${d.modelId} | ${overall} | ${freeResult} | ${paidResult} | ${elapsed} | ${detail} |\n`;
    }
    md += `\n---\n*測試語料*：\n\`\`\`json\n${JSON.stringify(TEST_INPUT, null, 2)}\n\`\`\`\n`;
    return md;
}

function summarizeForLine(dateStr, audit) {
    // 功能: 產出 LINE 訊息 (每次都發送摘要，讓使用者看到當前完整狀態)
    // input: dateStr, audit
    // output: { message: string }
    const lines = [`[YT-Enhancer 模型稽核 ${dateStr}]`];

    if (audit.error) {
        lines.push(`執行失敗: ${audit.error.slice(0, 200)}`);
        return { message: lines.join('\n') };
    }

    const { diff, categorized } = audit;
    const quota = categorized.quotaExhausted || [];
    lines.push('');
    lines.push(`免費可用 (${categorized.freeOk.length}):`);
    lines.push(categorized.freeOk.length ? categorized.freeOk.join(', ') : '  無');
    lines.push('');
    lines.push(`僅付費可用 (${categorized.paidOnly.length}):`);
    lines.push(categorized.paidOnly.length ? categorized.paidOnly.join(', ') : '  無');
    if (quota.length > 0) {
        lines.push('');
        lines.push(`暫時 quota 上限 (${quota.length}): ${quota.join(', ')}`);
    }
    lines.push('');
    lines.push(`待判斷 (${categorized.unknown.length}):`);
    lines.push(categorized.unknown.length ? categorized.unknown.join(', ') : '  無');

    if (diff.added.length > 0) {
        lines.push('');
        lines.push(`API 新增 (config 未登記): ${diff.added.join(', ')}`);
    }
    if (diff.removed.length > 0) {
        lines.push('');
        lines.push(`API 已無 (config 仍登記): ${diff.removed.join(', ')}`);
    }
    lines.push('');
    lines.push(`詳見 tools/reports/audit-${dateStr}.md`);
    return { message: lines.join('\n') };
}

// ============================================================
// LINE 推送
// ============================================================

async function pushLine(env, message) {
    // 功能: 呼叫 LINE Messaging API push message
    // input: env (含 LINE_CHANNEL_ACCESS_TOKEN, LINE_USER_ID), message
    // output: 無 (失敗 throw)
    const res = await fetch('https://api.line.me/v2/bot/message/push', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}`
        },
        body: JSON.stringify({
            to: env.LINE_USER_ID,
            messages: [{ type: 'text', text: message.slice(0, 4900) }]
        })
    });
    if (!res.ok) {
        const text = await res.text();
        throw new Error(`LINE push 失敗 HTTP ${res.status}: ${text}`);
    }
}

// ============================================================
// 主流程
// ============================================================

async function runAudit(env, configIds) {
    // 功能: 統一稽核流程 - Paid ListModels → Free 全測 → Paid 只補測 Free 失敗的
    // input: env (含 GEMINI_API_KEY_FREE / PAID), configIds (config 現登記的所有 model id)
    // output: { apiList, diff, categorized: {freeOk, paidOnly, unknown}, testDetails } 或 { error }
    if (!env.GEMINI_API_KEY_PAID) return { error: '.env.local 未設定 GEMINI_API_KEY_PAID (用於 ListModels)' };
    if (!env.GEMINI_API_KEY_FREE) return { error: '.env.local 未設定 GEMINI_API_KEY_FREE' };

    try {
        console.log('\n[1/3] Paid key 呼叫 ListModels 取完整清單...');
        const apiList = await listModels(env.GEMINI_API_KEY_PAID);
        console.log(`  API 目前有 ${apiList.length} 個純文字模型: ${apiList.join(', ')}`);

        const diff = diffModels(configIds, apiList);
        if (diff.added.length) console.log(`  新增 (config 未登記): ${diff.added.join(', ')}`);
        if (diff.removed.length) console.log(`  已無 (config 仍登記): ${diff.removed.join(', ')}`);

        // 實測範圍: API 目前存在的所有 model (含 config 已無的就跳過，避免浪費)
        const toTest = apiList;

        console.log(`\n[2/3] Free key 實測 ${toTest.length} 個模型...`);
        const freeResults = {};
        for (const id of toTest) {
            process.stdout.write(`  ${id} ... `);
            const r = await testTranslate(env.GEMINI_API_KEY_FREE, id);
            console.log(r.status === 'ok' ? `成功 ${(r.elapsedMs / 1000).toFixed(2)}s` : `失敗 (${r.error?.slice(0, 80)})`);
            freeResults[id] = r;
        }

        const freeFailed = toTest.filter(id => freeResults[id].status !== 'ok');
        console.log(`\n[3/3] Paid key 補測 Free 失敗的 ${freeFailed.length} 個...`);
        const paidResults = {};
        for (const id of freeFailed) {
            process.stdout.write(`  ${id} ... `);
            const r = await testTranslate(env.GEMINI_API_KEY_PAID, id);
            console.log(r.status === 'ok' ? `成功 ${(r.elapsedMs / 1000).toFixed(2)}s` : `失敗 (${r.error?.slice(0, 80)})`);
            paidResults[id] = r;
        }

        // 分類 (429 quota 失敗視為「暫時性用量上限」，跟真正下架分開)
        const isQuotaErr = (r) => r && r.status !== 'ok' && /HTTP\s*429|RESOURCE_EXHAUSTED|quota/i.test(r.error || '');
        const freeOk = toTest.filter(id => freeResults[id].status === 'ok');
        const paidOnly = freeFailed.filter(id => paidResults[id]?.status === 'ok');
        const quotaExhausted = freeFailed.filter(id =>
            paidResults[id]?.status !== 'ok' && (isQuotaErr(freeResults[id]) || isQuotaErr(paidResults[id]))
        );
        const unknown = freeFailed.filter(id =>
            paidResults[id]?.status !== 'ok' && !quotaExhausted.includes(id)
        );

        const testDetails = toTest.map(id => ({
            modelId: id,
            free: freeResults[id],
            paid: paidResults[id] || null
        }));

        return { apiList, diff, categorized: { freeOk, paidOnly, quotaExhausted, unknown }, testDetails };
    } catch (e) {
        console.error(`  稽核異常: ${e.message}`);
        return { error: e.message };
    }
}

async function main() {
    const env = loadEnv();
    const configModels = loadConfigModels();
    const configIds = configModels.map(m => m.id);
    console.log(`Config 現登記 ${configIds.length} 個模型: ${configIds.join(', ')}`);

    const audit = await runAudit(env, configIds);

    const dateStr = todayStr();
    const report = renderReport(dateStr, audit);
    if (!existsSync(REPORTS_DIR)) mkdirSync(REPORTS_DIR, { recursive: true });
    const reportPath = join(REPORTS_DIR, `audit-${dateStr}.md`);
    writeFileSync(reportPath, report, 'utf-8');
    console.log(`\n報告已寫入 ${reportPath}`);

    const summary = summarizeForLine(dateStr, audit);
    if (env.LINE_CHANNEL_ACCESS_TOKEN && env.LINE_USER_ID) {
        try {
            await pushLine(env, summary.message);
            console.log(`\nLINE 通知已推送:\n${summary.message}`);
        } catch (e) {
            console.error(`\nLINE 推送失敗: ${e.message}`);
            process.exitCode = 2;
        }
    } else {
        console.log(`\n未設定 LINE token，訊息內容:\n${summary.message}`);
    }
}

main().catch(e => {
    console.error('稽核腳本異常終止:', e);
    process.exit(1);
});
