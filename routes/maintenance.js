/**
 * round37 · 维护接口：封面缓存盘点 / 清理 / 回收站
 *
 * 用户实测提出：cache/posters 越用越大（1.84GB 里 1.36GB 是没有任何影片引用的旧封面）。
 * 这里给前端一个可见、可控的入口，避免只能靠手工删 AppData。
 *
 *   GET  /api/maintenance/poster-cache        盘点（缓存现状 + 孤儿 + 回收站）
 *   POST /api/maintenance/poster-gc           清理孤儿 {mode:'quarantine'|'delete', minAgeHours, limit}
 *   POST /api/maintenance/poster-trash        {action:'purge'|'restore'}
 */

const express = require('express');
const router = express.Router();
const gc = require('../utils/poster-gc');

router.get('/poster-cache', (req, res) => {
    try {
        const scan = gc.scanOrphans();
        res.json({
            code: 0,
            data: {
                dir: scan.dir,
                files: scan.files,
                totalBytes: scan.totalBytes,
                totalHuman: scan.totalHuman,
                referenced: scan.referenced,
                missingCount: scan.missingCount,
                orphanCount: scan.orphanCount,
                orphanBytes: scan.orphanBytes,
                orphanHuman: scan.orphanHuman,
                trash: gc.trashInfo()
            }
        });
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
});

router.post('/poster-gc', (req, res) => {
    try {
        const body = req.body || {};
        if (body.mode && !['quarantine', 'delete'].includes(body.mode)) {
            return res.json({ code: -1, msg: 'mode 只能是 quarantine 或 delete' });
        }
        const r = gc.gc(body);
        res.json({ code: 0, msg: `已清理 ${r.done} 个孤儿封面（${r.human}）`, data: r });
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
});

router.post('/poster-trash', (req, res) => {
    try {
        const action = (req.body || {}).action;
        if (action === 'purge') {
            const r = gc.purgeTrash();
            return res.json({ code: 0, msg: `回收站已清空，释放 ${r.human}`, data: r });
        }
        if (action === 'restore') {
            const r = gc.restoreTrash();
            return res.json({ code: 0, msg: `已还原 ${r.restored} 个文件`, data: r });
        }
        res.json({ code: -1, msg: 'action 只能是 purge 或 restore' });
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
});

module.exports = router;
