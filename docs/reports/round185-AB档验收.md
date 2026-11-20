# round185 · A/B 档全量验收（→ v6.8.0）

> 日期：2026-11-20　模式：Agent
> 基线：v6.7.0（已发布）　目标：round184 清单里的 A 档（看番链路）+ B 档（管理与同步）

## 一、逐项达成情况

| 项 | 目标 | 状态 | 证据 |
|---|---|---|---|
| **A1** | 点「+ 追番」自动挂在线源 | **达成** | 真机 7/7：auto-attach 5.6s、命中「嘀嗒影视」19 集、分集 12/12 带 sourceUrl |
| **A1b** | 季号对齐（不会追第一季挂到第二季） | **达成** | `series-online.seasonOf()` + 降权 0.12；pickBest 单测：tier0 的「第二季」输给 tier5 的「第一季」 |
| **A2** | 失败五态分类 | **达成** | 真机 states = `{success:11, noResult:3, error:2, captcha:6, cooling:0}` |
| **A2b** | 人机验证救回（有头浏览器 + cookie 复用） | **达成（机制）** | `/api/media-source/verify` 实测 passed=true、storageState 导出正常；弹窗式 UI 入口已接 |
| **A2c** | 源冷却黑名单 | **达成** | 连续 3 次 error/captcha → 24h 冷却；`blacklist.json` 落盘；`/online-retry-source` 可手动解冻 |
| **A3** | `json-api` 工厂执行分支 | **达成** | 稀饭动漫 Next 实测：搜「冰之城墙」→ 2 条；`anime/3436` → 8 集；play 接口 → 真 mp4 签名地址 |
| **A3b** | 受限 JSONPath 沙箱 | **达成** | 只认 `$` / `.key` / `[*]`；拒绝 `[?(`, `..`, 切片, 函数调用 |
| **A4** | 在线播放路径弹幕/字幕/OPED | **达成（参数层）** | stub 验收：弹幕串 `冰之城墙 · 第1集` → `冰之城墙 第01话`；matchTitle 同步传给字幕库；`__svPlayingEpisode` 不再丢失 |
| **B1** | 追番 5 态 + 分组 | **达成** | UI 6 tab（全部/追番中/计划看/搁置/已完成/抛弃）；卡片按当前态显示其余 4 态按钮；状态徽章生效 |
| **B2** | Bangumi 冲突逐条选择 | **达成（逻辑）** | `diffFrom()` 单测：conflict/remoteOnly/localOnly 分类正确、重复计数已修；`/diff` + `/apply` 路由就绪 |
| **B3** | 进度 Bangumi 双键 | **达成** | episodes.bangumiEpisodeId + bangumi_progress 账本；实测写入同步、清空后 restore 恢复 300s/1440 |

## 二、EXE 真机验收（`_r185-verify-exe.js`）

```
✅ health/env 可访问 — appVersion=6.7.0 node=22.22.0
✅ runtime series-view.js 含自动挂源 — len=32865
✅ runtime series-view.js 含验证入口
✅ runtime 存在 series-online.js
✅ runtime 存在 verify.js
✅ GET /media-source/verify-status — {"busy":null}
✅ POST /series/auto-attach 路由存在 — 缺少 seriesId
✅ POST /series/match-online 路由存在 — 缺少搜索关键词
✅ GET /bangumi/diff 路由存在 — 未连接 Bangumi
✅ GET /media-source/freshness — count=24 stale=false
✅ series/list 正常 — rows=3
✅ DB 计数可读 — {"movies":9378,"actresses":1875,"tags":294}
===== 12/12 通过 =====
```

> appVersion=6.7.0 是**预期**：此时跑的是旧壳 + 新 runtime 代码，正式版号在打包后。

## 三、真机在线闭环（`_r185-verify-online.js`）

```
✅ auto-attach 返回成功 — 5.6s | 源=嘀嗒影视 挂=19/19 匹配=冰之城墙
✅ 至少挂了 1 集
✅ 状态分布有内容 — {"success":11,"noResult":3,"error":2,"captcha":6,"cooling":0}
✅ 分集写入了在线源 — 12/12 集带 sourceUrl
✅ 分集 episodeNo 正常 — 第1集=1 标题=1
✅ episode/online-url 可读 — 源=嘀嗒影视
✅ 清理测试番
===== 7/7 通过 =====
```

## 四、前端 UI 验收（`_r185-ui-check.js`）

```
tabs: ["全部","追番中","计划看","搁置","已完成","抛弃"]
cards: 1 | 卡片按钮: ["追番中","计划看","已完成","抛弃","移除"]
状态徽章: ["搁置"]
详情弹窗: {"modal":true,"onlineBtn":true,"epRows":7}
Bangumi 面板: acts 含 diff
页面错误: 无
```

## 五、踩坑记录（可复用）

1. **`json-api` 请求缺 Content-Type** —— `grab()` 只带 UA/Accept，非 GET 请求 fetch 会按 `text/plain` 发出，Supabase 那类 RPC 网关**静默忽略 body 并返回默认列表**。现象是「搜什么都能搜到但全不相关」，比报错更难查。
2. **订阅规则的选择器是「分组内相对」的** —— `$.episodes[*]` 要对着 `sources[i]` 求值，直接对顶层文档求值一条都取不到。
3. **`applyOnlineSource` 曾假定 season 已存在** —— 首次挂源（backfill 未跑/AniList 不可达）会报「季度不存在」，真因完全看不出来。改为自建季。
4. **标题归一化把 `【】` 当括号删** —— `【我推的孩子】` vs `我推的孩子` 直接 0 分。`【】` 是装饰不是注释，只去符号留内容。
5. **归一化抹掉季号导致两季同分** —— 「冰之城墙」和「冰之城墙第二季」都是 1.00，必须按季号降权。
6. **`diffFrom` 重复计数** —— 同一个番既进 conflict 又进 localOnly（localOnly 只判断了 provider 没判断是否已配对）。
7. **在线播放没传 `__svPlayingEpisode`** —— 只有「播本地」分支设了，在线看番时 OP/ED 跳过读不到 DB 区间。
8. **在线流白跑一次字幕扫描** —— `else if (/\.mp4/)` 把 http 直链当本地路径传给 `/api/player/subtitles`。

## 六、诚实边界

- **弹幕真拉取未验**：`config.danmaku` 未配置 AppId/AppSecret，只验到「匹配串清洗正确」这一层。等配置后可再确认一次。
- **B2 未连 Bangumi 实测**：本机无 token，`diffFrom` 用 mock 数据验了分类/去重/建议方向，真实网络往返（分页、限流、updated_at 时区）未验。
- **验证码救回只验了机制**：选了一个无 cookie 的源跑通流程（passed=true / 存了 0 条 cookie），没在真实 Cloudflare 挑战页上过一遍。
- **C/D 档按用户决定移交手机端**，本轮未动。
