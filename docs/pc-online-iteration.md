# PC 在线观看第一批迭代

对标 Kazumi 2.4.5 与 Animeko 的搜索、资源选择、历史与连播链路；复用现有声明式源、播放器、HLS/图片代理和追番数据，不引入 Flutter/Compose/mpv，不修改 Android 专属文件。

## 本批实现

- **默认动漫入口**：`动漫在线观看` 进入统一聚合解析；原站排障入口保留。
- **搜索与源管理**：禁用源在服务端调度前排除；同一关键词返回时复用结果，主动点搜索才刷新；换源复用当前搜索候选。
- **播放上下文**：统一保存作品、集名、源、作品地址、分集队列、当前集下标，不再只传视频 URL。
- **精确历史**：播放中节流保存，关闭时补写；历史显示并恢复秒数；接近自然结尾才记为看完，异常结束事件不清空旧进度。
- **在线队列**：播放器队列、上下集、自然结束自动连播支持在线解析分集；本地影片连播保留原行为；通用播放器不会误删在线分集队列。
- **换源续接**：选择候选源后读取其分集，优先同名集，再回退集号，自动接回当前秒数；无需再手动选一次集。
- **异步保护**：关闭播放器或另开影片会使旧解析结果失效，不能重新打开旧流。
- **漫画恢复**：滚动位置每秒保存，关闭时补写；恢复定位不覆盖用户手动滚动；单图失败显示页码与重试按钮，只重试失败图片。

## 验证

- `node scripts/online-playback-regression.cjs`：使用可控接口回归禁用源过滤、87 秒精确续播、上下集、自动连播、完成判定、异步取消，以及通用播放器保留在线队列；已通过。
- `node --check public/js/app.js public/js/media-source.js routes/media-source.js`：语法检查已通过。
- `node scripts/pc-online-gui.cjs`：以 `.runtime/pc-online-gui` 独立数据目录、端口 3891 启动真实 Electron；截图保存在 `scripts/artifacts/pc-online/`。
- 真实漫画书墙、章节图片已加载；手动滚动位置 `0.016` 在关闭时保持不变。强制第一页失败后，“重试本页”仅重新请求该图片，源图返回 200 并恢复显示。
- 播放器 GUI 历史使用 8 秒位置与 52.2 秒 W3C 公开样本；样本由测试驱动提供并支持 Range，避免 W3C 的跨源资源策略阻断。该项只验证播放器交互，**不代表真实动漫源解析通过**。
- 真实动漫搜索、分集与播放：`葬送的芙莉莲` 共 22 个源参与、7 个有结果；稀饭动漫 Next 返回 28 集；解析为 `kind=mp4`。`node scripts/pc-anime-network-probe.cjs` 实测第一集：代理返回 `206`、`content-range: bytes 0-8388607/589764325`，播放器 `readyState=4`、`duration=1560.895`、无 `error`，真实首帧已通过。
- 真实流首帧曾失败两次：先是代理把浏览器开放式 Range `bytes=0-` 原样转给源站，源站拖到 30 秒超时并回 502（`Format error`）；后经上游探测确认 `bytes=0-0`、`bytes=0-1023` 正常，而 `bytes=0-`、`bytes=1024-` 超时。修复为 `routes/media-source.js` 把整文件媒体的开放式/无 Range 请求改写为 8 MiB 有界窗口；HLS 分片不再被 1 字节探测截断。修复后同一条真实链路首帧通过。

本轮没有重建安装版/便携版 EXE，没有修改或验证 Android，也没有提交、推送或创建 PR。

## 第二批（本次）

