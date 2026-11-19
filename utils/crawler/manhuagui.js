/**
 * utils/crawler/manhuagui.js —— 漫画柜（manhuagui）元数据源
 * ============================================================================
 * 为什么加它：kmoe 站点**不提供剧情简介**（详情页整个 body 搜不到「简介/簡介」），
 * Bangumi 给的是日文原名 + 短摘要，中文读者看着割裂。manhuagui 的详情页有
 * 353 字中文内容简介 + 官方竖版封面，正好补这个洞。
 *
 * 实测（round143）：
 *   - 搜索：GET /s/{关键词}.html → `<a href="/comic/20449/" title="辣妹与我的第一次">`
 *   - 详情：GET /comic/{id}/   → `<p class="hcover"><img src="//cf.mhgui.com/cpic/h/xxxx.jpg">`
 *                                `<div id="intro-all" ...>简介</div>`
 *   - 简繁都能搜（站点自己的检索包含繁简归一）
 *
 * 注意：版权灰色站点，**只取文本元数据与封面地址**，不抓章节图片、不下载正文。
 * ============================================================================
 */
const { Request } = require('./base');

const UA_LANG = { 'Accept-Language': 'zh-CN,zh;q=0.9' };

class ManhuaguiCrawler {
    constructor(options = {}) {
        this.baseUrl = (options.baseUrl || 'https://www.manhuagui.com').replace(/\/+$/, '');
        this.request = new Request({ uaType: 'chrome', headers: UA_LANG });
        this.lastError = '';
    }

    /**
     * 按关键词搜索
     * @returns {Promise<Array<{title:string,url:string,id:string}>>}
     */
    async search(keyword) {
        const kw = String(keyword || '').trim();
        if (kw.length < 2) return [];
        this.lastError = '';
        const url = `${this.baseUrl}/s/${encodeURIComponent(kw)}.html`;
        try {
            const res = await this.request._doFetch(url, { method: 'GET', headers: { Accept: 'text/html' } });
            if (!res.ok) { this.lastError = 'HTTP ' + res.status; return []; }
            const html = await res.text();
            const out = [];
            const seen = new Set();
            const re = /<a[^>]+href="(\/comic\/(\d+)\/)"[^>]*?(?:title="([^"]*)")?[^>]*>([\s\S]{0,80}?)<\/a>/g;
            let m;
            while ((m = re.exec(html))) {
                const id = m[2];
                if (seen.has(id)) continue;
                const title = (m[3] || m[4] || '').replace(/<[^>]+>/g, '').trim();
                if (!title) continue;
                seen.add(id);
                out.push({ id, title, url: `${this.baseUrl}/comic/${id}/` });
                if (out.length >= 10) break;
            }
            return out;
        } catch (e) {
            this.lastError = e.message;
            return [];
        }
    }

    /**
     * 详情：封面 / 简介 / 作者 / 状态 / 题材
     * @param {string} url 详情页 URL
     */
    async getDetail(url) {
        const full = url.startsWith('http') ? url : this.baseUrl + url;
        this.lastError = '';
        try {
            const res = await this.request._doFetch(full, { method: 'GET', headers: { Accept: 'text/html' } });
            if (!res.ok) { this.lastError = 'HTTP ' + res.status; return null; }
            const html = await res.text();

            const pick = (re) => { const m = re.exec(html); return m ? m[1] : ''; };

            // 标题：og:title 优先，其次 <h1>
            let title = pick(/<meta[^>]+property="og:title"[^>]+content="([^"]+)"/i);
            if (!title) title = pick(/<h1[^>]*>([\s\S]*?)<\/h1>/i).replace(/<[^>]+>/g, '').trim();
            title = String(title).replace(/漫画.*$/, '').replace(/[_-]看漫画.*$/, '').trim();

            // 封面：p.hcover > img（协议相对地址要补 https:）
            let cover = pick(/<p[^>]*class="[^"]*hcover[^"]*"[^>]*>[\s\S]{0,120}?<img[^>]+src="([^"]+)"/i);
            if (!cover) cover = pick(/<meta[^>]+property="og:image"[^>]+content="([^"]+)"/i);
            if (cover && cover.startsWith('//')) cover = 'https:' + cover;
            if (cover && cover.startsWith('/')) cover = this.baseUrl + cover;

            // 简介：★ 这个 div 带 style 属性，正则必须写 [^>]*，写死 `<div id="intro-all">` 会读成 0 字
            const introHtml = pick(/<div[^>]+id="intro-all"[^>]*>([\s\S]*?)<\/div>/i);
            const overview = String(introHtml)
                .replace(/<br\s*\/?>/gi, '\n')
                .replace(/<[^>]+>/g, '')
                .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&quot;/gi, '"')
                .replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n')
                .trim();

            /* 作者 / 状态 / 题材 / 别名：页面正文里是「漫画剧情： 爱情 漫画作者： 植野メグル
             * 漫画别名： はじめてのギャル 漫画状态： 已完结」这种连排文本。
             * ★ 别去抓 /list/ 链接当题材 —— 那是**站点全局导航栏**（热血/冒险/魔幻/神鬼/
             * 搞笑/萌系），每部作品都一模一样，写进库等于全库同一组假标签。 */
            const bodyText = html.replace(/<script[\s\S]*?<\/script>/gi, ' ')
                .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

            const grabLine = (label) => {
                const m = bodyText.match(new RegExp(label + '\\s*[:：]\\s*([^:：]{0,60}?)(?=\\s*(?:漫畫|漫画)[^\\s:：]{0,6}[:：]|$)'));
                return m ? m[1].trim() : '';
            };
            const author = grabLine('漫畫作者') || grabLine('漫画作者');
            const status = grabLine('漫畫狀態') || grabLine('漫画状态');
            const alias = grabLine('漫畫別名') || grabLine('漫画别名');

            // 题材：只取「漫画剧情」这一行的词，且过滤掉站点的通用大类名
            const genreLine = grabLine('漫畫劇情') || grabLine('漫画剧情');
            const BLACK = new Set(['全部', '日本', '港台', '欧美', '内地', '韩国', '其它', '已完结', '连载中']);
            const tags = String(genreLine).split(/[\s,、/]+/).map(s => s.trim())
                .filter(t => t.length >= 2 && t.length <= 8 && !BLACK.has(t)).slice(0, 6);

            if (!title && !overview && !cover) return null;
            return { url: full, title, cover, overview, author, status, tags, originalTitle: alias, source: 'manhuagui' };
        } catch (e) {
            this.lastError = e.message;
            return null;
        }
    }
}

module.exports = ManhuaguiCrawler;
