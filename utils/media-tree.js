/**
 * 媒体库文件夹树构建工具
 * 用于漫画/小说：扫描到的文件按所在子文件夹递归分组展示，
 * 文件名过于通用（如 1.epub）时用文件夹名作为展示标题兜底。
 */

const path = require('path');

/**
 * 判断文件名是否"通用无意义"（数字、单字、占位符等）
 * 这类文件应该用其所在文件夹名来展示。
 */
function isGenericFileName(fileName) {
  const stem = path.basename(fileName, path.extname(fileName)).trim();
  if (!stem) return true;
  // 纯数字 / 纯数字加标点 / 单字
  if (/^[\d\s:：.．\-_～~·、]+$/.test(stem)) return true;
  if (stem.length <= 1) return true;
  // 常见占位
  if (/^(正文|封面|目录|index|cover|part\d*|ch\.?\d*|page\d*|第\d+[话回卷章集部篇]?)$/i.test(stem)) return true;
  return false;
}

/**
 * 从配置的根目录列表中计算文件相对路径
 * @param {string} filePath 文件绝对路径
 * @param {string[]} roots 配置的根目录（如 comicFolders / novelFolders）
 * @returns {string} 相对根目录的路径（目录 + 文件名），找不到根则返回原路径
 */
function relativePath(filePath, roots) {
  const fp = filePath.replace(/\\/g, '/');
  const normalizedRoots = (roots || []).map(r => r.replace(/\\/g, '/').replace(/\/+$/, ''));
  for (const root of normalizedRoots) {
    if (fp.toLowerCase().startsWith(root.toLowerCase() + '/') || fp.toLowerCase() === root.toLowerCase()) {
      return fp.slice(root.length).replace(/^\/+/, '');
    }
  }
  // 不在任何配置根下，用原文件名
  return fp.split('/').pop() || fp;
}

/**
 * 构建文件夹树
 * @param {Array} movies 影片记录（含 filePath / fileName / title 等）
 * @param {string[]} roots 配置的根目录
 * @returns {Object} 树节点 { name, path, children:[], items:[] }
 */
function buildTree(movies, roots) {
  const rootNode = { name: '', path: '', children: [], items: [] };

  for (const m of movies) {
    const rel = relativePath(m.filePath, roots);
    const segments = rel.split('/').filter(Boolean);
    const fileName = segments.pop() || m.fileName || m.title || '';
    let node = rootNode;
    let curPath = '';
    for (const seg of segments) {
      curPath = curPath ? curPath + '/' + seg : seg;
      let child = node.children.find(c => c.name === seg);
      if (!child) {
        child = { name: seg, path: curPath, children: [], items: [] };
        node.children.push(child);
      }
      node = child;
    }
    // 展示标题：文件通用名时用"最近一层有意义的文件夹名"
    // 规则：优先用路径第一段（系列/作品名），若只有一层则用该层文件夹名
    let displayTitle = m.title || m.fileName || fileName;
    const folderChain = segments;
    const topFolder = folderChain[0] || '';
    const leafFolder = node.name || '';
    if (!m.title || isGenericFileName(fileName) || (m.title === path.basename(fileName, path.extname(fileName)))) {
      displayTitle = topFolder || leafFolder || displayTitle;
    }
    node.items.push({ ...m, displayTitle, relPath: rel, folderName: topFolder || leafFolder });
  }

  // 递归排序：文件夹按名称自然排序，条目按文件名自然排序
  const sortNode = (n) => {
    n.children.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN', { numeric: true }));
    n.items.sort((a, b) => (a.fileName || '').localeCompare(b.fileName || '', 'zh-Hans-CN', { numeric: true }));
    n.children.forEach(sortNode);
  };
  sortNode(rootNode);
  return rootNode;
}

/**
 * 将树展开为"非空目录分组"列表（扁平，方便前端渲染）
 * @returns {Array} [{ path, name, items, level }]
 */
function flattenTree(rootNode) {
  const groups = [];
  const walk = (node, level) => {
    if (node.items.length > 0) {
      groups.push({ path: node.path, name: node.name || '根目录', level, items: node.items });
    }
    node.children.forEach(c => walk(c, level + 1));
  };
  walk(rootNode, 0);
  return groups;
}

module.exports = { buildTree, flattenTree, isGenericFileName, relativePath };
