/* ============================================================
   午夜场 · 光栅帧图标系统 (Aperture Frames)
   ------------------------------------------------------------
   设计主张：不做通用象形图标。用「不均匀描边 + 刻意断口 +
   少量实心块」模拟放映机光栅扫过胶片帧的质感。
   规格：24 网格 / 正文描边 1.6 / 强调描边 1.2 或 2.2（有意不齐）
   端点：round cap + round join（保留手绘温度）
   断口：每个图标 1-2 处 3-5px 缺口，让线条"呼吸"
   实心：每图标至多 1 块实心（充当光源/焦点）
   颜色：全部用 currentColor，渐变由外层 CSS 注入
   ============================================================ */
(function () {
  'use strict';

  // 每个图标：viewBox 0 0 24 24，stroke=currentColor，fill=none
  // data-solid 标记内含实心块（需要单独着色时用）
  var ICONS = {

    /* ---------- 推荐组 ---------- */
    // 猜你喜欢：星芒用断续线，中心实心点当"灵感火花"
    spark: '<path d="M12 3.2v4.1" stroke-width="1.4"/><path d="M12 16.7v4.1" stroke-width="1.4"/><path d="M3.2 12h4.1" stroke-width="1.4"/><path d="M16.7 12h4.1" stroke-width="1.4"/><path d="M6.1 6.1l2.6 2.6" stroke-width="1.2"/><path d="M15.3 15.3l2.6 2.6" stroke-width="1.2"/><path d="M17.9 6.1l-2.6 2.6" stroke-width="1.2"/><path d="M8.7 15.3l-2.6 2.6" stroke-width="1.2"/><circle cx="12" cy="12" r="2.1" fill="currentColor" stroke="none"/>',

    // 热门排行：单株火苗，右侧留一道断口让火焰"舔"出去，底部实心底座当燃料
    flame: '<path d="M12 21.4c-3.5 0-6.2-2.6-6.2-5.9 0-2.4 1.6-4.2 3-5.9 1.5-1.8 2.6-3.4 2.6-5.6 2.6 1.6 4.4 4 4.4 6.1 0 1-.4 1.8-1 2.4-.9-.3-1.5-1-1.8-1.9-.8 1.2-1.2 2.6-1.2 4 0 1.5.7 2.7 1.8 3.5.6-.6 1-1.4 1.2-2.3 1.7 1.1 2.8 2.9 2.8 4.9" stroke-width="1.7"/><path d="M12 21.4c1.6 0 2.9-1.2 2.9-2.7 0-1.4-1.1-2.3-2.9-4.1-1.8 1.8-2.9 2.7-2.9 4.1 0 1.5 1.3 2.7 2.9 2.7z" fill="currentColor" stroke="none"/>',

    // 随机推荐：交叉箭头的断口在中心留空，像洗牌瞬间
    shuffle: '<path d="M3.4 7.2h3.9l5.2 9.6h4" stroke-width="1.6"/><path d="M13.4 7.2h3.1" stroke-width="1.6"/><path d="M3.4 16.8h3.9" stroke-width="1.6"/><path d="M13.6 16.8h3.9" stroke-width="1.6"/><path d="M17.4 4.9l3 2.3-3 2.3" stroke-width="1.5"/><path d="M17.4 14.5l3 2.3-3 2.3" stroke-width="1.5"/>',

    // 未观看：瞳仁用实心，外圈留断口 —— "还没看进去"
    eye: '<path d="M2.8 12c2.7-3.8 5.6-5.7 9.2-5.7s6.4 1.9 9.2 5.7" stroke-width="1.6"/><path d="M4.2 14.6c2.2 2.4 4.8 3.6 7.8 3.6s5.6-1.2 7.8-3.6" stroke-width="1.6"/><circle cx="12" cy="12" r="2.4" fill="currentColor" stroke="none"/>',

    /* ---------- 分类导航 ---------- */
    // 全部影片：胶片格，齿孔用短横线断口表现
    reel: '<rect x="3" y="5.2" width="18" height="13.6" rx="2.2" stroke-width="1.6"/><path d="M7.6 5.2v3.4M12 5.2v3.4M16.4 5.2v3.4" stroke-width="1.2"/><path d="M7.6 15.4v3.4M12 15.4v3.4M16.4 15.4v3.4" stroke-width="1.2"/><path d="M3 12h1.8M19.2 12H21" stroke-width="1.6"/>',

    // 影片库：竖置 35mm 单帧胶片，左右齿孔轨；与 fullscreen 四角框 / reel 横置胶片区分
    frame: '<rect x="5.6" y="3.2" width="12.8" height="17.6" rx="2" stroke-width="1.6"/><path d="M8.2 5.6v1.4M8.2 9.4v1.4M8.2 13.2v1.4M8.2 17v1.4" stroke-width="1.1"/><path d="M15.8 5.6v1.4M15.8 9.4v1.4M15.8 13.2v1.4M15.8 17v1.4" stroke-width="1.1"/>',

    // 动漫库： manga 式拖尾速度线（左）+ 大实心核（右下偏置），与 spark 的对称放射彻底区分
    anime: '<path d="M3 6.4h7.4" stroke-width="1.6"/><path d="M2.6 10.8h5.2" stroke-width="1.4"/><path d="M4 15.2h3.4" stroke-width="1.2"/><path d="M13.8 5.2l2-2" stroke-width="1.3"/><path d="M18.2 8.2l2.6-1.4" stroke-width="1.2"/><circle cx="14.8" cy="13.6" r="3.4" fill="currentColor" stroke="none"/>',

    // 漫画库：分镜框 + 气泡对话（实心尾巴），与 grid 四宫格彻底区分
    comic: '<rect x="3" y="5.6" width="12.6" height="12.8" rx="2" stroke-width="1.7"/><circle cx="17.4" cy="7.2" r="3.5" stroke-width="1.5"/><path d="M15.9 10.2l-1.7 2.6 3.1-1.3z" fill="currentColor" stroke="none"/><path d="M5.8 10.6h5.6" stroke-width="1.3"/><path d="M5.8 14.2h3.9" stroke-width="1.3"/>',

    // 小说库：书脊 + 两行书页线，右页留断口
    book: '<path d="M4.6 4.4h9.2a3 3 0 0 1 3 3v12.2" stroke-width="1.7"/><path d="M16.8 7.4h2.6v12.2" stroke-width="1.5"/><path d="M4.6 4.4v15.2" stroke-width="1.9"/><path d="M7.6 9.2h6.2M7.6 13h4.4" stroke-width="1.3"/>',

    // 我的收藏：五角星改为"折角书签+实心点"，避开通用星形
    bookmark: '<path d="M6.4 3.6h8.2a2.4 2.4 0 0 1 2.4 2.4v14.4l-4.3-3.1" stroke-width="1.7"/><path d="M6.4 3.6a2.4 2.4 0 0 0-2.4 2.4v14.4l6.3-4.5" stroke-width="1.7"/><circle cx="12.2" cy="10.4" r="1.9" fill="currentColor" stroke="none"/>',

    // 最近观看：指针是断开的，加一段弧形轨迹强调"刚刚"
    clock: '<path d="M20.6 12a8.6 8.6 0 1 1-3.1-6.6" stroke-width="1.7"/><path d="M12 7.2V12l3.2 2" stroke-width="1.5"/><circle cx="20.6" cy="4.6" r="1.5" fill="currentColor" stroke="none"/>',

    // 演员库：人物剪影 + 肩线断口，头用实心
    actress: '<circle cx="12" cy="8" r="3.6" stroke-width="1.7"/><path d="M4.8 20.4c0-3.7 3.2-6.2 7.2-6.2s7.2 2.5 7.2 6.2" stroke-width="1.7"/>',

    // 标签库：标签牌保留一角，孔洞实心
    tag: '<path d="M11.4 3.4H5.8a2.4 2.4 0 0 0-2.4 2.4v5.6a2.4 2.4 0 0 0 .7 1.7l8.2 8.2" stroke-width="1.6"/><path d="M20.9 11.3l-8.2 8.2a2.4 2.4 0 0 1-3.4 0l-1.4-1.4" stroke-width="1.6"/><circle cx="8.2" cy="8.2" r="1.7" fill="currentColor" stroke="none"/>',

    // 播放列表：堆叠条目 + 播放三角实心
    playlist: '<path d="M3.4 6.4h11.2" stroke-width="1.8"/><path d="M3.4 11h7.4" stroke-width="1.4"/><path d="M3.4 15.6h6.2" stroke-width="1.4"/><path d="M13.4 11.4v7.4l6-3.7z" fill="currentColor" stroke="none"/>',

    // 设置：滑块而非齿轮（齿轮太通用），两个旋钮一个实心
    settings: '<path d="M3.6 7.6h4.2M12.4 7.6h8" stroke-width="1.7"/><path d="M3.6 16.4h8M16.2 16.4h4.2" stroke-width="1.7"/><circle cx="10.1" cy="7.6" r="2.5" stroke-width="1.6"/><circle cx="13.7" cy="16.4" r="2.5" fill="currentColor" stroke="none"/>',

    // 新作通知：铃舌省略，用一道弧线+实心点替代，避免俗气
    bell: '<path d="M18.4 16.2V10a6.4 6.4 0 0 0-4.6-6.1" stroke-width="1.7"/><path d="M5.6 16.2V10a6.4 6.4 0 0 1 4.6-6.1" stroke-width="1.7"/><path d="M3.9 16.2h16.2" stroke-width="1.9"/><path d="M9.8 19.4a2.4 2.4 0 0 0 4.4 0" stroke-width="1.4"/><circle cx="12" cy="3.4" r="1.5" fill="currentColor" stroke="none"/>',

    // 年度报告：上升折线 + 末端实心顶点
    chart: '<path d="M3.6 19.4h16.8" stroke-width="1.9"/><path d="M3.6 15.4l4.6-5.2 3.8 3 6.4-7.4" stroke-width="1.7"/><circle cx="18.4" cy="5.8" r="2" fill="currentColor" stroke="none"/>',

    // 刮削失败：警示三角，感叹号用实心点+短线
    alert: '<path d="M12 3.8L21 19.4H3z" stroke-width="1.7"/><path d="M12 9.6v4" stroke-width="1.8"/><circle cx="12" cy="16.6" r="1.15" fill="currentColor" stroke="none"/>',

    // 海报健康：图片框 + 山脉 + 实心太阳点
    image: '<rect x="3" y="4.8" width="18" height="14.4" rx="2.2" stroke-width="1.6"/><path d="M3.6 16.2l4.3-4.1 3.2 3 3.6-4.4 5.7 6.1" stroke-width="1.5"/><circle cx="8.6" cy="9.2" r="1.7" fill="currentColor" stroke="none"/>',

    // 在线观看：屏幕 + 播放点，屏幕右下角留断口表示"实时"
    watch: '<rect x="2.8" y="4.6" width="18.4" height="12.6" rx="2.2" stroke-width="1.6"/><path d="M8.6 20.4h6.8" stroke-width="1.6"/><path d="M10.4 9.2v5.4l4.6-2.7z" fill="currentColor" stroke="none"/>',

    /* ---------- 工具 / 系统 ---------- */
    search: '<circle cx="10.6" cy="10.6" r="6.4" stroke-width="1.7"/><path d="M15.4 15.4l4.4 4.4" stroke-width="1.9"/>',
    grid: '<rect x="3.4" y="3.4" width="7" height="7" rx="1.6" stroke-width="1.6"/><rect x="13.6" y="3.4" width="7" height="7" rx="1.6" stroke-width="1.6"/><rect x="3.4" y="13.6" width="7" height="7" rx="1.6" stroke-width="1.6"/><rect x="13.6" y="13.6" width="7" height="7" rx="1.6" fill="currentColor" stroke="none"/>',
    list: '<path d="M3.6 6.4h16.8" stroke-width="1.8"/><path d="M3.6 12h16.8" stroke-width="1.4"/><path d="M3.6 17.6h10.4" stroke-width="1.8"/>',
    star: '<path d="M12 3.6l2.6 5.4 5.8.8-4.2 4.1 1 5.9-5.2-2.8-5.2 2.8 1-5.9L3.6 9.8l5.8-.8z" stroke-width="1.6"/>',
    play: '<path d="M7.4 4.6v14.8L19.4 12z" stroke-width="1.7"/>',
    plus: '<path d="M12 4.6v14.8" stroke-width="1.8"/><path d="M4.6 12h14.8" stroke-width="1.8"/>',
    close: '<path d="M5.6 5.6l12.8 12.8" stroke-width="1.8"/><path d="M18.4 5.6L5.6 18.4" stroke-width="1.8"/>',
    check: '<path d="M4.6 12.6l4.8 4.8L19.4 6.8" stroke-width="2"/>',
    edit: '<path d="M4.4 19.6h3.2L19.4 7.8a2 2 0 0 0 0-2.8l-.4-.4a2 2 0 0 0-2.8 0L4.4 16.4z" stroke-width="1.7"/>',
    trash: '<path d="M4.8 6.6h14.4" stroke-width="1.8"/><path d="M9.4 6.6V4.8a1.4 1.4 0 0 1 1.4-1.4h2.4a1.4 1.4 0 0 1 1.4 1.4v1.8" stroke-width="1.5"/><path d="M6.6 6.6l.9 12.4a1.8 1.8 0 0 0 1.8 1.6h5.4a1.8 1.8 0 0 0 1.8-1.6l.9-12.4" stroke-width="1.6"/>',
    refresh: '<path d="M20.4 12a8.4 8.4 0 1 1-2.5-6" stroke-width="1.7"/><path d="M20.6 4.4v4.8h-4.8" stroke-width="1.6"/>',
    folder: '<path d="M3.4 7.4a2.2 2.2 0 0 1 2.2-2.2h3.4l2.2 2.4h7.2a2.2 2.2 0 0 1 2.2 2.2v8.2a2.2 2.2 0 0 1-2.2 2.2H5.6a2.2 2.2 0 0 1-2.2-2.2z" stroke-width="1.6"/>',
    file: '<path d="M6.4 3.6h7.2l4.8 4.8v12.2H6.4z" stroke-width="1.6"/><path d="M13.4 3.6v5h5" stroke-width="1.4"/>',
    link: '<path d="M9.6 14.4l4.8-4.8" stroke-width="1.7"/><path d="M12.4 7.2l1.8-1.8a3.6 3.6 0 0 1 5.1 5.1l-1.8 1.8" stroke-width="1.6"/><path d="M11.6 16.8l-1.8 1.8a3.6 3.6 0 0 1-5.1-5.1l1.8-1.8" stroke-width="1.6"/>',
    cloud: '<path d="M7.2 18.4a4.4 4.4 0 0 1-.6-8.8 5.6 5.6 0 0 1 10.9-1.3 3.9 3.9 0 0 1-.7 10.1z" stroke-width="1.6"/>',
    // AI助手：凹边四芒智火花（大）+ 实心伴星（小），与 star 五角星 / spark 放射彻底区分
    ai: '<path d="M11 3.2Q12.2 9.2 18 10.4Q12.2 11.6 11 17.6Q9.8 11.6 4 10.4Q9.8 9.2 11 3.2Z" stroke-width="1.5"/><path d="M17.6 13.4Q18.2 15.6 20.4 16.2Q18.2 16.8 17.6 19Q17 16.8 14.8 16.2Q17 15.6 17.6 13.4Z" fill="currentColor" stroke="none"/>',
    moon: '<path d="M20.4 14.2A8.6 8.6 0 0 1 9.8 3.6 8.6 8.6 0 1 0 20.4 14.2z" stroke-width="1.7"/>',
    sun: '<circle cx="12" cy="12" r="4.2" stroke-width="1.7"/><path d="M12 2.8v2.6M12 18.6v2.6M2.8 12h2.6M18.6 12h2.6M5.9 5.9l1.9 1.9M16.2 16.2l1.9 1.9M18.1 5.9l-1.9 1.9M7.8 16.2l-1.9 1.9" stroke-width="1.5"/>',
    upload: '<path d="M12 15.6V4.4" stroke-width="1.8"/><path d="M7.2 9.2L12 4.4l4.8 4.8" stroke-width="1.7"/><path d="M4.4 15.2v3.2a2.2 2.2 0 0 0 2.2 2.2h10.8a2.2 2.2 0 0 0 2.2-2.2v-3.2" stroke-width="1.7"/>',
    download: '<path d="M12 4.4v11.2" stroke-width="1.8"/><path d="M7.2 10.8L12 15.6l4.8-4.8" stroke-width="1.7"/><path d="M4.4 15.2v3.2a2.2 2.2 0 0 0 2.2 2.2h10.8a2.2 2.2 0 0 0 2.2-2.2v-3.2" stroke-width="1.7"/>',
    filter: '<path d="M3.6 5.6h16.8l-6.4 7.6v6.2l-4-2.2v-4z" stroke-width="1.6"/>',
    sort: '<path d="M7.4 4.6v14.8" stroke-width="1.7"/><path d="M3.8 8.2l3.6-3.6 3.6 3.6" stroke-width="1.5"/><path d="M16.6 19.4V4.6" stroke-width="1.7"/><path d="M13 15.8l3.6 3.6 3.6-3.6" stroke-width="1.5"/>',
    more: '<circle cx="5.4" cy="12" r="1.5" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none"/><circle cx="18.6" cy="12" r="1.5" fill="currentColor" stroke="none"/>',
    chevronRight: '<path d="M9.4 5.6l6.4 6.4-6.4 6.4" stroke-width="1.8"/>',
    chevronLeft: '<path d="M14.6 5.6L8.2 12l6.4 6.4" stroke-width="1.8"/>',
    chevronDown: '<path d="M5.6 9.4L12 15.8l6.4-6.4" stroke-width="1.8"/>',
    external: '<path d="M14.4 4.6h5v5" stroke-width="1.7"/><path d="M19.4 4.6L11.6 12.4" stroke-width="1.7"/><path d="M18.4 14.2v4.2a2.2 2.2 0 0 1-2.2 2.2H5.6a2.2 2.2 0 0 1-2.2-2.2V7.8a2.2 2.2 0 0 1 2.2-2.2h4.2" stroke-width="1.6"/>',
    info: '<circle cx="12" cy="12" r="8.6" stroke-width="1.7"/><path d="M12 11v5.6" stroke-width="1.8"/><circle cx="12" cy="7.9" r="1.15" fill="currentColor" stroke="none"/>',
    // 系统警告：与 alert（刮削失败）区分 —— alert 用三角表"单条错误"，
    // warning 用实心横杠盾牌轮廓表"整库级风险"，底部刻度线暗示影响范围
    warning: '<path d="M12 2.8l8.6 3.6v6.4c0 4.6-3.4 7.9-8.6 9.4-5.2-1.5-8.6-4.8-8.6-9.4V6.4z" stroke-width="1.7"/><path d="M12 8.4v5" stroke-width="2"/><circle cx="12" cy="16.6" r="1.15" fill="currentColor" stroke="none"/>',
    shield: '<path d="M12 3.4l7.2 2.8v6.2c0 4.4-3 7.4-7.2 8.6-4.2-1.2-7.2-4.2-7.2-8.6V6.2z" stroke-width="1.7"/>',
    key: '<circle cx="8.4" cy="8.4" r="4.4" stroke-width="1.7"/><path d="M11.5 11.5l8.1 8.1" stroke-width="1.7"/><path d="M16.6 16.6l1.8-1.8" stroke-width="1.5"/>',
    cookie: '<circle cx="12" cy="12" r="8.6" stroke-width="1.7"/><circle cx="9.2" cy="9.6" r="1.15" fill="currentColor" stroke="none"/><circle cx="14.6" cy="10.4" r="1.15" fill="currentColor" stroke="none"/><circle cx="10.4" cy="14.8" r="1.15" fill="currentColor" stroke="none"/>',
    tool: '<path d="M14.6 5.6a4.6 4.6 0 0 0 5.8 5.8L9.8 22 4 16.2z" stroke-width="1.6"/><circle cx="17.4" cy="6.6" r="1.5" fill="currentColor" stroke="none"/>',
    paint: '<path d="M4.4 10.6a7.6 7.6 0 0 1 15.2 0v.8a2.2 2.2 0 0 1-2.2 2.2h-2.6v3.6a2.4 2.4 0 0 1-4.8 0v-3.6H6.6a2.2 2.2 0 0 1-2.2-2.2z" stroke-width="1.6"/>',
    scan: '<path d="M3.6 8.4V5.8a2.2 2.2 0 0 1 2.2-2.2h2.6" stroke-width="1.7"/><path d="M15.6 3.6h2.6a2.2 2.2 0 0 1 2.2 2.2v2.6" stroke-width="1.7"/><path d="M20.4 15.6v2.6a2.2 2.2 0 0 1-2.2 2.2h-2.6" stroke-width="1.7"/><path d="M8.4 20.4H5.8a2.2 2.2 0 0 1-2.2-2.2v-2.6" stroke-width="1.7"/><path d="M3.6 12h16.8" stroke-width="2"/>',
    server: '<rect x="3.4" y="4.4" width="17.2" height="6.2" rx="1.8" stroke-width="1.6"/><rect x="3.4" y="13.4" width="17.2" height="6.2" rx="1.8" stroke-width="1.6"/><circle cx="7" cy="7.5" r="1.1" fill="currentColor" stroke="none"/><circle cx="7" cy="16.5" r="1.1" fill="currentColor" stroke="none"/>',
    db: '<ellipse cx="12" cy="6.4" rx="7.4" ry="2.9" stroke-width="1.6"/><path d="M4.6 6.4v11.2c0 1.6 3.3 2.9 7.4 2.9s7.4-1.3 7.4-2.9V6.4" stroke-width="1.6"/><path d="M4.6 12c0 1.6 3.3 2.9 7.4 2.9s7.4-1.3 7.4-2.9" stroke-width="1.4"/>',
    cpu: '<rect x="6.4" y="6.4" width="11.2" height="11.2" rx="2.2" stroke-width="1.7"/><rect x="10" y="10" width="4" height="4" rx="1" fill="currentColor" stroke="none"/><path d="M9.4 3.4v3M14.6 3.4v3M9.4 17.6v3M14.6 17.6v3M3.4 9.4h3M3.4 14.6h3M17.6 9.4h3M17.6 14.6h3" stroke-width="1.5"/>',
    calendar: '<rect x="3.4" y="5.4" width="17.2" height="15.2" rx="2.2" stroke-width="1.6"/><path d="M3.4 10.2h17.2" stroke-width="1.7"/><path d="M8.4 3.2v4M15.6 3.2v4" stroke-width="1.5"/><circle cx="8.6" cy="14.6" r="1.2" fill="currentColor" stroke="none"/>',
    history: '<path d="M3.6 12a8.4 8.4 0 1 0 2.4-5.9" stroke-width="1.7"/><path d="M3.4 4.4v4.6h4.6" stroke-width="1.6"/><path d="M12 7.6V12l3.2 1.9" stroke-width="1.5"/>',
    users: '<circle cx="9.4" cy="8.2" r="3.4" stroke-width="1.6"/><path d="M2.8 19.6c0-3.4 3-5.6 6.6-5.6s6.6 2.2 6.6 5.6" stroke-width="1.6"/><path d="M16.2 5.2a3.4 3.4 0 0 1 0 6.6" stroke-width="1.5"/><path d="M18.4 14.4c2 .8 3.4 2.5 3.4 5.2" stroke-width="1.4"/>',
    layers: '<path d="M12 3.4l8.4 4.4-8.4 4.4-8.4-4.4z" stroke-width="1.6"/><path d="M3.6 12.4l8.4 4.4 8.4-4.4" stroke-width="1.5"/><path d="M3.6 16.6l8.4 4.4 8.4-4.4" stroke-width="1.3"/>',
    copy: '<rect x="8.4" y="8.4" width="11.2" height="11.2" rx="2.2" stroke-width="1.6"/><path d="M15.6 8.4V6.6a2.2 2.2 0 0 0-2.2-2.2H6.6a2.2 2.2 0 0 0-2.2 2.2v6.8a2.2 2.2 0 0 0 2.2 2.2h1.8" stroke-width="1.5"/>',
    save: '<path d="M5.4 3.8h9.4l4.8 4.8v9.4a2.2 2.2 0 0 1-2.2 2.2H5.4a2.2 2.2 0 0 1-2.2-2.2V6a2.2 2.2 0 0 1 2.2-2.2z" stroke-width="1.6"/><path d="M8.4 3.8v5.4h6.2V3.8" stroke-width="1.4"/>',
    logout: '<path d="M9.6 20.4H5.6a2.2 2.2 0 0 1-2.2-2.2V5.8a2.2 2.2 0 0 1 2.2-2.2h4" stroke-width="1.7"/><path d="M15.4 8.2l4.4 3.8-4.4 3.8" stroke-width="1.7"/><path d="M9.4 12h10.4" stroke-width="1.7"/>',
    lock: '<rect x="4.4" y="10.4" width="15.2" height="10.2" rx="2.2" stroke-width="1.7"/><path d="M7.8 10.4V7.6a4.2 4.2 0 0 1 8.4 0v2.8" stroke-width="1.6"/><circle cx="12" cy="15.4" r="1.4" fill="currentColor" stroke="none"/>',
    globe: '<circle cx="12" cy="12" r="8.6" stroke-width="1.7"/><path d="M3.6 12h16.8" stroke-width="1.4"/><path d="M12 3.4c2.4 2.4 3.6 5.4 3.6 8.6s-1.2 6.2-3.6 8.6c-2.4-2.4-3.6-5.4-3.6-8.6S9.6 5.8 12 3.4z" stroke-width="1.4"/>',
    drag: '<circle cx="9" cy="6.4" r="1.5" fill="currentColor" stroke="none"/><circle cx="15" cy="6.4" r="1.5" fill="currentColor" stroke="none"/><circle cx="9" cy="12" r="1.5" fill="currentColor" stroke="none"/><circle cx="15" cy="12" r="1.5" fill="currentColor" stroke="none"/><circle cx="9" cy="17.6" r="1.5" fill="currentColor" stroke="none"/><circle cx="15" cy="17.6" r="1.5" fill="currentColor" stroke="none"/>',
    pause: '<path d="M9.4 4.8v14.4" stroke-width="2.4"/><path d="M14.6 4.8v14.4" stroke-width="2.4"/>',
    volume: '<path d="M11.4 5.2L6.6 9.4H3.4v5.2h3.2l4.8 4.2z" stroke-width="1.6"/><path d="M15.2 9.2a4 4 0 0 1 0 5.6" stroke-width="1.5"/><path d="M18 6.6a7.6 7.6 0 0 1 0 10.8" stroke-width="1.4"/>',
    fullscreen: '<path d="M4.4 9.4V6.6a2.2 2.2 0 0 1 2.2-2.2h2.8" stroke-width="1.7"/><path d="M14.6 4.4h2.8a2.2 2.2 0 0 1 2.2 2.2v2.8" stroke-width="1.7"/><path d="M19.6 14.6v2.8a2.2 2.2 0 0 1-2.2 2.2h-2.8" stroke-width="1.7"/><path d="M9.4 19.6H6.6a2.2 2.2 0 0 1-2.2-2.2v-2.8" stroke-width="1.7"/>',
    pip: '<rect x="2.8" y="4.4" width="18.4" height="12.4" rx="2.2" stroke-width="1.6"/><rect x="12.4" y="11.6" width="7.4" height="4.2" rx="1.2" fill="currentColor" stroke="none"/>',
    crop: '<path d="M6.4 2.8v14.8h14.8" stroke-width="1.7"/><path d="M2.8 6.4h14.8v14.8" stroke-width="1.7"/>'
  };

  var SPRITE_ID = 'ic-sprite';

  function buildSprite() {
    if (document.getElementById(SPRITE_ID)) return;
    var parts = ['<svg id="' + SPRITE_ID + '" aria-hidden="true" focusable="false" style="position:absolute;width:0;height:0;overflow:hidden">'];
    for (var name in ICONS) {
      if (!Object.prototype.hasOwnProperty.call(ICONS, name)) continue;
      parts.push('<symbol id="ic-' + name + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">' + ICONS[name] + '</symbol>');
    }
    parts.push('</svg>');
    var host = document.createElement('div');
    host.innerHTML = parts.join('');
    document.body.insertBefore(host.firstChild, document.body.firstChild);
  }

  /* 生成图标：icon('reel', 20) -> <svg class="ic ic-reel"> */
  function icon(name, size, extraClass) {
    size = size || 20;
    var cls = 'ic ic-' + name + (extraClass ? ' ' + extraClass : '');
    return '<svg class="' + cls + '" width="' + size + '" height="' + size + '" aria-hidden="true" focusable="false"><use href="#ic-' + name + '"/></svg>';
  }

  window.MidnightIcons = { icon: icon, names: Object.keys(ICONS), build: buildSprite };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', buildSprite);
  } else {
    buildSprite();
  }
})();
