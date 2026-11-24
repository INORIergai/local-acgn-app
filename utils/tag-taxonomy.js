/**
 * utils/tag-taxonomy.js —— round168b · 标签语义类目
 *
 * 背景：`tags.category` 全库 252 条**全是 'genre'**，等于没有分类，
 *       于是「按类目分组」这功能根本无从谈起。
 *
 * 设计原则：
 *   1. 规则可解释：每条标签都能说出「为什么归到这一类」，不是黑盒；
 *   2. 先精确表、后关键词、最后兜底 —— 宁可归到「其他」，也不乱猜；
 *   3. 归类**不写库**也能用（前端拿推断结果直接分组），写库必须显式调用；
 *   4. 先归一化（复用 tag-space：繁简/日文新字体/全半角），
 *      所以「巨乳」「巨乳フェチ」「戀乳癖」能落到同一套规则上。
 */

const TAXONOMY = [
    { key: 'form', label: '作品形态', icon: '📦' },
    { key: 'spec', label: '规格画质', icon: '🎞️' },
    { key: 'body', label: '体型', icon: '🧍' },
    { key: 'act', label: '玩法', icon: '🔥' },
    { key: 'scene', label: '场景', icon: '🏠' },
    { key: 'wear', label: '服装', icon: '👗' },
    { key: 'role', label: '角色职业', icon: '🎭' },
    { key: 'attr', label: '人物属性', icon: '🎂' },
    { key: 'vibe', label: '气质剧情', icon: '🎬' },
    { key: 'media', label: '载体形态', icon: '📚' },   // 漫画 / 轻小说 / 画集 / 动画
    { key: 'genre', label: '题材', icon: '🎯' },       // 恋爱 / 校园 / 奇幻 / 悬疑…
    { key: 'region', label: '地区', icon: '🌏' },      // 中国 / 日本 / 欧美…
    { key: 'other', label: '未归类', icon: '🏷️' }
];
const LABEL = Object.fromEntries(TAXONOMY.map(t => [t.key, t.label]));

