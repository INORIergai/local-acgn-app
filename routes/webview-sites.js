/**
 * 「在线观看」站点注册表 —— 单一事实来源。
 *
 * 拆出来是因为两个模块都要用它：
 *   - routes/webview.js        列表抓取 / 流解析 / 内嵌探测
 *   - routes/webview-proxy.js  整站反向代理
 * 两边共用同一份，避免「代理认得的域名」和「抓取认得的域名」不一致导致白名单漏判。
 *
 * 关于 xfo / direct 两个字段：
 *   direct: true  表示实测容器直连就能 200（不需要宿主代理），且站点只是用 X-Frame-Options
 *                 挡内嵌 —— 这种站**整站反代**就能完美复现，不必上无头浏览器。
 *   direct: false 表示 Cloudflare 挑战页（403 + Just a moment），必须靠真浏览器过盾，
 *                 反代只能作为补充，主力仍是「应用内列表 + 流代理」。
 */

const SITES = {
  dongman: {
    name: '91动漫',
    addrs: [
      'https://284.iffuglfyc.com/',
      'https://9ed.nodgswul.cc/',
      'https://ajwrqqywa.cc/',
      'https://dongmanwang.net/',
      'https://91dongman.net/'            // 官方，直连通常不通，垫底
    ],
    listPath: '/',
    searchPath: '/search/{q}/',
    // 91动漫是 iframe 友好的（可内嵌），不需要反代
    proxy: false
  },
  javbus: {
    name: 'JavBus',
    addrs: ['https://www.javbus.com/', 'https://javbus.com/'],
    listPath: '/',
    searchPath: '/search/{q}',
    proxy: true,
    direct: true
  },
  // jable：Cloudflare 挑战站（HTTP 直连 403 + "Just a moment..."）。
  //   实测**容器里的持久 Chromium profile 已经持有 jable.tv 的有效 cf_clearance**，
  //   渲染时 1.1 秒就能拿到真页面（112KB / 372 个链接），所以走「渲染回退反代」：
  //   服务端用 withBrowser 渲染 -> 取 document.documentElement.outerHTML -> 走同一套改写管线。
  //
  //   【关键：assets-cdn.jable.tv 故意不纳管】
  //   它的静态资源域（app.css 261KB、封面、悬停预览 mp4）同样被 Cloudflare 保护，
  //   但**浏览器自己带着 cf_clearance 直连是 200**（实测 context.request.get 三个样本全部 200）。
  //   所以正确做法是**原样保留绝对地址、让浏览器直连**：
  //     - 省掉大量带宽（不用每张封面都过一遍我们的服务端）
  //     - 避开 CORS（页面内 fetch 跨域会 Failed to fetch，但 <link>/<img>/<video> 不受限）
  //   把它加进 site.cdn 反而会坏事：代理侧 HTTP 取是 403，等于把能加载的资源改坏。
  jable: {
    name: 'Jable',
    addrs: ['https://jable.tv/'],
    listPath: '/new-release/',
    pageStyle: 'path',
    searchPath: '/search/{q}/',
    proxy: true,
    direct: false,
    // 必须靠真浏览器渲染才能拿到 HTML（cf-mitigated: challenge）
    render: true,
    categories: [
      { name: '最新', path: '/new-release/' },
      { name: '热门', path: '/hot/' },
      { name: '中文字幕', path: '/tags/chinese-subtitle/' }
    ]
  },
  // hanime1：同样是 CF 挑战站，但**渲染也过不去**（实测连续 3 次都是 403 +
  //   "Attention Required! | Cloudflare"，cf_clearance 存在但被 CF 判为硬拦截）。
  //   这种只能靠人在真浏览器里点一次人机验证，属于产品层决策，不在反代范围内。
  //   所以 proxy:false —— 保留应用内列表模式，不假装能整站复现。
  hanime1: {
    name: 'Hanime1',
    addrs: ['https://hanime1.me/'],
    listPath: '/',
    searchPath: '/search?query={q}',
    proxy: false,
    direct: false
  },
  // javmenu：真实分类路径（从站点导航实测得到的，不是猜的）；
  //          搜索走 /search?q= 会跳回首页（实测无效），所以不配 searchPath。
  //          实测直连 200 + X-Frame-Options: SAMEORIGIN → 整站反代的理想目标。
  javmenu: {
    name: 'JavMenu',
    addrs: ['https://javmenu.com/'],
    listPath: '/LATEST-UPDATES',
    pageStyle: 'query',
    proxy: true,
    direct: true,
    categories: [
      { name: '最新', path: '/LATEST-UPDATES' },
      { name: '有码', path: '/censored' },
      { name: '无码', path: '/uncensored' },
      { name: '欧美', path: '/western' },
      { name: 'FC2', path: '/fc2' },
      { name: '动漫', path: '/hanime' },
      { name: '中文字幕', path: '/chinese' },
      { name: '日榜', path: '/rank/censored/day' }
    ]
  },
  // netflav：卡片是 [class*="grid_"][class*="cell"]，封面 .grid_0_cover，标题 .grid_0_title。
  //          注意：首页 / 用**虚拟列表**（DOM 里只保留视口内的十几个 cell，实测滚动到底也只有 5~13 个），
  //          不适合一次性抓取；/all 是普通网格（实测稳定 20 条），所以列表页指向 /all。
  //          搜索参数是 keyword（实测有效）。直连 200 + SAMEORIGIN → 可整站反代。
  //          Next.js 站点，资源走 /_next/static（根相对），重写要照顾到。
  netflav: {
    name: 'Netflav',
    addrs: ['https://netflav.com/'],
    listPath: '/all',
    searchPath: '/search?keyword={q}',
    proxy: true,
    direct: true,
    categories: [
      { name: '全部', path: '/all' },
      { name: '无码', path: '/uncensored' },
      { name: '首页', path: '/' }
    ]
  },
  // onejav：首页是缩略图墙（a.thumbnail-link），搜索/热门页是 .card 列表（结构不同，见 SCENE_SELECTORS）
  //         直连 200 + X-Frame-Options: DENY → 可整站反代。
  //         特殊：封面大量走第三方 CDN（pics.dmm.co.jp / contents-thumbnail2.fc2.com / image.mgstage.com），
  //         这些不劫持（劫持了会把流量压到本服务上），靠浏览器直连即可。
  //         与 javbus/netflav/javmenu 一样，域名在本机 DNS 被污染，必须走宿主代理。
  onejav: {
    name: 'OneJAV',
    addrs: ['https://onejav.com/'],
    listPath: '/',
    searchPath: '/search/{q}',
    proxy: true,
    direct: true,
    categories: [
      { name: '首页', path: '/' },
      { name: '最新', path: '/new' },
      { name: '女优', path: '/actresses' }
    ]
  },
  porndude: {
    name: 'ThePornDude',
    addrs: ['https://theporndude.com/zh', 'https://theporndude.com/'],
    // ★ 第 19 轮：由「直接内嵌」改为「整站反代」。
    //   原来 proxy:false ⇒ 前端走 fillPaneFrame，iframe 直接指向 https://theporndude.com/zh，
    //   是**跨站外链**：本机 DNS 被污染时用户侧只会白屏，而且页面里的链接一跳就出应用。
    //   实测反代端点 /porndude/ 返回 200（650KB 真页面），所以整站模式是可行且更好的选择。
    //   entryPath：站点中文首页在 /zh（addrs 里的路径会被 normalizeOrigin 吃掉，靠它落回中文页）。
    proxy: true,
    direct: true,
    entryPath: '/zh'
  },
  // javcl：用户反馈播放不了，已下掉

  // ================= 第 16 轮：补齐「动漫 / 漫画 / 里番」三个板块的站点 =================
  // 板块归属由 webview.js 的 BOARD_OF 统一声明（这里只描述站点本身）。
  //
  // 下面这一批实测**没有任何 X-Frame-Options、也没有 CSP frame-ancestors**
  // ⇒ 直接 iframe 内嵌即可完美复现（登录/翻页/搜索/播放都在 iframe 里跑），不需要反代。
  cycanime: {
    name: '次元城动画',
    addrs: ['https://www.cycanime.com/', 'https://cycanime.com/'],
    listPath: '/',
    proxy: false
  },
  // 「kmoe」系列：同一套站群，主站 + 多个镜像（镜像内容一致，逐个探测挑通的）
  moxmoe: {
    name: 'Kmoe漫画',
    addrs: ['https://mox.moe/', 'https://kox.moe/', 'https://kxx.moe/', 'https://kzo.moe/', 'https://kzz.moe/'],
    listPath: '/',
    proxy: false
  },
  komiic: {
    name: 'Komiic',
    addrs: ['https://komiic.com/'],
    listPath: '/',
    proxy: false
  },
  wenku8: {
    name: '轻小说文库',
    addrs: ['https://www.wenku8.net/', 'https://wenku8.net/'],
    listPath: '/',
    proxy: false
  },
  // 漫画柜：实测 X-Frame-Options: DENY → 必须走整站反代
  manhuagui: {
    name: '漫画柜',
    addrs: ['https://www.manhuagui.com/'],
    listPath: '/update/',
    proxy: true,
    direct: true
  },
  // Hanime.tv：实测 XFO: SAMEORIGIN + CSP → 走整站反代（普通 HTTP 可取，不需要无头浏览器）
  hanimetv: {
    name: 'Hanime.tv',
    addrs: ['https://hanime.tv/'],
    listPath: '/browse',
    proxy: true,
    direct: true
  }
};