- **标题结构化匹配**：新增 `public/js/title-match.js`，拆出基础作品名、季度/部分、最终季、剧场版/OVA/OAD/特别篇/番外/总集篇、年份与常见画质/语言噪声；兼容 `第二季`、`Season 2`、`2nd Season`、`S2` 和常见繁简差异。
- **统一评分**：搜索候选、换源线路共用同一套 1–99 分；正篇高于其他季度，其他季度高于剧场版/特别篇，无关作品低分。搜索结果按匹配度排序并显示“精确/季度/特别篇”徽标；顶部给出明确不歧义的推荐线路。
- **换源可解释**：换源面板按分数排序，显示匹配百分比与原因；其他季度、特别篇和低匹配候选单独计数并说明已排除，不再用 `includes` 误绑。
- **分阶段自动换源**：解析失败后先做标题严格匹配，再排除本次运行失败线路；只有唯一高分线路才自动切换并保留集名/秒数。同分线路不自动选，提示用户手动选择；手动重试失败线路会解除黑名单。
- **集号精确匹配**：换源接集从 `includes('1')` 改为完整集号比较，避免把第 1 集接到第 11 集；`第1话`、`EP01`、`12.5 特别篇` 均有回归。

### 第二批验证

- `node scripts/title-match-regression.cjs`：通过。覆盖季度/特别篇解析、繁简、画质噪声、分数梯度、严格筛选、排除/失败线路、同分歧义和集号匹配。
- `node scripts/online-playback-regression.cjs`：通过。新增“解析失败 → 自动换到备用源正篇、拒绝第二季、写入失败黑名单”的集成断言。
- `node scripts/pc-anime-network-probe.cjs`：真实 Electron + 真实源通过。搜索结果出现“精确94 / 季度68”徽标；换源面板列出 6 条 94% 正篇线路；真实第一集仍为 `readyState=4`、`duration=1560.895`、无错误。

## 第三批（本次）：在线历史入库

- **独立数据表**：`online_history` 以 `sourceId + 单集 url` 为唯一键，保存作品、集名、源、作品地址、分集队列、当前集、类型、秒数、时长、完成状态与时间；`updatedAt` 负责新旧写入合并，迟到的旧请求不能覆盖新进度。表同时写入 `db/schema.sql` 与 `utils/db.js` 的增量迁移，已有库启动时自动建表。
- **服务端 API**：`GET /api/media-source/history?limit=` 读取最近记录；`POST /api/media-source/history` 单条 upsert；`POST /api/media-source/history/merge` 批量迁移旧 localStorage；`DELETE /api/media-source/history` 清空；`DELETE /api/media-source/history/item` 删除单条。
- **前端同步**：localStorage 继续作为本机镜像和离线兜底；每次保存先写本机，再后台 upsert 服务端，失败进入待同步队列，下次打开历史页补传。首次打开会把旧本地记录批量迁移，之后以服务端记录为事实来源，只保留尚未上传成功的本地副本。
- **状态可见**：历史页显示“正在同步… / 已与服务器同步 / 服务器不可用，显示本地记录”；清空同时清理本机与服务端，服务器暂不可用时先清本机并在下次进入时重试 DELETE。
- **跨设备**：同一服务端的另一台设备写入的新记录，在打开历史页时合并进本机，并按 `updatedAt` 取较新进度。

### 第三批验证

- `node scripts/online-history-regression.cjs`：通过。使用 `.runtime/online-history-test` 独立数据库，覆盖 upsert、去重、新旧写入合并、完成状态、分集 JSON、批量迁移、单条删除、清空；未接触真实 `movie.db`。
- `node scripts/online-playback-regression.cjs`：通过。新增断言“保存后服务端有 87 秒记录”“远端 42 秒记录同步到本机”“清空同时删除服务端与本地”。
- `node scripts/pc-anime-network-probe.cjs`：真实 Electron + 真实源通过。历史页显示“已与服务器同步”和“看到 00:12”，`GET /history` 返回同一作品、集名和 `position=12`。
- `node scripts/pc-history-persist.cjs`：关闭并重新启动同一隔离 Electron 后，`PERSISTED count=1 position=12`，说明记录已落库而非只存在内存/localStorage。

## 第四批（本次）：漫画跨源