/* 精确表：一眼能定的，避免关键词互相打架（比如「迷你裙」是服装、「迷你係列」是形态） */
const EXACT = {
    // 作品形态
    '單體作品': 'form', '単体作品': 'form', '合集': 'form', '女優ベスト・総集編': 'form',
    'ベスト・総集編': 'form', '迷你係列': 'form', '4小時以上作品': 'form',
    '16時間以上作品': 'form', '4時間以上作品': 'form', '合作作品': 'form',
    'DVD多士爐': 'form', 'MGSだけのおまけ映像付き': 'form', '特典あり（AVベースボール）': 'form',
    // 规格画质
    '高畫質': 'spec', '4K': 'spec', 'ハイビジョン': 'spec', 'フルハイビジョン(FHD)': 'spec',
    '數位馬賽克': 'spec', '薄馬賽克': 'spec', '独占配信': 'spec', '配信専用': 'spec',
    'DMM獨家': 'spec',
    // 服装
    '迷你裙': 'wear', '迷你裙警察': 'wear', '學校泳裝': 'wear', '泳裝': 'wear',
    '制服': 'wear', '校服': 'wear', '水手服': 'wear', 'セーラー服': 'wear',
    '內衣': 'wear', 'ランジェリー': 'wear', '眼鏡': 'wear', 'めがね': 'wear',
    '旗袍': 'wear', '和服・喪服': 'wear', '兔女郎': 'wear', 'バニーガール': 'wear',
    '連褲襪': 'wear', 'ニーソックス': 'wear', '及膝襪': 'wear', '緊身衣': 'wear',
    '裸體圍裙': 'wear', '猥褻穿著': 'wear', '貓耳女': 'wear', 'パンチラ': 'wear',
    'ノーブラ': 'wear', 'ノーパン': 'wear', 'パンスト': 'wear',
    // 角色职业
    '女教師': 'role', '家庭教師': 'role', '家教': 'role', '講師': 'role',
    '护士': 'role', '看護婦・ナース': 'role', '女醫': 'role', '女醫生': 'role',
    '女傭': 'role', 'メイド': 'role', '女上司': 'role', '部下・同僚': 'role',
    '秘書': 'role', '女大學生': 'role', '女子大生': 'role', '女子校生': 'role',
    '高中女生': 'role', '女生': 'role', '姐姐': 'role', 'お姉さん': 'role',
    '姉・妹': 'role', '姐妹': 'role', '母親': 'role', '婆婆': 'role',
    '叔母さん': 'role', '寡婦': 'role', '娘・養女': 'role', '童年朋友': 'role',
    'インストラクター': 'role', 'ウェイトレス': 'role', 'オタク': 'role',
    '偶像藝人': 'role', 'アイドル・芸能人': 'role',
    // 人物属性
    '已婚婦女': 'attr', '熟女': 'attr', '成熟的女人': 'attr', '素人': 'attr',
    '業餘': 'attr', '處男': 'attr', '童貞': 'attr', '雙性人': 'attr',
    '正太控': 'attr', '蘿莉塔': 'attr', '娃娃': 'attr', '女同性戀': 'attr',
    '女同接吻': 'attr', '新娘、年輕妻子': 'attr', 'セレブ': 'attr',
    // 气质剧情
    '蕩婦': 'vibe', '花癡': 'vibe', '痴女': 'vibe', 'ビッチ': 'vibe',
    '羞恥': 'vibe', '惡作劇': 'vibe', '倒追': 'vibe', '獵豔': 'vibe',
    '戀愛': 'vibe', '幻想': 'vibe', '妄想': 'vibe', '妄想族': 'vibe',
    '戲劇': 'vibe', 'ドラマ': 'vibe', '教學': 'vibe', '紀錄片': 'vibe',
    '跳舞': 'vibe', '堵嘴·喜劇': 'vibe', '主觀視角': 'vibe', '主観': 'vibe',
    '第一人稱攝影': 'vibe', '偷窥': 'vibe', '盗撮・のぞき': 'vibe',
    '時間停止': 'vibe', '孕ませ': 'vibe', '凌辱': 'vibe', '近親相姦': 'vibe',
    '亂倫': 'vibe', '出軌': 'vibe', '不倫': 'vibe', '通姦': 'vibe',
    'スワッピング・夫婦交換': 'vibe', 'ハーレム': 'vibe', 'How To': 'vibe',
    // 场景
    '溫泉': 'scene', '野外・露出': 'scene', '病院・クリニック': 'scene',
    'ホテル': 'scene', 'お風呂': 'scene', '學校作品': 'scene', '学園もの': 'scene',
    '美容院': 'scene', 'エステ・マッサージ': 'scene', 'ヘルス・ソープ': 'scene',
    '風俗': 'scene', 'キャバ嬢・風俗嬢': 'scene', 'デート': 'scene',
    // 其他/噪声
    'AI生成作品': 'other', 'その他フェチ': 'other', '其他戀物癖': 'other',
    '各種職業': 'other', '職業色々': 'other', '高': 'other', '69': 'other',
    // ---- 第二轮补齐（覆盖率 81% → 目标 ≥95%）----
    '美少女': 'attr', 'ギャル': 'attr', '首次亮相': 'attr', '清楚': 'vibe',
    '角色扮演': 'act', 'コスプレ': 'act', 'アクメ・オーガズム': 'act',
    'バック': 'act', '足交': 'act', '脚フェチ': 'act', 'パイズリ': 'act',
    '濫交': 'act', 'M女': 'act', 'M男': 'act', 'SM': 'act', '即ハメ': 'act',
    'ハメ撮り': 'act', '騎乗位': 'act', 'ローション': 'act', 'ローション・オイル': 'act',
    'オナサポ': 'act', '性奴': 'act', '白目・失神': 'act', '汗だく': 'act',
    '69': 'act', 'ローションプレイ': 'act',
    'OL': 'role', '妓女': 'role', '職業色々': 'role', '各種職業': 'role', '女優': 'role',
    '戀腿癖': 'body', 'デカチン・巨根': 'body', 'スレンダー': 'body', '子宮頸': 'body',
    '日焼け': 'body', '肌肉': 'body',
    'デジモ': 'spec', 'ギリモザ': 'spec', '局部特寫': 'spec',
    '企畫': 'form', '企画': 'form', '原作コラボ': 'form',
    'ファン感謝・訪問': 'vibe', '罵倒': 'vibe', '體育服': 'wear',
    // ---- 书籍/漫画（Bangumi 社区标签）----
    '漫画': 'media', '轻小说': 'media', '輕小說': 'media', '小说': 'media', '小說': 'media',
    'マンガ': 'media', '日漫': 'media', '日漫BG': 'genre', '少女漫画': 'media', '少女漫': 'media',
    '青年漫画': 'media', '日本漫画': 'media', '短篇集': 'form', '超短篇': 'form',
    '單卷': 'form', '单卷': 'form', '一卷全': 'form', '系列': 'form',
    '18X': 'genre', '色气': 'genre', '壓槍': 'genre', '压枪': 'genre', '职场': 'genre',
    'cosplay': 'act', '少女': 'attr',
    '御姐': 'genre', '御姐控': 'genre', '姐弟恋': 'genre', '法国': 'region', '法國': 'region',
    '名著': 'form', '中篇': 'form', '绘本': 'media', '繪本': 'media', '全一卷': 'form',
    '全2卷': 'form', '全3卷': 'form', '漫画系列': 'form', '腰斩': 'form', 'JUMP': 'media',
    '画集': 'media', '畫集': 'media', '设定集': 'media', '設定集': 'media', '动画': 'media',
    '恋爱': 'genre', '戀愛': 'genre', '校园': 'genre', '校園': 'genre', '后宫': 'genre',
    '後宮': 'genre', '卖肉': 'genre', '賣肉': 'genre', '搞笑': 'genre', '热血': 'genre',
    '熱血': 'genre', '奇幻': 'genre', '科幻': 'genre', '悬疑': 'genre', '懸疑': 'genre',
    '日常': 'genre', '青春': 'genre', '治愈': 'genre', '治癒': 'genre', '战斗': 'genre',
    '戰鬥': 'genre', '运动': 'genre', '運動': 'genre', '音乐': 'genre', '音樂': 'genre',
    '恐怖': 'genre', '推理': 'genre', '历史': 'genre', '歷史': 'genre', '奇幻冒险': 'genre',
    '异世界': 'genre', '異世界': 'genre', '转生': 'genre', '轉生': 'genre', '百合': 'genre',
    'BL': 'genre', 'GL': 'genre', '原创': 'genre', '原創': 'genre',
    'JK': 'genre', '穿越': 'genre', '都市': 'genre', '种田流': 'genre', '沙雕': 'genre',
    '擦边球': 'genre', '腰斩': 'genre', '网文': 'media', '網路小說': 'media',
    '国漫': 'media', '國漫': 'media', '起点': 'media',
    '中国': 'region', '中國': 'region', '日本': 'region', '美国': 'region', '美國': 'region',
    '韩国': 'region', '韓國': 'region', '欧美': 'region', '歐美': 'region', '国产': 'region', '國產': 'region',
    '短篇': 'form',
    '长篇': 'form', '長篇': 'form', '连载': 'form', '連載': 'form', '完结': 'form', '完結': 'form'
};

