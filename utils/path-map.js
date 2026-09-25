/**
 * 容器内路径 <-> Windows 宿主机路径 互转
 *
 * ★ round28/29：Docker 脚手架已退役（archive/docker-retired/），本文件是路径映射表的
 *   **唯一权威副本**（原先与 docker-entrypoint.js 各存一份、要手工保持一致；
 *   那张表已随 docker-entrypoint.js 一起归档）。
 *
 * ★★ 本文件**不能删**：routes/movie.js 与 routes/scanner.js 都 require 它
 *   （`const { toHostPath } = require('../utils/path-map')`）。
 *   exe 场景下 filePath 本来就是 Windows 路径 ⇒ 映射不命中、原样返回，是**无害的死逻辑**；
 *   但删掉文件会变成 `Cannot find module` ⇒ 应用直接起不来。
 */

// 路径映射表（/media/... 容器挂载点 → Windows 盘符；不命中则原样返回，故 exe 下安全）
const pathMappings = [
    { win: 'D:\\Movies', linux: '/media/movies' },
    { win: 'D:\\Movies2', linux: '/media/movies2' },
    { win: 'D:\\Anime', linux: '/media/anime' },
    { win: 'D:\\Comics', linux: '/media/comic' },
    { win: 'D:\\Novels', linux: '/media/novel' },
    { win: 'D:\\Downloads\\Movies', linux: '/media/downloads' }
];

/**
 * 把容器内路径（/media/...）转换为 Windows 宿主机路径（E:\...）
 * @param {string} containerPath 容器内路径
 * @returns {string} Windows 宿主机路径；无法映射时原样返回
 */
function toHostPath(containerPath) {
    if (!containerPath) return '';
    let p = String(containerPath).replace(/\\/g, '/');
    for (const m of pathMappings) {
        const linux = m.linux.replace(/\/+$/, '');
        if (p === linux || p.startsWith(linux + '/')) {
            const rest = p.substring(linux.length).replace(/\//g, '\\');
            return m.win + rest;
        }
    }
    return String(containerPath);
}

/**
 * 把 Windows 宿主机路径（E:\...）转换为容器内路径（/media/...）
 * @param {string} winPath Windows 宿主机路径
 * @returns {string} 容器内路径；无法映射时原样返回
 */
function toContainerPath(winPath) {
    if (!winPath) return '';
    let p = String(winPath);
    for (const m of pathMappings) {
        const win = m.win;
        if (p === win || p.startsWith(win + '\\')) {
            const rest = p.substring(win.length).replace(/\\/g, '/');
            return m.linux + rest;
        }
    }
    return String(winPath);
}

module.exports = { toHostPath, toContainerPath, pathMappings };
