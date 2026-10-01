const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');

router.get('/info', (req, res) => {
    const config = require('../utils/config');
    // 敏感信息过滤，前端不返回API密钥
    const safeConfig = {
        serverPort: config.serverPort,
        scanFolders: config.scanFolders,
        ollamaModel: config.ollama.model
    };
    res.json({ code: 0, data: safeConfig });
});

module.exports = router;