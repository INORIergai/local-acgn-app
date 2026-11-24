/**
 * title-clean.js —— round144：影片标题显示层清洗
 *
 * 库里有 1170 条标题把「番号」当标题开头又写了一遍，形态五花八门：
 *   [PPPD-720]Julia                     ← 方括号包着
 *   ABP-367俺だけの尻コス娘 あやみ旬果     ← 连字符 + 直接粘连
 *   FNS 069兔女郎 / MIDA049尻            ← 空格分隔或干脆无分隔
 *   [SSNI-963]SSNI-963COS               ← 剥一层还藏着一层
 *   [ABP-367](ABP-367)俺だけの…          ← 极少数还把番号写成了 markdown 伪链接
 * 番号本来就有独立字段（卡片角标 / 播放器副标题）显示，标题里再重复一遍既占地方又难看。
 *
 * 与后端 utils/agent/cards.js 的 cleanTitle / stripAvidPrefix 保持**同一套规则**：
 *   - 只在标题确实以「本片番号」开头时才剥，用 avid 做锚点，不做通用正则猜测
 *   - 反复剥到不再以番号开头为止（处理双层），但剥完必须还剩东西
 * 前后端各留一份是为了前端不依赖接口额外字段（列表/详情/播放器拿到的都是原始 movie 对象）。
 * 只清洗**展示副本**，不改数据库里的原值。
 */
(function () {
    'use strict';

    /** markdown 伪链接降级 + 空白压缩 */
    function cleanTitle(t) {
        var s = (t == null ? '' : String(t));
        if (!s) return '';
        s = s.replace(/\[([^\]]+)\]\(([^)]*)\)/g, '$1');
        // 去除 Z-Library 尾缀与重复的作者方括号 (朗达·拜恩 [朗达·拜恩]) 或 ((奥)卡夫卡 [(奥)卡夫卡])
        s = s.replace(/\s*[\(（]Z-Library[\)）]\s*/gi, ' ');
        s = s.replace(/([^\s\[\]]{2,30}?)\s*\[\s*\1\s*\]/g, '$1');
        s = s.replace(/[\(（]\s*([^\(\)（）\[\]]+?)\s*\[\s*\1\s*\]\s*[\)）]/g, '($1)');
        // 去除如 "^[_.\s…]+" 的损坏前缀（例如 "_... (朗达·拜恩)"）
        s = s.replace(/^[_\s.…·\-—]+(?=[(\（\[【\u4e00-\u9fa5A-Za-z0-9])/, '');
        // 若剥完只剩一个外层括号包着作者名，如 "(刘慈欣)" 或 "((奥)卡夫卡)"，转成易读的「作者 · 作品集」
        var onlyParen = /^[\(（]\s*((?:[\(（][^\(\)（）]{1,6}[\)）]\s*)?[^\(\)（）]{2,30})\s*[\)）]$/.exec(s.trim());
        if (onlyParen) {
            s = onlyParen[1].trim() + ' · 作品集';
        }
        s = s.replace(/\s+/g, ' ').trim();
        return s;
    }

    /** 提取书籍/漫画的显式卷号（绝不把 1984 / 140亿年 当成第 1984 卷，无卷号返回空串） */
    function extractVolumeLabel(rawTitle, isNovel) {
        var s = String(rawTitle || '');
        var m1 = /第\s*(\d{1,4}|[一二三四五六七八九十百零〇]+)\s*([卷册部集话回篇])/.exec(s);
        if (m1) return '第 ' + m1[1] + ' ' + m1[2];
        var m2 = /(?:Vol\.?|Volume|Book|Part)\s*(\d{1,3})\b/i.exec(s);
        if (m2) return 'Vol.' + m2[1];
        var m3 = /(?:套装共|全)\s*(\d{1,3}|[一二三四五六七八九十百]+)\s*([册卷部本])/.exec(s);
        if (m3) return '全 ' + m3[1] + ' ' + m3[2];
        return '';
    }

    /** 提取末尾括号里的作者名或格式标签（用于替代原本满屏的「第 ? 卷」） */
    function extractBookSubLabel(item, rawTitle, isNovel) {
        var vol = extractVolumeLabel(rawTitle, isNovel);
        if (vol) return vol;
        var s = String(rawTitle || (item && (item.title || item.fileName)) || '');
        s = s.replace(/\s*[\(（]Z-Library[\)）]\s*$/i, '').replace(/([^\s\[\]]{2,30}?)\s*\[\s*\1\s*\]/g, '$1');
        // 匹配末尾 (作者) 或 ((国别)作者)
        var mAuth = /[\(（]((?:[\(（][^\(\)（）]{1,6}[\)）]\s*)?[^()（）\[\]]{2,18})[\)）]\s*$/.exec(s);
        if (mAuth && !/(精装|珍藏|全集|合集|获奖|系列|插图|修订|简体|繁体|未删减|完整版)/.test(mAuth[1])) {
            return mAuth[1].replace(/^[\[【（(][^\]】）)]+[\]】）)]\s*/, '').trim();
        }
        var fn = String((item && (item.fileName || item.filePath)) || '');
        var ext = (fn.match(/\.([a-z0-9]{2,5})$/i) || ['', ''])[1].toUpperCase();
        if (ext) return ext + ' 典藏';
        return isNovel ? '典藏长卷' : '单行本';
    }

    /** 按 avid 剥掉标题开头粘连的番号前缀 */
    function stripAvidPrefix(title, avid) {
        var a = (avid == null ? '' : String(avid)).replace(/[^0-9a-zA-Z]/g, '').toUpperCase();
        if (!a || a.length < 4) return title;

        var s = String(title == null ? '' : title);
        for (var guard = 0; guard < 4; guard++) {
            var before = s;
            var head = s.replace(/^[\s\[\(【（]+/, '');
            var probe = head.slice(0, a.length + 6).replace(/[^0-9a-zA-Z]/g, '').toUpperCase();
            if (probe.indexOf(a) !== 0) break;

            var idx = 0, cnt = 0;
            var start = s.length - head.length;
            for (idx = start; idx < s.length && cnt < a.length; idx++) {
                if (/[0-9a-zA-Z]/.test(s.charAt(idx))) cnt++;
            }
            var rest = s.slice(idx).replace(/^[\s\]\)】）\-_·:：|]+/, '').trim();
            if (!rest) break;          // 剥完什么都不剩 → 整条就是番号，不该剥
            s = rest;
            if (s === before) break;
        }
        return s || title;
    }

    /** 一站式：传 movie 对象，返回该显示的标题（永不返回空串） */
    function displayTitle(movie) {
        if (!movie) return '';
        var raw = movie.title || movie.fileName || movie.name || '';
        var avid = movie.avid || movie.avidCode || '';
        var out = stripAvidPrefix(cleanTitle(raw), avid);
        return out || cleanTitle(raw) || raw;
    }

    window.cvCleanTitle = cleanTitle;
    window.cvStripAvidPrefix = stripAvidPrefix;
    window.cvDisplayTitle = displayTitle;
    window.cvExtractVolumeLabel = extractVolumeLabel;
    window.cvExtractBookSubLabel = extractBookSubLabel;
})();
