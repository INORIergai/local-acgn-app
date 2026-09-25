/**
 * 容器内路径 <-> Windows 宿主机路径 互转
 *
 * 说明：应用在 Docker（Linux 容器）中运行时，数据库里的文件路径为
 * /media/...（容器内挂载点）；而 PotPlayer、资源管理器等都运行在
 * Windows 宿主机上，需要的是 E:\... 这样的 Windows 路径。
 * 本模块负责两种路径的互相转换（与 docker-entrypoint.js 的映射表保持一致）。
 */

// 路径映射表（与 docker-entrypoint.js 保持一致）
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