/**
 * 各站的列表卡片选择器（服务端拼好再下发给浏览器执行，避免前端注入脚本）。
 * linkSel 为 null 表示卡片本身就是链接（onejav 的 a.thumbnail-link）。
 * titleSel 指定标题节点；不配就用卡片文本兜底。
 */
const LIST_SELECTORS = {
  jable: { cardSel: '.video-img-box', linkSel: 'a[href*="/videos/"]' },
  hanime1: { cardSel: 'a[href*="/watch"]', linkSel: null },
  // 91动漫的卡片：首页/分类页都是 .dm-card，漫画是 .dm-card--comic（排掉）
  dongman: { cardSel: '.dm-card:not(.dm-card--comic)', linkSel: 'a' },
  // javmenu：卡片内有两个 img —— 第一个是水印（alt="watermark"，button_logo.png），
  //          真封面是第二个（alt=番号，src=666.9989641.xyz/.../vod.jpg）。所以必须按 alt 排掉水印。
  javmenu: { cardSel: '.video-list-item', linkSel: 'a[href]', imgSel: 'img:not([alt="watermark"])' },
  // netflav：cell 里有多个 img —— 封面是 .grid_0_cover，另一个是 data:svg 的预览图标。
  //          必须指名封面，否则懒加载的格子会取到预览图标（实测 60 格里 53 格取错）。
  netflav: {
    cardSel: '[class*="grid_"][class*="cell"]',
    linkSel: 'a[href*="/video"]',
    imgSel: 'img.grid_0_cover',
    titleSel: '.grid_0_title'
  },
  // onejav：缩略图链接自己就是卡片；标题在它的直接子节点 .thumbnail-text（不是祖先，往上找会拿到空）
  onejav: { cardSel: 'a.thumbnail-link', linkSel: null, titleSel: '.thumbnail-text' }
};

