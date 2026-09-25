/**
 * 女优头像 / 档案刮削器
 * ------------------------------------------------------------
 * 数据源：javbus（`/searchstar/{name}` 一次请求即可同时拿到头像 URL 与 starId；
 *         影片详情页的 `.avatar-box` 也自带头像，可「搭车」免费获取）
 *         javdb（女优页无头像，仅用于交叉确认 starId，暂不启用）
 *
 * 设计要点：
 *  - 头像是图片，必须落到本地磁盘，不能只存外链（javbus 图片有 Referer 防盗链，
 *    浏览器直连会 403）。落盘到 data/avatars/{hash}.jpg，库里存 /avatars/xxx.jpg
 *  - 文件名用「女优名」的哈希，天然幂等：重复刮削不会堆积垃圾文件
 *  - 带 Referer 下载（javbus 防盗链），复用 base.js 的 downloadImage
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Request, downloadImage } = require('./base');
const config = require('../config');

const AVATAR_DIR = path.join(__dirname, '..', '..', 'data', 'avatars');

function getJavBusBase() {
  const src = config.sources?.javbus;
  return src?.mirror || src?.baseUrl || 'https://www.javbus.com';
}

/** 女优名 → 稳定的本地文件名（同名必同文件，重复刮削不产生垃圾） */
function avatarFileName(name) {
  const h = crypto.createHash('md5').update(String(name).trim()).digest('hex').substring(0, 16);
  return `${h}.jpg`;
}

/** 把远程头像 URL 补全为绝对地址 */
function absolutize(url, base) {
  if (!url) return '';
  if (url.startsWith('http')) return url;
  return base.replace(/\/$/, '') + (url.startsWith('/') ? url : '/' + url);
}

/**
 * 按女优名在 javbus 搜索，返回 { starId, avatar, name, rawList }
 */
async function searchStarByName(name) {
  const base = getJavBusBase();
  const req = new Request({ uaType: 'safari' });

  try {
    const $ = await req.getHtml(`${base}/searchstar/${encodeURIComponent(name)}`);

    // javbus 的搜索结果里，有碼/無碼/歐美 三个分类入口也走 /star/ 前缀，
    // 需要排除掉，只保留真实女优（判据：链接里带 img 头像）
    const hits = [];
    $('a[href*="/star/"]').each((_, a) => {
      const href = $(a).attr('href') || '';
      const img = $(a).find('img').attr('src') || '';
      const m = href.match(/\/star\/([\w]+)/);
      if (!m || !img) return;
      hits.push({
        starId: m[1],
        avatar: absolutize(img, base),
        // 搜索结果文本形如「葵つかさ有碼」，去掉「有碼/無碼/歐美」后缀
        name: $(a).text().trim().replace(/(有碼|無碼|歐美)$/, '').trim(),
      });
    });

    // 精确匹配优先，否则退回第一个
    const exact = hits.find(h => h.name === name);
    return exact || hits[0] || null;
  } catch (e) {
    if (!/404/.test(e.message)) {
      console.log(`[女优头像] 搜索失败 [${name}]:`, e.message);
    }
    return null;
  }
}

/**
 * 刮削单个女优的完整档案（头像 + 生日/身高/三围等）
 * @param {string} name 女优名
 * @returns {Object|null} { avatarFile, birthday, height, bust, waist, hip, hobby }
 */
async function fetchActressProfile(name) {
  const base = getJavBusBase();
  const hit = await searchStarByName(name);
  if (!hit) return null;

  const out = { starId: hit.starId, name: hit.name, avatarFile: '', birthday: '', height: 0, bust: '', waist: '', hip: '', cup: '', hobby: '' };

  // 1. 下载头像（带 Referer 绕防盗链）
  if (hit.avatar) {
    try {
      if (!fs.existsSync(AVATAR_DIR)) fs.mkdirSync(AVATAR_DIR, { recursive: true });
      const fileName = avatarFileName(name);
      const savePath = path.join(AVATAR_DIR, fileName);
      // 已存在就跳过（幂等，避免重复下载）
      if (fs.existsSync(savePath) && fs.statSync(savePath).size > 1024) {
        out.avatarFile = `/avatars/${fileName}`;
      } else {
        await downloadImage(hit.avatar, savePath, base + '/');
        if (fs.existsSync(savePath) && fs.statSync(savePath).size > 1024) {
          out.avatarFile = `/avatars/${fileName}`;
        }
      }
    } catch (e) {
      console.log(`[女优头像] 下载失败 [${name}]:`, e.message);
    }
  }

  // 2. 进女优详情页补档案字段（这一跳是可选的，失败不影响头像）
  try {
    const req = new Request({ uaType: 'safari' });
    const $ = await req.getHtml(`${base}/star/${hit.starId}`);
    const info = $('.avatar-box .photo-info').first();
    if (info.length) {
      info.find('p').each((_, p) => {
        const t = $(p).text().trim();
        const num = (s) => { const m = s.match(/([\d.]+)/); return m ? m[1] : ''; };
        if (/生日/.test(t)) out.birthday = (t.match(/(\d{4}-\d{2}-\d{2})/) || [])[1] || '';
        else if (/身高/.test(t)) out.height = parseInt(num(t)) || 0;
        else if (/胸圍|胸围/.test(t)) out.bust = num(t);
        else if (/腰圍|腰围/.test(t)) out.waist = num(t);
        else if (/臀圍|臀围/.test(t)) out.hip = num(t);
        else if (/愛好|爱好/.test(t)) out.hobby = t.replace(/^[^:：]*[:：]\s*/, '').trim();
      });
      // 罩杯：javbus 女优页一般没有独立罩杯字段，从名字旁的尺寸推不出来就留空
    }
  } catch (e) {
    // 详情页失败只记日志，头像已经拿到就够了
  }

  return out;
}

/**
 * 从影片详情页「搭车」提取女优头像（零额外请求）
 * 影片页的 .avatar-box 里每个演员一张头像
 * @param {CheerioAPI} $ 影片详情页
 * @param {string} base
 * @returns {Array<{name, avatar}>}
 */
function extractActressAvatarsFromMoviePage($, base) {
  const out = [];
  const seen = new Set();
  $('.avatar-box').each((_, box) => {
    const img = $(box).find('img');
    const name = (img.attr('title') || '').trim();
    const src = (img.attr('src') || '').trim();
    if (!name || !src || seen.has(name)) return;
    seen.add(name);
    out.push({ name, avatar: absolutize(src, base) });
  });
  return out;
}

module.exports = {
  AVATAR_DIR,
  avatarFileName,
  searchStarByName,
  fetchActressProfile,
  extractActressAvatarsFromMoviePage,
};
