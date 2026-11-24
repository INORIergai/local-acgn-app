/**
 * utils/anime-downloader.js —— 追番「后台分集下载」队列
 * ------------------------------------------------------------------
 * 设计：
 *   · 前端只提交 {sourceId, 集号, 集页 URL}，解析流地址放到任务真正开始时做，
 *     这样一次投 12 集不会瞬间打爆解析器；队列最多 2 个并发。
 *   · 下载走 ffmpeg：普通模式 `-c copy` 直封装；2.4K 增强模式用
 *     scale=2560:-2:flags=lanczos + 轻锐化 重编码（明确不是 AI 超分）。
 *   · 进度：解析 ffmpeg -stats 的 time=/size=，只报「已下时长 + 体积」。
 *   · 输出：~/Downloads/CinemaVault/anime/<番名>/第01集.mp4（番名做文件名白名单清洗，
 *     输出路径再次校验必须落在下载根目录内）。
 *   · 任务状态只在进程内；重启后未完成任务丢失（文件保留，可手动续）。
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const config = require('./config');
const engine = require('./media-sources/engine');
const streamTokens = require('./media-sources/stream-tokens');

const ROOT = path.resolve(
    (config.download && config.download.animeDir)
        ? String(config.download.animeDir)
        : path.join(os.homedir(), 'Downloads', 'CinemaVault', 'anime')
);
const MAX_RUNNING = 2;

const jobs = new Map();      // id -> job
const queue = [];            // 待启动
let running = 0;
let seq = 0;

function sanitizeName(s) {
    return String(s || '')
        .replace(/[\\/:*?"<>|\x00-\x1f]/g, '_')
        .replace(/\s+/g, ' ')
        .replace(/^\.+/, '')
        .trim()
        .slice(0, 80) || '未命名番剧';
}

function publicJob(j) {
    return {
        id: j.id,
        title: j.title,
        episodeNo: j.episodeNo,
        state: j.state,
        file: j.file,
        upscale: j.upscale,
        positionSec: j.positionSec || 0,
        sizeBytes: j.sizeBytes || 0,
        error: j.error || '',
        createdAt: j.createdAt,
        startedAt: j.startedAt || 0,
        finishedAt: j.finishedAt || 0,
    };
}

function listJobs() {
    return [...jobs.values()].sort((a, b) => b.createdAt - a.createdAt).map(publicJob);
}

function activeCount() {
    return [...jobs.values()].filter((j) => j.state === 'running' || j.state === 'queued').length;
}

/** 投递一集：先入队，真正开始时才解析流地址 */
function enqueue({ title, episodeNo, sourceId, episodeUrl, upscale }) {
    const no = Number(episodeNo);
    if (!no || no <= 0) throw new Error('集号不合法');
    if (!sourceId || !episodeUrl) throw new Error('缺少播放源信息');
    const folder = path.resolve(ROOT, sanitizeName(title));
    if (folder !== ROOT && !folder.startsWith(ROOT + path.sep)) throw new Error('下载目录越界');
    const file = path.resolve(folder, '第' + String(no).padStart(2, '0') + '集' + (upscale ? '_2.4K' : '') + '.mp4');
    if (path.dirname(file) !== folder) throw new Error('输出文件路径越界');
    const job = {
        id: 'dl_' + (++seq) + '_' + Date.now().toString(36),
        title: String(title || '未命名番剧'),
        episodeNo: no,
        sourceId: String(sourceId),
        episodeUrl: String(episodeUrl),
        upscale: upscale === true,
        file,
        state: 'queued',
        positionSec: 0,
        sizeBytes: 0,
        error: '',
        createdAt: Date.now(),
        child: null,
    };
    jobs.set(job.id, job);
    queue.push(job);
    pump();
    return publicJob(job);
}

function pump() {
    while (running < MAX_RUNNING && queue.length) {
        const job = queue.shift();
        if (job.state !== 'queued') continue;
        start(job);
    }
}

