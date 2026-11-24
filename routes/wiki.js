// ================================================================
// routes/wiki.js —— 萌娘百科资料页
//   GET /api/wiki/search?q=      标题/全文搜索（主站 opensearch + 镜像全文）
//   GET /api/wiki/page?title=    清洗后的正文 + 章节 + 封面
//
// 正文在服务端清洗（见 utils/wiki.js），前端只排版；镜像全挂时自动降级为
// 主站 extracts 导语（仍按段落转义，不注入远程 HTML）。
// ================================================================
const express = require('express');
const router = express.Router();
const wiki = require('../utils/wiki');

router.get('/search', async (req, res) => {
    try {
        const q = String(req.query.q || '').trim();
        if (!q) return res.json({ code: 0, data: { query: '', items: [] } });
        const items = await wiki.search(q);
        res.json({ code: 0, data: { query: q, items } });
    } catch (e) { res.json({ code: -1, msg: e.message }); }
});

router.get('/page', async (req, res) => {
    const title = String(req.query.title || '').trim();
    if (!title) return res.json({ code: -1, msg: '缺少条目名' });
    try {
        const data = await wiki.page(title);
        res.json({ code: 0, data });
    } catch (e) {
        try {
            const data = await wiki.pageFallback(title);
            res.json({ code: 0, data, msg: '镜像不可达，仅显示导语：' + (e.message || '') });
        } catch (e2) {
            res.json({ code: -1, msg: (e && e.message) || (e2 && e2.message) || '取正文失败' });
        }
    }
});

module.exports = router;