- **目标**：漫画跨源搜索（输入书名并发查多个源、按匹配度排序、点候选进该源详情）+ 换源续读（换到另一源时停在同一章、同一滚动比例）。只做漫画；小说源无搜索接口，本批不做。
- **接口（已实测确认，未再探测）**：再漫画 `GET /app/v1/search/index?keyword=&source=1&page=1&size=10`（返回 `data.list`，注意是 `/app/v1/` 不是适配器的 `/api/v1`）；动漫屋 `GET /search?title=`（HTML，`.mh-item` 卡片，`h2.title a` 取标题/链接，`.mh-cover` 内联 background 取封面）；Komiic GraphQL `searchComics`（`pagination` 必填、`orderBy` 为必填枚举，用变量传 `DATE_UPDATED`）。
- **服务端**：`reading.js` 三个漫画适配器各加 `search()`（统一 `{name,url,cover,latest,author}`、封面一律 `imgProxy`）、新增 `searchAll(query,{kind})` 并发聚合（单源失败不影响其它源）、`komiic.gql(query,variables)` 支持变量；新增独立路由 `routes/reading-search.js` 暴露 `GET /api/media-source/reading/search?kind=`（60s 内存缓存），在 `server.js` 挂到 `/api/media-source`。**安全**：该路由与 `searchAll` 两处都做 host 白名单（`www.dm5.com`/`manhua.zaimanhua.com`/`komiic.com`）+ 协议校验 + 拒绝 localhost/环回/私网/保留地址；用户输入只经 query 参数净化后编码进固定 URL，绝不当主机用。独立成文件是因为 `routes/media-source.js` 含代理任意 URL 的 `/seg`，Mimosa 对整文件做 SSRF 标记，独立文件便于把 host 校验写在同一处、静态可证。
- **前端**：`title-match.js` 新增 `chapterNo/pickChapter`（章号完整数字比较，避免 `includes('1')` 命中第 11 话）；`media-source.js` 书墙加「🌐 跨源」按钮与跨源面板，搜索结果按 `TitleMatch.score` 组内/组间排序并显示匹配徽标；详情与阅读器工具条各加「换源续读」，选中候选后带 `{resumeName, seedScroll, autoOpen}` 调 `openReadChapters`，按章节名在新源找同一章、把比例写进新源新章的 `cv:rdrScroll` key，自动开读到同章同比例；关详情返回书墙时若换过源则用新源重载目录；`round160-read-hub.css` 补跨源面板样式、matinee/whale 主题覆盖与移动端换行。

### 第四批验证

- `node scripts/title-match-regression.cjs`：通过。新增 `chapterNo` 与 `pickChapter` 断言。
- `node scripts/reading-cross-source-regression.cjs`：通过。mock `engine.grab` 验证三源结果结构、详情 URL（`/manhua-…`、`/details/{id}`、`/comics/{id}`）、封面全走 imgProxy、单源抛错时 `ok=false` 且其它源不受影响、`pickChapter` 匹配。
- `node scripts/pc-reading-search-probe.cjs`：真实站点通过。「海贼王」3 源全有结果（动漫屋 7 / 再漫画 8 / Komiic 1），「葬送的芙莉莲」3 源全有结果；首条候选均成功取到章节。
- `node scripts/reading-cross-source-gui.cjs`：真实隔离 Electron 通过。跨源面板打开、结果按匹配度分组排序、点候选进详情拿到 8 章、换源续读面板正常；Komiic 本次 fetch failed 但降级为「该源搜索失败」、未整页空白。
- 另：`online-history-regression.cjs`、`online-playback-regression.cjs` 复跑仍通过，前三批功能未被破坏。

### 第四批未做

- 小说跨源搜索/换源；阅读方向（日漫右开）、单双页、缩放偏好；线路健康统计与冷却。按交接文档排到后续批次。

## 下一批

1. 阅读方向（日漫右开）、单双页、缩放偏好等公共阅读设置复用。
2. 下载、投屏、超分等播放器增强，按 PC 实际使用优先级单独排期。
3. 自动换源失败后的线路健康统计与冷却时间；当前黑名单只在本次运行内有效。

