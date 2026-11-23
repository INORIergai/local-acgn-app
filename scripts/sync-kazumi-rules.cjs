/**
 * scripts/sync-kazumi-rules.cjs —— 离线同步 KazumiRules 到 utils/media-sources/subs/kazumi/
 *
 * 安全：
 *   · 只允许 https 且 host 固定 raw.gitcode.com（国内镜像），拒绝重定向到别的主机；
 *   · 规则名白名单 [A-Za-z0-9_-]，写入前规范化并确认落点在 subs/kazumi 内；
 *   · 剔除规则 headers 里的 apikey/authorization，杜绝凭据入库；
 *   · 跳过 xfdmnext（规则内嵌第三方 publishable key，本项目已有稀饭动漫 Next）。
 *
 * 用法: node scripts/sync-kazumi-rules.cjs
 */
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');

const ALLOW_HOST = 'raw.gitcode.com';
const BASE_PATH = '/gh_mirrors/ka/KazumiRules/raw/main/';
const OUT = path.join(__dirname, '..', 'utils', 'media-sources', 'subs', 'kazumi');
const SKIP = new Set(['xfdmnext']);
const SENSITIVE = new Set(['apikey', 'authorization', 'x-api-key', 'cookie']);
const NAME_RE = /^[A-Za-z0-9_-]{1,40}$/;

function get(urlPath, redirects = 0) {
    return new Promise((resolve, reject) => {
        if (redirects > 2) return reject(new Error('too many redirects'));
        const req = https.request({
            host: ALLOW_HOST,
            path: urlPath,
            method: 'GET',
            headers: { 'User-Agent': 'cinema-vault-rule-sync' },
        }, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                let next;
                try { next = new URL(res.headers.location, 'https://' + ALLOW_HOST); } catch (e) { return reject(new Error('bad redirect')); }
                if (next.protocol !== 'https:' || next.hostname !== ALLOW_HOST) {
                    res.resume();
                    return reject(new Error('redirect to foreign host blocked'));
                }
                res.resume();
                return resolve(get(next.pathname + next.search, redirects + 1));
            }
            if (res.statusCode !== 200) {
                res.resume();
                return reject(new Error('HTTP ' + res.statusCode));
            }
            const chunks = [];
            res.on('data', (d) => chunks.push(d));
            res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        });
        req.on('error', reject);
        req.setTimeout(30000, () => { req.destroy(new Error('timeout')); });
        req.end();
    });
}

function scrub(obj) {
    if (Array.isArray(obj)) return obj.map(scrub);
    if (!obj || typeof obj !== 'object') return obj;
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
        if (k === 'headers' && v && typeof v === 'object' && !Array.isArray(v)) {
            const clean = {};
            for (const [hk, hv] of Object.entries(v)) {
                if (!SENSITIVE.has(String(hk).toLowerCase())) clean[hk] = hv;
            }
            out[k] = clean;
        } else {
            out[k] = scrub(v);
        }
    }
    return out;
}

function safeTarget(name) {
    if (!NAME_RE.test(name)) throw new Error('invalid rule name');
    const full = path.resolve(OUT, name + '.json');
    const root = path.resolve(OUT) + path.sep;
    if (!full.startsWith(root)) throw new Error('path escape blocked');
    return full;
}

async function main() {
    fs.mkdirSync(OUT, { recursive: true });
    const indexRaw = await get(BASE_PATH + 'index.json');
    const index = JSON.parse(indexRaw);
    console.log('index:', index.length, 'rules');
    const saved = [];
    const failed = [];
    for (const it of index) {
        const name = String(it.name || '');
        if (!NAME_RE.test(name)) { failed.push([name, 'invalid name']); continue; }
        if (SKIP.has(name)) { console.log('  skip', name); continue; }
        try {
            const raw = await get(BASE_PATH + name + '.json');
            const rule = scrub(JSON.parse(raw));
            rule.factoryId = 'kazumi';
            fs.writeFileSync(safeTarget(name), JSON.stringify(rule, null, 2), 'utf8');
            saved.push([name, rule.searchMode, rule.chapterMode, String(rule.baseURL || '').slice(0, 44)]);
            process.stdout.write('.');
        } catch (e) {
            failed.push([name, String(e.message || e).slice(0, 80)]);
        }
    }
    console.log('\nsaved', saved.length);
    for (const s of saved) console.log('  ', s[0], '| search', s[1], '| chapter', s[2], '|', s[3]);
    if (failed.length) {
        console.log('\nfailed', failed.length);
        for (const f of failed) console.log('  ', f[0], f[1]);
    }
}

main().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
