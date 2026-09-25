const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');

/**
 * 解析 NFO 元数据文件
 * @param {string} nfoPath NFO文件路径
 * @returns {Object|null} 解析后的元数据对象
 */
function parseNfo(nfoPath) {
    try {
        if (!fs.existsSync(nfoPath)) return null;
        const xml = fs.readFileSync(nfoPath, 'utf8');
        const $ = cheerio.load(xml, { xml: true });

        // 提取核心字段，缺失则留空
        const getText = (selector) => {
            const el = $(selector);
            return el.length ? el.text().trim() : '';
        };

        // 演员列表
        const actors = [];
        $('actor name').each((_, el) => {
            const name = $(el).text().trim();
            if (name) actors.push(name);
        });

        // 标签/类型列表
        const genres = [];
        $('genre, tag').each((_, el) => {
            const name = $(el).text().trim();
            if (name && !genres.includes(name)) genres.push(name);
        });

        return {
            title: getText('title'),
            originalTitle: getText('originaltitle'),
            num: getText('num') || getText('id'),
            maker: getText('maker') || getText('studio'),
            releaseDate: getText('release') || getText('premiered') || getText('year'),
            overview: getText('plot') || getText('outline'),
            director: getText('director'),
            series: getText('set name') || getText('series'),
            label: getText('label'),
            actors,
            genres,
            runtime: parseInt(getText('runtime')) || 0,
            thumb: getText('thumb')
        };
    } catch (e) {
        console.log(`NFO解析失败: ${path.basename(nfoPath)}`, e.message);
        return null;
    }
}

/**
 * 在视频同目录查找封面图
 * @param {string} videoPath 视频文件路径
 * @returns {string|null} 封面图路径
 */
function findLocalCover(videoPath) {
    const dir = path.dirname(videoPath);
    const stem = path.basename(videoPath, path.extname(videoPath));

    // 按优先级查找封面
    const candidates = [
        // 同名封面（OpenAver 默认命名）
        `${stem}.jpg`,
        `${stem}.jpeg`,
        `${stem}.png`,
        // 标准媒体库命名
        `${stem}-poster.jpg`,
        `${stem}-fanart.jpg`,
        // 通用目录封面
        'poster.jpg',
        'folder.jpg',
        'fanart.jpg',
        'cover.jpg'
    ];

    for (const name of candidates) {
        const fullPath = path.join(dir, name);
        if (fs.existsSync(fullPath)) {
            return fullPath;
        }
    }
    return null;
}

/**
 * 生成标准 NFO 元数据文件（兼容 OpenAver / Kodi / Jellyfin）
 * @param {Object} data 影片元数据
 * @param {string} nfoPath 输出 NFO 文件路径
 */
function generateNfo(data, nfoPath) {
    const escapeXml = (str) => {
        if (!str) return '';
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&apos;');
    };

    const title = escapeXml(data.title || '');
    const originalTitle = escapeXml(data.originalTitle || data.title || '');
    const num = escapeXml(data.avid || data.num || '');
    const maker = escapeXml(data.producer || data.maker || '');
    const release = escapeXml(data.releaseDate || '');
    const plot = escapeXml(data.overview || '');
    const director = escapeXml(data.director || '');
    const series = escapeXml(data.serial || data.series || '');
    const runtime = data.duration ? Math.round(data.duration) : 0;
    const thumb = escapeXml(data.posterPath || '');

    // 演员
    const actors = data.actresses || data.actors || [];
    const actorsXml = actors.map(a => {
        const name = escapeXml(typeof a === 'string' ? a : (a.name || ''));
        if (!name) return '';
        return `  <actor>\n    <name>${name}</name>\n  </actor>`;
    }).filter(Boolean).join('\n');

    // 标签
    const genres = data.genres ? (Array.isArray(data.genres) ? data.genres : String(data.genres).split(',')) : [];
    const genresXml = genres.map(g => {
        const name = escapeXml(g.trim());
        return name ? `  <genre>${name}</genre>` : '';
    }).filter(Boolean).join('\n');

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<movie>
  <title>${title}</title>
  <originaltitle>${originalTitle}</originaltitle>
  <num>${num}</num>
  <id>${num}</id>
  <maker>${maker}</maker>
  <studio>${maker}</studio>
  <release>${release}</release>
  <premiered>${release}</premiered>
  <year>${release ? release.substring(0, 4) : ''}</year>
  <director>${director}</director>
  <set>
    <name>${series}</name>
  </set>
  <series>${series}</series>
  <runtime>${runtime}</runtime>
  <plot>${plot}</plot>
  <outline>${plot}</outline>
  <thumb>${thumb}</thumb>
${actorsXml}
${genresXml}
</movie>`;

    const dir = path.dirname(nfoPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(nfoPath, xml, 'utf8');
    return nfoPath;
}

module.exports = { parseNfo, findLocalCover, generateNfo };