/* 关键词规则：按顺序命中即停（越具体的越靠前） */
const RULES = [
    ['wear', /(制服|校服|水手服|泳裝|泳装|內衣|内衣|旗袍|和服|圍裙|围裙|褲襪|裤袜|襪|袜|眼鏡|眼镜|裙|兔女郎|パンスト|ニーソックス|ランジェリー|セーラー服)/],
    ['role', /(教師|教师|護士|护士|女醫|女医|女傭|女佣|メイド|上司|同僚|秘書|秘书|大學生|大学生|校生|高中生|お姉さん|姉|妹|母親|母亲|婆婆|叔母|寡婦|寡妇|養女|养女|偶像|インストラクター|ウェイトレス|キャバ嬢|ナース)/],
    ['form', /(單體|单体|単体|合集|総集編|总集编|ベスト|迷你係|時長\+|时长\+|時間以上|小时以上|以上作品|特典|おまけ|多士爐)/],
    ['spec', /(畫質|画质|高画|4k|8k|ハイビジョン|fhd|馬賽克|马赛克|獨占|独占|配信|獨家|独家)/],
    ['body', /(乳|尻|臀|屁股|苗條|苗条|嬌小|娇小|胖|瘦|無毛|无毛|パイパン|スレンダー|母乳|フェチ)/],
    ['act', /(中出|口交|フェラ|乳交|潮吹|肛|アナル|自慰|手指|放尿|騎乘|骑乘|女上位|3p|4p|多p|輪姦|轮奸|拘束|調教|调教|玩具|オモチャ|ディルド|跳蛋|ローション|淫語|淫语|舔陰|舔阴|接吻|キス|深喉|吞精|顏射|颜射|SM|M女|M男|ハード|淫乱|打手槍|打手枪|按摩)/],
    ['scene', /(溫泉|温泉|野外|露出|病院|诊所|ホテル|酒店|風呂|浴室|學校|学校|学園|教室|美容院|エステ|ソープ|風俗|风俗|デート|自宅|車|车内)/],
    ['attr', /(已婚|熟女|成熟|素人|業餘|业余|處男|处男|童貞|童贞|雙性|双性|正太|蘿莉|萝莉|同性|セレブ|人妻)/],
    ['media', /(漫画|漫畫|轻小说|輕小說|画集|畫集|设定集|設定集|小说|小說|文库|文庫)/],
    ['genre', /(恋爱|戀愛|校园|校園|后宫|後宮|卖肉|賣肉|搞笑|热血|熱血|奇幻|科幻|悬疑|懸疑|日常|青春|治愈|治癒|战斗|戰鬥|运动|運動|音乐|音樂|恐怖|推理|历史|歷史|异世界|異世界|转生|轉生|百合|纯爱|純愛|穿越|都市|种田|沙雕|擦边|腰斩|JK)/],
    ['region', /^(中国|中國|日本|美国|美國|韩国|韓國|欧美|歐美|国产|國產|国漫|國漫)$/],
    ['vibe', /(蕩婦|荡妇|花癡|花痴|痴女|ビッチ|羞恥|羞耻|惡作劇|恶作剧|倒追|獵豔|猎艳|戀愛|恋爱|幻想|妄想|戲劇|戏剧|ドラマ|紀錄片|纪录片|偷窥|盗撮|時間停止|时间停止|凌辱|近親|乱伦|亂倫|出軌|出轨|不倫|不伦|通姦|通奸|ハーレム|主觀|主观|主観|第一人稱|第一人称|跳舞|喜劇|喜剧|教學|教学)/]
];

