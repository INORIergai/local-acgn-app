const express = require('express');
const router = express.Router();

// 后续扩展标签增删改查，先占位
router.get('/', (req, res) => {
    res.json({ code: 0, data: [] });
});

module.exports = router;