/**
 * 搜索页/分类页可能与首页结构不同，允许按站点 + 场景覆盖选择器。
 * 例：onejav 首页是缩略图墙（a.thumbnail-link），但 /search/xxx 是 .card 列表布局。
 * key 形如 'onejav:search' / 'onejav:cat'；查不到就回退到 LIST_SELECTORS[key]。
 */
const SCENE_SELECTORS = {
  'onejav:search': { cardSel: '.card', linkSel: 'a[href*="/torrent/"]', imgSel: 'img.image', titleSel: 'h5.title' },
  'onejav:cat': { cardSel: '.card', linkSel: 'a[href*="/torrent/"]', imgSel: 'img.image', titleSel: 'h5.title' }
};

/** 所有注册地址的域名都算白名单（含镜像），不用单独维护一份 */
function hostAllowed(host) {
  const h = String(host || '').toLowerCase().replace(/^www\./, '');
  for (const s of Object.values(SITES)) {
    for (const a of s.addrs) {
      try {
        const d = new URL(a).hostname.replace(/^www\./, '');
        if (h === d || h.endsWith('.' + d)) return true;
      } catch (e) { /* 地址写错就跳过 */ }
    }
  }
  return false;
}

module.exports = { SITES, LIST_SELECTORS, SCENE_SELECTORS, hostAllowed };
