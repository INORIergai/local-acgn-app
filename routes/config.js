const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const { configPath, lanInfo } = require('../utils/config');

// 读取配置
function readConfig() {
    return JSON.parse(fs.readFileSync(configPath, 'utf8'));
}

// 写入配置
function writeConfig(cfg) {
    fs.writeFileSync(configPath, JSON.stringify(cfg, null, 4), 'utf8');
}

// 获取完整配置（隐藏敏感字段）
router.get('/', (req, res) => {
    try {
        const cfg = readConfig();
        delete cfg.tmdbApiKey;
        /* 访问密码只回传「开关状态」，绝不回传明文 —— 设置页只需要知道
         * 当前开没开，用来控制那个开关的初始位置。 */
        cfg.auth = {
            enabled: typeof cfg.auth?.enabled === 'boolean'
                ? cfg.auth.enabled
                : !!cfg.auth?.password,
            hasPassword: !!cfg.auth?.password
        };
        res.json({ code: 0, data: cfg });
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
});

// 保存配置
router.post('/', (req, res) => {
    try {
        const newConfig = req.body;
        const currentConfig = readConfig();
        
        // 合并配置，保留tmdbApiKey等敏感字段
        const merged = {
            ...currentConfig,
            ...newConfig,
            tmdbApiKey: currentConfig.tmdbApiKey // 保留API key
        };
        
        // 合并sources，保留baseUrl、cookie等字段
        if (newConfig.sources && currentConfig.sources) {
            merged.sources = { ...currentConfig.sources };
            for (const [key, value] of Object.entries(newConfig.sources)) {
                merged.sources[key] = {
                    ...currentConfig.sources[key],
                    ...value
                };
            }
        }
        
        writeConfig(merged);
        res.json({ code: 0, msg: '保存成功' });
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
});

// 获取指定模块的扫描路径
router.get('/folders/:module', (req, res) => {
    try {
        const { module } = req.params;
        const cfg = readConfig();
        
        let folders = [];
        switch (module) {
            case 'movie':
            case 'jav':
                folders = cfg.scanFolders || [];
                break;
            case 'anime':
                folders = cfg.animeFolders || [];
                break;
            case 'comic':
                folders = cfg.comicFolders || [];
                break;
            case 'novel':
                folders = cfg.novelFolders || [];
                break;
            default:
                return res.json({ code: -1, msg: '未知模块' });
        }
        
        res.json({ code: 0, data: folders });
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
});

// 添加扫描路径到指定模块
router.post('/folders/:module', (req, res) => {
    try {
        const { module } = req.params;
        const { folderPath } = req.body;
        
        if (!folderPath) return res.json({ code: -1, msg: '路径不能为空' });
        
        // 检查路径是否存在
        if (!fs.existsSync(folderPath)) {
            return res.json({ code: -1, msg: '路径不存在' });
        }
        
        const cfg = readConfig();
        
        let folderKey = '';
        switch (module) {
            case 'movie':
            case 'jav':
                folderKey = 'scanFolders';
                break;
            case 'anime':
                folderKey = 'animeFolders';
                break;
            case 'comic':
                folderKey = 'comicFolders';
                break;
            case 'novel':
                folderKey = 'novelFolders';
                break;
            default:
                return res.json({ code: -1, msg: '未知模块' });
        }
        
        if (!cfg[folderKey]) cfg[folderKey] = [];
        
        if (cfg[folderKey].includes(folderPath)) {
            return res.json({ code: -1, msg: '该路径已存在' });
        }
        
        cfg[folderKey].push(folderPath);
        writeConfig(cfg);
        
        res.json({ 
            code: 0, 
            msg: '添加成功，重启服务后生效', 
            data: cfg[folderKey] 
        });
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
});

// 删除指定模块的扫描路径
router.delete('/folders/:module', (req, res) => {
    try {
        const { module } = req.params;
        const { folderPath } = req.body;
        
        const cfg = readConfig();
        
        let folderKey = '';
        switch (module) {
            case 'movie':
            case 'jav':
                folderKey = 'scanFolders';
                break;
            case 'anime':
                folderKey = 'animeFolders';
                break;
            case 'comic':
                folderKey = 'comicFolders';
                break;
            case 'novel':
                folderKey = 'novelFolders';
                break;
            default:
                return res.json({ code: -1, msg: '未知模块' });
        }
        
        cfg[folderKey] = (cfg[folderKey] || []).filter(f => f !== folderPath);
        writeConfig(cfg);
        
        res.json({ 
            code: 0, 
            msg: '删除成功，重启服务后生效', 
            data: cfg[folderKey] 
        });
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
});

// 获取所有模块的扫描路径
router.get('/all-folders', (req, res) => {
    try {
        const cfg = readConfig();
        res.json({
            code: 0,
            data: {
                movie: cfg.scanFolders || [],
                anime: cfg.animeFolders || [],
                comic: cfg.comicFolders || [],
                novel: cfg.novelFolders || []
            }
        });
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
});

// 测试路径是否存在
router.post('/test-path', (req, res) => {
    try {
        const { folderPath } = req.body;
        const exists = fs.existsSync(folderPath);
        const isDir = exists && fs.statSync(folderPath).isDirectory();
        
        res.json({
            code: 0,
            data: {
                exists,
                isDirectory: isDir,
                valid: exists && isDir
            }
        });
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
});

// 获取Cookie配置（只显示是否已设置，不显示完整值）
router.get('/cookies', (req, res) => {
    try {
        const cfg = readConfig();
        const sources = cfg.sources || {};
        
        const result = {};
        
        // Kmoe Cookie
        if (sources.kmoe) {
            const cookie = sources.kmoe.cookie || '';
            result.kmoe = {
                hasCookie: !!cookie,
                cookieLength: cookie.length,
                username: sources.kmoe.username || ''
            };
        }
        
        // 夸克网盘 Cookie
        if (sources.quark) {
            const cookie = sources.quark.cookie || '';
            result.quark = {
                hasCookie: !!cookie,
                cookieLength: cookie.length
            };
        }
        
        res.json({ code: 0, data: result });
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
});

// 更新Cookie
router.post('/cookies/:source', (req, res) => {
    try {
        const { source } = req.params;
        const { cookie } = req.body;
        
        if (!cookie) {
            return res.json({ code: -1, msg: 'Cookie不能为空' });
        }
        
        const cfg = readConfig();
        
        if (!cfg.sources) cfg.sources = {};
        if (!cfg.sources[source]) cfg.sources[source] = {};
        
        cfg.sources[source].cookie = cookie;
        writeConfig(cfg);
        
        res.json({ 
            code: 0, 
            msg: 'Cookie更新成功，重启服务后生效' 
        });
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
});

// 测试Cookie有效性
router.post('/cookies/:source/test', async (req, res) => {
    try {
        const { source } = req.params;
        const cfg = readConfig();
        
        // 优先使用请求体中传入的cookie（用于测试未保存的新cookie）
        // 如果请求体没有，则使用配置文件中已保存的cookie
        const cookie = req.body?.cookie || cfg.sources?.[source]?.cookie || '';
        
        if (!cookie) {
            return res.json({ code: -1, msg: '未设置Cookie' });
        }
        let valid = false;
        let message = '';
        
        if (source === 'kmoe') {
            // 测试Kmoe Cookie
            const { Request } = require('../utils/crawler/base');
            const req = new Request({ cookies: parseCookie(cookie) });
            try {
                const res = await req.get('https://kzo.moe/');
                const html = await res.text();
                valid = html.includes('/u/') || html.includes('主頁');
                message = valid ? 'Cookie有效，已登录' : 'Cookie无效，未登录';
            } catch (e) {
                message = '测试失败: ' + e.message;
            }
        } else if (source === 'quark') {
            // 测试夸克网盘Cookie
            const { Request } = require('../utils/crawler/base');
            const req = new Request({ cookies: parseCookie(cookie) });
            try {
                const res = await req.post('https://drive-pc.quark.cn/1/clouddrive/file/list?pr=ucpro&fr=pc&uc_param_str=&__t=' + Date.now() + '&__dt=1000', 
                    { pdir_fid: '0', page: 1, size: 10 }
                );
                const data = await res.json();
                valid = data.data && data.data.list;
                message = valid ? `Cookie有效，文件数: ${data.data.list.length}` : 'Cookie无效';
            } catch (e) {
                message = '测试失败: ' + e.message;
            }
        } else {
            return res.json({ code: -1, msg: '不支持的数据源' });
        }
        
        res.json({ 
            code: 0, 
            data: { valid, message } 
        });
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
});

// 解析Cookie字符串为对象
function parseCookie(cookieStr) {
    const cookies = {};
    cookieStr.split(';').forEach(pair => {
        const [name, ...valueParts] = pair.trim().split('=');
        if (name) {
            cookies[name.trim()] = valueParts.join('=').trim();
        }
    });
    return cookies;
}

// ========== 浏览器验证相关 API ==========

// 初始化浏览器验证（弹出有窗口浏览器，让用户手动通过CF验证）
router.post('/browser/init-verification', async (req, res) => {
    try {
        const { url } = req.body;
        const userBrowser = require('../utils/crawler/user-browser');
        const result = await userBrowser.initBrowserVerification(url || 'https://hanime1.me');
        res.json({ code: result.success ? 0 : -1, msg: result.message, data: result });
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
});

// 检查浏览器cookie是否有效
router.get('/browser/check-cookie', async (req, res) => {
    try {
        const { url } = req.query;
        const userBrowser = require('../utils/crawler/user-browser');
        const valid = await userBrowser.checkCookieValid(url || 'https://hanime1.me');
        res.json({ code: 0, data: { valid } });
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
});

// 关闭浏览器
router.post('/browser/close', async (req, res) => {
    try {
        const userBrowser = require('../utils/crawler/user-browser');
        await userBrowser.closeBrowser();
        res.json({ code: 0, msg: '浏览器已关闭' });
    } catch (e) {
        res.json({ code: -1, msg: e.message });
    }
});

// 获取局域网访问信息
router.get('/lan-info', (req, res) => {
    // 部署模式：Docker 容器内无法直接唤起宿主机程序，
    // 前端据此决定是否走 lmlplayer:// 协议（本地直跑必须走后端 spawn）
    const isDocker = fs.existsSync('/.dockerenv');
    res.json({
        code: 0,
        data: {
            ...lanInfo(),
            deployment: isDocker ? 'docker' : 'local'
        }
    });
});

module.exports = router;
