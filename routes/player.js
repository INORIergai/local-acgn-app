// ================================================================
// routes/player.js —— round173g 播放器增强接口
//   GET /api/player/subtitles?path=<视频绝对路径>   扫描同名/子目录字幕
//   GET /api/player/subtitle-file?path=<字幕路径>   读字幕并转 WebVTT
//   ★ 路径一律过 isPathAllowed 白名单（防任意文件读取）；不用裸正则（中文路径坑）
// ================================================================

const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const { isPathAllowed } = require('../utils/path-guard');
const { toVtt } = require('../utils/subtitle-convert');

const SUB_EXT = new Set(['.srt', '.ass', '.ssa', '.vtt']);
const SUB_DIRS = ['', '字幕', 'subs', 'subtitles'];

/** 判断是否为某视频的字幕（同名，或同名 + 语言后缀 .chs/.zh/.sc/.cn 等） */
function isSubFor(base, fileName) {
  const ext = path.extname(fileName).toLowerCase();
  if (!SUB_EXT.has(ext)) return false;
  const stem = path.basename(fileName, path.extname(fileName)).toLowerCase();
  const b = base.toLowerCase();
  if (stem === b) return true;
  return new Set(['.chs', '.zh', '.sc', '.cn', '.zh-cn', '.simplified', '.简', '.简体'])
    .has(stem.slice(b.length)) && stem.startsWith(b);
}

router.get('/subtitles', (req, res) => {
  try {
    const videoPath = decodeURIComponent(String(req.query.path || ''));
    if (!videoPath || !fs.existsSync(videoPath)) return res.json({ code: 0, data: [] });
    if (!isPathAllowed(videoPath)) return res.json({ code: 0, data: [] }); // 不在白名单 → 静默空，不报错打扰
    const dir = path.dirname(videoPath);
    const base = path.basename(videoPath, path.extname(videoPath));
    const found = [];
    const seen = new Set();
    for (const sub of SUB_DIRS) {
      const d = sub ? path.join(dir, sub) : dir;
      if (!fs.existsSync(d)) continue;
      let names = [];
      try { names = fs.readdirSync(d); } catch (e) { continue; }
      for (const n of names) {
        if (!isSubFor(base, n)) continue;
        const full = path.join(d, n);
        if (seen.has(full)) continue;
        seen.add(full);
        found.push({ path: full, name: n, lang: /\.chs|\.sc|\.zh|\.cn|简/.test(n) ? '中文' : (/\.en|\.eng/.test(n) ? '英文' : '默认'), ext: path.extname(n).toLowerCase().slice(1) });
      }
    }
    res.json({ code: 0, data: found });
  } catch (e) { res.json({ code: 0, data: [] }); }
});

router.get('/subtitle-file', (req, res) => {
  try {
    const subPath = decodeURIComponent(String(req.query.path || ''));
    if (!subPath || !fs.existsSync(subPath)) return res.status(404).send('字幕文件不存在');
    if (!isPathAllowed(subPath)) return res.status(403).send('路径不在允许范围');
    if (!SUB_EXT.has(path.extname(subPath).toLowerCase())) return res.status(400).send('不支持的字幕格式');
    const vtt = toVtt(subPath);
    res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.send(vtt);
  } catch (e) { res.status(500).send('字幕转换失败: ' + e.message); }
});

module.exports = router;