const { normalizeTagName } = require('./tag-space');

/** 归类单个标签名 → { category, label, reason } */
function classify(name) {
    const raw = String(name == null ? '' : name).trim();
    if (!raw) return { category: 'other', label: LABEL.other, reason: '空标签名' };
    if (EXACT[raw]) return { category: EXACT[raw], label: LABEL[EXACT[raw]], reason: '精确匹配' };

    const norm = normalizeTagName(raw);
    // 归一化之后再查一次精确表（解决繁简/日文新字体写法差异）
    for (const [k, v] of Object.entries(EXACT)) {
        if (normalizeTagName(k) === norm) return { category: v, label: LABEL[v], reason: `归一化匹配（${norm}）` };
    }
    for (const [cat, re] of RULES) {
        if (re.test(norm)) return { category: cat, label: LABEL[cat], reason: `关键词命中 ${re.source.slice(0, 24)}…` };
    }
    return { category: 'other', label: LABEL.other, reason: '没有规则命中' };
}

/** 批量归类 → 附带每类统计与「规则覆盖率」 */
function classifyAll(tags) {
    const out = (tags || []).map(t => ({ ...t, ...classify(t.name) }));
    const counts = {};
    for (const t of out) counts[t.category] = (counts[t.category] || 0) + 1;
    const covered = out.filter(t => t.category !== 'other').length;
    return {
        items: out,
        counts,
        taxonomy: TAXONOMY,
        coverage: out.length ? +(covered / out.length * 100).toFixed(1) : 0
    };
}

module.exports = { TAXONOMY, LABEL, classify, classifyAll, EXACT };