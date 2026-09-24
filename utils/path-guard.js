/**
 * 路径白名单守卫
 *
 * /api/movie/stream、海报等接口此前接受任意本地路径，配合无鉴权状态
 * 等于局域网任意文件读取。这里统一校验：目标路径必须落在 config.json
 * 登记的扫描目录（四库）或海报缓存目录内，否则拒绝访问。
 *
 * Docker 模式下数据库存的是 /media/* 容器路径，而 config.docker.json
 * 的扫描目录本身就是容器路径，因此同一套校验两种部署方式通用。
 */
const fs = require('fs');
const path = require('path');
const config = require('./config');

function normalize(p) {
    return path.resolve(String(p || ''));
}

/** 收集所有允许访问的根目录 */
function allowedRoots() {
    const roots = [
        ...(config.scanFolders || []),
        ...(config.animeFolders || []),
        ...(config.comicFolders || []),
        ...(config.novelFolders || [])
    ];
    if (config.posterCacheDir) roots.push(config.posterCacheDir);
    return roots.map(r => normalize(r));
}

/**
 * 判断文件路径是否在允许的扫描目录内
 * @param {string} filePath 待校验的绝对路径
 * @returns {boolean}
 */
function isPathAllowed(filePath) {
    if (!filePath) return false;
    const target = normalize(filePath);
    return allowedRoots().some(root => {
        const r = root.endsWith(path.sep) ? root : root + path.sep;
        return target === root || target.startsWith(r);
    });
}

/**
 * 校验路径并返回布尔，同时要求文件真实存在
 */
function isReadableMediaPath(filePath) {
    try {
        if (!isPathAllowed(filePath)) return false;
        return fs.existsSync(filePath) && fs.statSync(filePath).isFile();
    } catch (e) {
        return false;
    }
}

module.exports = { isPathAllowed, isReadableMediaPath, allowedRoots };