async function start(job) {
    running += 1;
    job.state = 'running';
    job.startedAt = Date.now();
    try {
        fs.mkdirSync(path.dirname(job.file), { recursive: true });
        const src = engine.getSource(job.sourceId);
        if (!src) throw new Error('源已失效：' + job.sourceId);
        const r = await engine.resolveVideo(src, job.episodeUrl, { timeout: 30000, browser: true });
        if (!r || !r.url) throw new Error((r && r.error) || '解析不到播放地址');
        /* 下载也走本机流代理：Referer/UA/Cookie 与 HLS 分片改写都复用播放链路，
           避免 ffmpeg 直连源站时被防盗链 400。 */
        const input = String(r.url).trim()
            .replace(/^[\s"']+|[\s"',;]+$/g, '')
            .replace(/\\\//g, '/');
        if (!/^https?:\/\//i.test(input)) throw new Error('播放地址不是 http(s)');
        job.streamUrl = input;
        const proxyPath = streamTokens.buildStreamUrl(input, r.headers || {}, r.cookie || '');
        const localUrl = 'http://127.0.0.1:' + (Number(config.serverPort) || 3000) + proxyPath;

        const args = ['-y', '-hide_banner', '-loglevel', 'error', '-stats', '-i', localUrl];
        if (job.upscale) {
            /* 2.4K 增强：宽 2560（2.4K 档位），lanczos 放大 + 轻锐化。
               这是确定性画质增强，不是 AI 超分；UI 已注明。 */
            args.push('-vf', 'scale=2560:-2:flags=lanczos,unsharp=5:5:0.5:5:5:0.0');
            args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20');
            args.push('-c:a', 'aac', '-b:a', '192k');
        } else {
            args.push('-c', 'copy');
        }
        args.push('-movflags', '+faststart', job.file);

        /* 访问本机代理不能被系统代理劫持 */
        const env = Object.assign({}, process.env);
        env.no_proxy = '127.0.0.1,localhost';
        env.NO_PROXY = '127.0.0.1,localhost';
        const child = spawn('ffmpeg', args, { windowsHide: true, env });
        job.child = child;
        let tail = '';
        child.stderr.on('data', (buf) => {
            const s = buf.toString('utf8');
            tail = (tail + s).slice(-2000);
            const tm = /time=(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(s);
            if (tm) job.positionSec = Number(tm[1]) * 3600 + Number(tm[2]) * 60 + Number(tm[3]);
            const sm = /size=\s*(\d+)kB/i.exec(s);
            if (sm) job.sizeBytes = Number(sm[1]) * 1024;
        });
        child.on('error', (e) => {
            job.state = 'error';
            job.error = '无法启动 ffmpeg：' + e.message + '（请安装 ffmpeg 或加入 PATH）';
            job.finishedAt = Date.now();
            finish();
        });
        child.on('exit', (code) => {
            job.finishedAt = Date.now();
            if (job.state === 'canceled') { finish(); return; }
            if (code === 0) {
                job.state = 'done';
                try { job.sizeBytes = fs.statSync(job.file).size; } catch (e) { /* 忽略 */ }
            } else {
                job.state = 'error';
                const lines = tail.split(/\r?\n/).filter(Boolean).slice(-3).join(' | ');
                job.error = 'ffmpeg 退出码 ' + code + (lines ? '：' + lines : '');
                try { fs.unlinkSync(job.file); } catch (e) { /* 忽略 */ }
            }
            finish();
        });
    } catch (e) {
        job.state = 'error';
        job.error = e.message || '下载失败';
        job.finishedAt = Date.now();
        finish();
    }
}

function finish() {
    running = Math.max(0, running - 1);
    pump();
}

function cancel(id) {
    const job = jobs.get(String(id));
    if (!job) return false;
    if (job.state === 'queued') {
        job.state = 'canceled';
        job.finishedAt = Date.now();
        const idx = queue.indexOf(job);
        if (idx >= 0) queue.splice(idx, 1);
        return true;
    }
    if (job.state === 'running' && job.child) {
        job.state = 'canceled';
        try { job.child.kill('SIGKILL'); } catch (e) { /* 忽略 */ }
        return true;
    }
    return false;
}

function clearFinished() {
    let n = 0;
    for (const [id, j] of jobs) {
        if (j.state === 'done' || j.state === 'error' || j.state === 'canceled') {
            jobs.delete(id);
            n += 1;
        }
    }
    return n;
}

function reveal(id) {
    const job = jobs.get(String(id));
    if (!job) throw new Error('任务不存在');
    const file = path.resolve(job.file);
    if (file !== ROOT && !file.startsWith(ROOT + path.sep)) throw new Error('路径越界');
    const { spawn: spawnOpen } = require('child_process');
    if (process.platform === 'win32') {
        spawnOpen('explorer', ['/select,' + file], { windowsVerbatimArguments: true, detached: true, stdio: 'ignore' }).unref();
    } else if (process.platform === 'darwin') {
        spawnOpen('open', ['-R', file], { detached: true, stdio: 'ignore' }).unref();
    } else {
        spawnOpen('xdg-open', [path.dirname(file)], { detached: true, stdio: 'ignore' }).unref();
    }
    return true;
}

module.exports = { ROOT, enqueue, listJobs, cancel, clearFinished, reveal, activeCount };
