/* 漫画跨源搜索回归：不联网、不启动应用。mock engine.grab，验证 searchAll 的
 * 结果结构 / 封面代理 / 单源失败隔离，以及 TitleMatch.pickChapter。 */
const assert = require('node:assert/strict');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const enginePath = require.resolve(path.join(root, 'utils', 'media-sources', 'engine.js'));

const DM5_HTML = `<div class="mh-item">
  <h2 class="title"><a title="海贼王" href="/manhua-haizeiwang/">海贼王</a></h2>
  <p class="mh-cover" style="background-image:url(https://img.dm5.test/cover1.jpg)"></p>
  <div class="chapter">最新 第1100话</div>
</div>`;
const ZMH_JSON = JSON.stringify({ errno: 0, data: { list: [
    { id: 123, title: '海贼王', cover: 'https://img.zmh.test/c2.jpg', last_name: '第1100话', authors: '尾田' }
] } });
const KOMIIC_JSON = JSON.stringify({ data: { searchComics: [
    { id: 'c1', title: '海贼王', imageUrl: 'https://img.km.test/c3.jpg', status: 'ONGOING', authors: [{ name: '尾田' }] }
] } });

// mock：按 URL 分发三种样本；未知 URL 抛错
const fakeGrab = async (url, opts) => {
    if (String(url).includes('dm5.com/search')) return { ok: true, status: 200, text: DM5_HTML, buf: Buffer.from(DM5_HTML), ctype: 'text/html' };
    if (String(url).includes('zaimanhua.com/app/v1/search')) return { ok: true, status: 200, text: ZMH_JSON, buf: Buffer.from(ZMH_JSON), ctype: 'application/json' };
    if (String(url).includes('komiic.com/api/query')) return { ok: true, status: 200, text: KOMIIC_JSON, buf: Buffer.from(KOMIIC_JSON), ctype: 'application/json' };
    throw new Error('mock 未覆盖: ' + url);
};

// 在 reading.js require engine 之前替换导出
const engine = require(enginePath);
engine.grab = fakeGrab;
require.cache[enginePath].exports = engine;
delete require.cache[require.resolve(path.join(root, 'utils', 'media-sources', 'reading.js'))];
const reading = require(path.join(root, 'utils', 'media-sources', 'reading.js'));

(async () => {
    const groups = await reading.searchAll('海贼王', { kind: 'manga' });
    assert.equal(groups.length, 3, '三个漫画源都应参与搜索');
    const byId = Object.fromEntries(groups.map((g) => [g.adapter, g]));
    assert.ok(byId.dm5 && byId.zaimanhua && byId.komiic, '应含 dm5/zaimanhua/komiic');

    // dm5
    assert.equal(byId.dm5.ok, true, 'dm5 搜索应成功');
    assert.equal(byId.dm5.items.length, 1, 'dm5 应返回 1 条');
    assert.equal(byId.dm5.items[0].name, '海贼王');
    assert.ok(/\/manhua-haizeiwang\/?$/.test(byId.dm5.items[0].url), 'dm5 链接应为 /manhua-…');
    assert.ok(byId.dm5.items[0].cover.startsWith('/api/media-source/seg?u='), '封面应走 imgProxy');

    // zaimanhua
    assert.equal(byId.zaimanhua.ok, true);
    assert.equal(byId.zaimanhua.items.length, 1);
    assert.ok(/\/details\/123$/.test(byId.zaimanhua.items[0].url), '再漫画详情应为 /details/{id}');
    assert.ok(byId.zaimanhua.items[0].cover.startsWith('/api/media-source/seg?u='));

    // komiic
    assert.equal(byId.komiic.ok, true);
    assert.equal(byId.komiic.items.length, 1);
    assert.ok(/\/comics\/c1$/.test(byId.komiic.items[0].url), 'komiic 详情应为 /comics/{id}');
    assert.ok(byId.komiic.items[0].cover.startsWith('/api/media-source/seg?u='));

    // 所有封面都经代理
    for (const g of groups) for (const it of g.items) {
        assert.ok(String(it.cover).startsWith('/api/media-source/seg?u='), g.adapter + ' 封面必须走 imgProxy');
    }

    // 单源失败隔离：让 dm5 抛错，其它源不受影响
    engine.grab = async (url) => {
        if (String(url).includes('dm5.com/search')) throw new Error('dm5 挂了');
        return fakeGrab(url);
    };
    require.cache[enginePath].exports = engine;
    delete require.cache[require.resolve(path.join(root, 'utils', 'media-sources', 'reading.js'))];
    const reading2 = require(path.join(root, 'utils', 'media-sources', 'reading.js'));
    const groups2 = await reading2.searchAll('海贼王', { kind: 'manga' });
    const dm5 = groups2.find((g) => g.adapter === 'dm5');
    assert.equal(dm5.ok, false, 'dm5 失败应标记 ok=false');
    assert.ok(dm5.error && dm5.error.length > 0, '失败源应有 error');
    assert.equal(dm5.items.length, 0);
    assert.equal(groups2.find((g) => g.adapter === 'zaimanhua').ok, true, '其它源不应受影响');

    // pickChapter：同名 / 章号 / 找不到
    const TM = require(path.join(root, 'public', 'js', 'title-match.js'));
    const chs = [{ name: '第1话' }, { name: '第11话' }, { name: '第 2 话 特别篇' }];
    assert.equal(TM.pickChapter(chs, '第11话'), 1, '章号完整匹配');
    assert.equal(TM.pickChapter(chs, '第 1 话'), 0, '同名归一化');
    assert.equal(TM.pickChapter(chs, '第2话 特别篇'), 2);
    assert.equal(TM.pickChapter(chs, '第99话'), -1);

    console.log('PASS 漫画跨源搜索（3 源结构 / 封面代理 / 失败隔离）与跨源章节匹配');
})().catch((e) => { console.error(e); process.exit(1); });
