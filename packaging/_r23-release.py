# -*- coding: utf-8 -*-
"""_r23-release.py —— 建 GitHub Release 并上传两个 exe 到 Releases 页"""
import os
import sys
import json
import time
import urllib.request
import urllib.parse
import urllib.error
import subprocess

OWNER = 'INORIergai'
REPO = 'local-acgn-app'
VER = '6.0.0'
TAG = 'v6.0.0'
# 按脚本位置推导（round24）：与 _r23-publish.py 同理，不写死开发机绝对路径。
_HERE = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.abspath(os.path.join(_HERE, '..'))
EXE = os.path.join(_ROOT, 'exe')
# 成品落点（按顺序找第一个存在的）：
#   exe\<子目录>\    ← 整理后的自用区（round24 起本地只留免安装版，安装版/便携版通常不在这儿）
#   packaging\dist\ ← electron-builder 的默认产出目录（刚打完包就在这）
ASSETS = [
    ('CinemaVault-Setup-%s.exe' % VER, ['安装版', 'dist']),
    ('CinemaVault-Portable-%s.exe' % VER, ['便携版', 'dist']),
]


def asset_path(name, subs):
    for sub in subs:
        p = (os.path.join(_HERE, 'dist', name) if sub == 'dist'
             else os.path.join(EXE, sub, name))
        if os.path.exists(p):
            return p
    # 兼容根目录 exe/ 下直接命名的文件
    p_direct = os.path.join(EXE, name)
    if os.path.exists(p_direct):
        return p_direct
    return None
GIT = os.environ.get('GIT_EXE') or 'C:/Program Files/Git/cmd/git.EXE'

BODY = """本地优先的私人媒体库：**AV / 里番 / 影视 / 动漫 / 漫画 / 小说** 六库合一。
自动扫描、多源刮削元数据与海报，自带网页播放器、漫画 / 小说阅读器、播放列表、新作监视、年度报告、首页情报榜。
界面原生 HTML/CSS/JS，后端 Node + SQLite，**数据全部留在本机**。

## v6.0.0 · 四皮肤与原生在线观看

这一版把「两套皮肤」变成**四套**（纸 / 夜 / 鲸鱼娘 / 墨），把在线观看和在线阅读从「套个浏览器窗口」换成应用内原生界面，顺手收掉首页 AI 卡的两处塌陷。

### 四套皮肤

- **鲸鱼娘 · Deep Whale**：深海底色 + 金色胶片齿孔 + 月光金描边，首屏专属立绘与馆藏刻度、深海玻璃 AI 卡、藏蓝热度榜；设置页主题卡直接用她的立绘做预览
- **墨 · Ink Archive**：墨黑底 + 哑光卡面 + 朱红顶线，宋体大标题「把午夜归档。」配 `ACCESSION NO.001` 档案卡，方角卡片与侧栏红条
- 纸 / 夜两套保留，四套可在顶栏或设置页切换，切换记忆；每套都有独立的主题立绘与配色令牌
- 鲸鱼娘立绘按人设基准重画：鲸鳍耳、荷叶边 maid 头饰、黑 choker、胸前金框蓝宝石、**人身人腿 + 身后小鲸鱼尾**（上一版是精灵耳 + 人鱼下半身）

### 在线观看：不再套浏览器

- 侧栏「AV 在线观看 / 里番在线观看」现在进的是应用自己的界面：板块切换、源站卡、源站分类胶囊、海报墙，不再是整站 iframe
- 网站在哪一页、换源、翻分类，全在应用内完成；源站改版只改一个适配器

### 在线阅读：原生目录 / 章节 / 正文

- 新增阅读适配层：**动漫屋（漫画）+ ESJ Zone（小说）** 的目录、章节、正文全部走原生界面，正文脚本与内联事件已清洗，图片走同源代理
- 小说 / 漫画入口**按类型分源**，不再互相串台；封面墙改 **3:4 竖版海报**（桌面 6 列 / 手机 2 列），不再是 16:9 横条
- 阅读层修两处实测 bug：翻下一章会把上一章的滚动位置存到新章名下（新章一打开就落在中间）、往回翻只剩 3%（单槽续读互相覆盖）
- 新增 MOBI 解析支持；目录抓取失败不再被缓存 5 分钟，空目录给「重试」按钮

### 首页 AI 卡

- 「＋ 新对话」后卡片不再瞬间缩成一条：消息区改内部滚动，长对话不撑高整张卡
- 首页双栏同高（AI 卡与热度情报同顶同底，误差 ≤1px）；去掉对话框上方多余的立绘占位
- 会话切换换成不透明自定义菜单 —— 原生下拉在深色皮肤下是半透明弹层，会把下面的立绘透出来

## v5.0.0 · 「典藏放映室」更新

这一版把界面从「能用的管理后台」改成了「有仪式感的私人放映室」：首页第一眼是今夜主映的放映台，竖版书封不再被 16:9 裁掉半张脸，两处把人文字压到看不见的对比度缺陷彻底修掉，卡了 9 秒的「猜你喜欢」变成瞬开。

### 首页：今夜主映 · 放映台

- 新增「今夜主映 · Curated Screening Stage」：35mm 胶片齿孔饰边 + 环境光模糊 + 3D 立书/立牌主视觉，一进来就有今天该看什么；支持「立即翻阅 / 立即放映」「藏品档案」「换一部」「AI 导读」
- 右侧新增 **Archive Pulse 馆藏脉搏**四格计数器（典藏小说 / 典藏漫画 / 馆藏影视 / 全馆总计，可点击直达）与 **Curated Reel 今夜候选胶片**六帧切换条
- AI 从「聊天机器人」升级为「典藏策展人」：状态头栏 + 4 枚一键胶囊（深夜私享单 / 科幻悬疑经典 / 完结漫画精选 / 馆藏盲盒），回复走完整富文本排版，不再把 `**` 和 `##` 源码吐到脸上

### 封面：3D 立书取代 16:9 腰斩

- 全部影片与猜你喜欢里的小说 / 漫画，竖版封面改为 **3D 书脊立书 + 同色系高斯模糊景深底衬**，不再被横向卡片裁成半张
- 没封面的藏品自动生成带藏书章的布面典藏扉页，不再是灰块
- 漫画库 / 小说库换 **亚麻布面藏书函套**（纸皮肤亚麻米 / 夜皮肤深焙胡桃），文件夹名自动拆成「作者铭牌 + 作品正题 + 完结/更新徽章 + 朱砂藏书章」；清洗 Z-Library 尾缀与重复括号，全库不再出现「第 ? 卷」（无卷号显示真实作者或 EPUB/PDF 典藏）

### 对比度：纸 / 夜双皮肤全达标

- **纸皮肤快捷键面板**：原来文字与背景对比只有 **1.43:1**（等于瞎），现在 **7.04:1**，88 项全部达标 —— 根因是只锁了文字色没锁背景色，浅底叠浅字
- **夜皮肤首页 AI 卡**：原来 **1.01:1**，现在 **7.07:1**；纸皮肤同处 7.30:1，双皮肤 0 项失败

### 性能：猜你喜欢 9.4 秒 → 0.2 秒

- 首屏内容到达从 **9,391ms 降到 153–279ms**（约 40 倍）：去掉每次请求 18,618 次同步 SQLite 查询与 9 秒同步 AI 阻塞，改为后台异步预热推荐池 + 观看历史亲和度 / 有封面优先的毫秒级召回
- 媒体树构建排序复用 `Intl.Collator`，从 ~1.5 秒降到 10 毫秒以内

### 交互与人体工学

- 打开详情自动收起首次引导遮罩，不再双层弹窗打架
- 移除常驻的黄色断网警告条；通知 toast 移到右上、后台扫描胶囊移到左下，不再压住搜索框
- 顶栏纸 / 夜切换带上文字标签，不再只有一个看不出状态的月亮图标；桌面端设置页左栏常驻展开（178px 中文分组全显示）；手机端语音球与扫描胶囊抬高到 Tab 栏之上

## v4.8 开发线（并入本版，未单独发布）

### AI 助手：对话内可点击播放卡片

- 「帮我看 XX」「播放 XX」不再在后台偷偷拉起播放器：工具一执行完，对话里立刻出现一张带海报的卡片（片名 / 番号 / 类型 / 播放 / 详情），**点一下才真的播**
- 搜索结果、随机推荐、续播、详情查询都会出卡片；同一条对话里同一部片只画一张，避免「搜一次 + 播一次」重复出现两张
- 卡片先于模型总结出现（工具一跑完就下发），不用等整段回答写完；模型若漏写卡片，收尾时再用全量补一次兜底

### 语音朗读：新增 Fish Audio 云端引擎

- 新增云端引擎（不占显存、不用等模型加载，首音约 1 秒），与 Breeze / GPT-SoVITS / VITS 并列可选；音色按 ID 选择，支持模型档位（免费档 / 付费档）与独立代理设置
- 「测试连接并合成一句」直接验证 Key 与代理是否可用，失败原因说人话（代理没开 / Key 过期 / 额度不足）
- **安全修复**：保存语音配置时不再把整份原始配置（含 API Key 明文）回吐给前端，只回脱敏串；试听/朗读接口不再写死 `.wav`，云端返回的 mp3 能正常播放
- **启动不再自动加载朗读引擎**（默认关闭）：只有真的点朗读才拉起模型，不再一开机就往显存里灌 GB 级模型

### 里番 / 动漫海报：竖版优先

- 刮削优先级重排：**AniList（官方竖版海报，无需浏览器）→ FANZA → 91动漫 → hanime（最后兜底）**
- 标题匹配大改：剥离字幕组 / 画质 / 方括号噪声，生成由严到宽的候选词逐个试；同时用 native / romaji / english 三个名字取最高分 —— 「Dearest Blue」对上「ディアレストブルー」这种跨语种同名不再被判 0 分
- hanime 源修三处真 bug：搜索参数名写错（`?q=` 返回的是「最新上传」而非匹配结果）、搜索结果已带签名封面却仍去详情页取不存在的 og:image、429 限流被误记成「未命中」（现在会区分「被限速」与「确实没有」并专项退避）
- 新增「Cloudflare 验证辅助」：设置页可一键自检本机浏览器环境、一键拉起有头浏览器打开 hanime 过验证；首次使用会说明「AniList 才是竖版主力源、hanime 只能给横版截图」

### 首页

- 首页左栏可选「AI 对话框 / Live2D 形象」两种展示（设置 → 外观 → 首页展示），选形象时看板娘与右侧情报栏齐平显示
- 修复侧栏拖动排序后重开被还原：隐私内容六项只在「历史布局里根本没有隐私组」时才强制归组，不再覆盖用户排序

## v4.7.0 更新

### AI 助手：可审计执行

- 新增后台作业层：起作业 → 拿 jobId → 后台串行跑 → 面板查进度。「批量换海报」这类小时级任务不再被单次工具超时熔断；取消是条间标志位，不会留下半个文件
- 新增「最近任务」入口（顶栏时钟胶囊）：运行中作业数角标、进度条、当前条目、一键取消；纸 / 夜双皮肤适配
- 批量换海报默认只出清单不写盘（dryRun），显式要求才会真正替换
- 成本与自愈：只读工具遇网络波动 / 限流自动重试（写操作绝不自动重试）；单轮 token 预算默认 6 万，超支即停但保留已有回答；同一调用反复失败直接拒执行、不再白烧步数

### AI 助手：执行过程可见

- 真流式输出：边跑边出字，长任务界面不再假死
- 高危操作改为单步审批卡：批的是哪一步就执行哪一步；批准后同一条对话流继续，不再重发整条消息
- 每步参数 / 耗时 / 结果落盘（JSONL），应用重启后仍可回放

### 界面

- 侧栏自定义布局改为服务端保存：换配置目录、清缓存、异常退出都不会丢布局；右键可一键恢复默认

## v4.6.0 更新

### 编辑改动真正落到原文件

- 修复「详情 → 编辑 → 刮削并填入 → 保存」后**磁盘文件名没变**的 bug：保存现在是「写库 → 改名 → 写 NFO」三步，视频按「番号 标题」改名，同名 `.nfo` / 封面一并跟随，界面会如实报出改了哪些；文件不在线、目标重名、被占用时明确告知而不是谎报成功
- 修复手改标题被扫描冲回：新增手改字段锁（`manualFields`），扫描一律让路，只有显式「重新挖掘 · 覆盖」才会改变
- 新增开关「编辑保存后同步改写原文件」（设置 → 刮削数据源 → 文件重命名，默认开启）
- 存量 2858 部视频的文件命名统一为「番号 标题」：剥离标题里自带的 `[番号]` 包裹、归一非标准连字符、保留 CD 分片标记；实际改名 1560 个文件，改名后逐条核对路径与 NFO

### 界面

- AI 助手工作台与详情弹窗改为 30% 毛玻璃（10–85% 可调 + 四个预设），可单独关闭
- 对话气泡收口、技能指令改玻璃胶囊、输入框改悬浮胶囊

### 入库

- 新增入库四步自愈：信息补全 → 海报匹配替换（只接受通过几何校验的候选）→ 完整度校验 → 打标，入库后自动完成，不需要人工确认

### AI 工具

- 修复「执行物理改名」工具只回一句「文件已被重命名」、实际没有任何文件操作的问题，现在真实改名并回传校验结果

## v4.5.4 更新

### 局域网访问修复

- 修复手机无法通过局域网地址 / 二维码打开网页的问题：IP 探测改为优先取默认路由出口网卡，不再误选 Hyper-V 等虚拟网卡（虚拟网段手机不可达）；枚举兜底时排除虚拟网卡名并按常见局域网网段优先级挑选
- 修复设置页二维码下方常显「二维码加载失败」的假提示（内联样式 display 重复声明互相覆盖导致）

## v4.5.3 更新

### 构建与分发修复

- 修复免安装版构建产物未随版本同步的问题（旧版免安装 exe 启动后持续误报「发现新版本」，实际运行的还是旧代码）；安装版 / 便携版 / 免安装版三渠道版本一致
- 统一版本号管理（package.json / lock / 发布脚本六处落点同步），清理 v4.5 之前的旧版本安装包

### 主题与稳定性

- 午夜放映厅主题适配收尾与界面稳定性改进

## v4.5.2 更新

### 午夜放映厅主题

- 新增可记忆、可随时切换的独立视觉主题：暖黑放映室、琥珀灯光、片名衬线排版和胶片资料馆卡片。
- 适配深浅模式，并覆盖影片库、首页情报榜、本周放送、阅读展台和设置界面。

## v4.5.1 更新

### 前端缓存优化

- 海报 URL 改用稳定缓存文件名；普通重扫不再导致整页海报逐张重新传输。

### v4.5.0 更新

### 🗣 语音朗读体系重构（真流式）

- **常驻引擎**：Breeze-TTS-2 / IndexTTS-2 改为常驻进程，模型只加载一次（约 30 秒），彻底解决「每句都重新加载、首句等一两分钟」；加载进度（loading → warming → ready）实时可见
- **Breeze 真流式朗读**：worker 逐块推送 PCM、前端边收边播（约 1 秒粒度），热态「点朗读到出声」从整块合成时间降到约 0.4 秒；配合预缓冲 + 重缓冲，治好「每秒卡一下」
- **IndexTTS-2 首次跑通**：零样本音色克隆，29 个音色，热态 RTF≈1.1（约为 Breeze 的两倍速）
- **VITS 原神 MB 中文包**：cjke 中文血统、49 个中文母语音色、热态 RTF≈0.02（最快），设置面板一键切换
- **阅读页语速**：修复滑块无效（播放速率被重置）、按引擎智能分句切块（不再「超长段落久久没声」）、支持「从当前页开始朗读」
- **启动加载门**：启动时全屏加载提示，朗读引擎就绪后自动揭开（可手动跳过）
- 聊天框新增 🔊 语音开关；Live2D 伴侣接入流式口型同步

### ☁️ 网盘接入与在线阅读

- **123 云盘 / 百度网盘 OAuth 授权**：内置完整授权流程 + 「一键快速授权」（走公共通道，免注册开发者应用）；token 过期时间按 JWT 自愈，不再每天误报「未授权」
- **网盘目录绑定**：漫画 / 小说 / 影视库支持「本地 / 网盘 / 全部」三态切片，可聚合浏览
- **数据同步 / 备份**：元数据一键备份到网盘、自动定时同步（10 分钟 ~ 12 小时）、保留份数清理（敏感 token 不上云）
- **网盘封面库**：EPUB / CBZ / ZIP 容器内封面按 Range 本地抽取缓存，不写回网盘
- **KOOB.ONE 在线阅读打通**：书库式 EPUB 阅读器，卷选择器 + 章节图片资源 + 键盘翻页；网盘阅读器接入统一阅读设置（字体 / 行高 / 页边距 / 翻页动画，与本地阅读器共用）

### 🎨 界面与性能

- **毛玻璃性能优化**：全站 backdrop-filter 降级（滚动 / 切换 / 悬停不再整块重算模糊），极光皮肤无限动画停用
- **显卡崩溃可观测**：显存冲突导致的软渲染降级现在会明确提示并可恢复；打开弹窗自动暂停背景装饰视频
- **玻璃态可读性**：AI 工作台卡片对比度提升，浅色皮肤下文字清晰
- **切片器**：修复「本地 / 网盘 / 全部」分段按钮被截字，补按下 / 切换动效
- **网盘卡片**：修复封面被半透明遮罩压暗（被误看成「未读灰」）；系列胶囊行不再被统计卡遮挡
- 新作监视去重、Cookie 一键导入、封面批量重刮

### 🔧 稳定性修复

- 修复「双击 EXE 有进程却无窗口」（端口探测改为 HTTP 探测 + 收编孤儿后端进程）
- 修复内置在线站点整站反代的 5 类通用缺陷（ES 模块加载、JSON 误判、CDN 来源校验、内联样式图片、脚本改写安全网）——影响全部内置在线站点
- 修复漫画 EPUB 章节内图片破损、未读海报被压暗
- 站内信支持一键清除

## 下载

| 文件 | 说明 |
|---|---|
| `CinemaVault-Setup-6.0.0.exe` | **推荐** —— 标准安装版：装一次，桌面快捷方式双击秒开 |
| `CinemaVault-Portable-6.0.0.exe` | 绿色便携版：单文件，数据保存在 exe 同级的 CinemaVault-Data 目录 |

## 系统要求

- Windows 10 / 11（x64）
- 无需额外安装 Node.js 或 Chromium（已完整集成内置）
- 使用 VITS / Breeze / IndexTTS 语音朗读需本机有 Python 3.10+ 及 torch 等依赖（设置页一键体检会提示缺哪些包）
- 语音朗读建议本机有 NVIDIA 显卡（无 GPU 会自动降级 CPU，速度较慢）

**如有 bug 或需求反馈，欢迎提 issue：https://github.com/INORIergai/local-acgn-app/issues**"""


def get_token():
    r = subprocess.run([GIT, 'credential', 'fill'],
                       input='protocol=https\nhost=github.com\n\n',
                       capture_output=True, text=True,
                       encoding='utf-8', errors='replace')
    for line in r.stdout.splitlines():
        if line.startswith('password='):
            return line.split('=', 1)[1].strip()
    return None


TOKEN = get_token()
if not TOKEN:
    print('✗ 取不到凭据')
    sys.exit(1)

OPENER = urllib.request.build_opener(urllib.request.ProxyHandler())


def api(method, url, body=None, timeout=120, retries=5):
    """带重试的 GitHub API 调用（round25 加）。

    本机走宿主代理时偶发 `SSL: UNEXPECTED_EOF_WHILE_READING` / 502 Bad Gateway，
    属瞬时故障；对网络异常与 5xx 做指数退避重试，4xx 直接返回。
    """
    if not url.startswith('http'):
        url = 'https://api.github.com' + url
    data = json.dumps(body).encode('utf-8') if body is not None else None
    last = (0, '')
    for attempt in range(retries + 1):
        req = urllib.request.Request(url, data=data, method=method)
        req.add_header('Authorization', 'Bearer ' + TOKEN)
        req.add_header('Accept', 'application/vnd.github+json')
        req.add_header('User-Agent', 'cinema-vault-release')
        if data:
            req.add_header('Content-Type', 'application/json')
        try:
            r = OPENER.open(req, timeout=timeout)
            raw = r.read().decode('utf-8')
            return r.status, (json.loads(raw) if raw.strip() else {})
        except urllib.error.HTTPError as e:
            txt = e.read().decode('utf-8', 'replace')[:500]
            if e.code >= 500 and attempt < retries:
                last = (e.code, txt)
            else:
                return e.code, txt
        except Exception as e:
            last = (0, '%s: %s' % (type(e).__name__, str(e)[:250]))
            if attempt >= retries:
                return last
        wait = min(2 ** (attempt + 1), 20)
        print('  ! %s .../%s 失败（%s）→ %ds 后重试 %d/%d'
              % (method, url.rstrip('/').split('/')[-1], str(last[1])[:70], wait, attempt + 1, retries))
        sys.stdout.flush()
        time.sleep(wait)
    return last


# ------------------------------------------------------- 1) 建 / 取 release
s, rel = api('GET', '/repos/%s/%s/releases/tags/%s' % (OWNER, REPO, TAG))
if s == 200:
    print('release %s 已存在（id=%s）' % (TAG, rel['id']))
    release = rel
else:
    print('创建 release %s ...' % TAG)
    s, rel = api('POST', '/repos/%s/%s/releases' % (OWNER, REPO), {
        'tag_name': TAG,
        'target_commitish': 'main',
        'name': 'Cinema Vault %s · 午夜场' % TAG,
        'body': BODY,
        'draft': False,
        'prerelease': False,
    })
    if s not in (200, 201):
        print('✗ 建 release 失败：%s %s' % (s, rel))
        sys.exit(1)
    release = rel
    print('  ✅ release id=%s  tag=%s' % (rel['id'], rel['tag_name']))

print('  URL: %s' % release.get('html_url'))

# ------------------------------------------------------- 2) 上传附件
existing = {a['name']: a['size'] for a in release.get('assets', [])}
print('\n现有附件:', existing or '(无)')

upload_url = release['upload_url'].split('{')[0]

for name, subs in ASSETS:
    p = asset_path(name, subs) or os.path.join(_HERE, 'dist', name)
    if not os.path.exists(p):
        print('✗ 找不到 %s（已找过 exe\\%s 与 packaging\\dist）' % (name, '/exe\\'.join(subs)))
        continue
    size = os.path.getsize(p)
    if name in existing:
        print('\n[跳过] %s 已存在（%.1f MB）' % (name, existing[name] / 1048576))
        continue

    print('\n上传 %s（%.1f MB）...' % (name, size / 1048576))
    with open(p, 'rb') as fh:
        data = fh.read()

    url = '%s?name=%s' % (upload_url, urllib.parse.quote(name))
    req = urllib.request.Request(url, data=data, method='POST')
    req.add_header('Authorization', 'Bearer ' + TOKEN)
    req.add_header('Content-Type', 'application/octet-stream')
    req.add_header('User-Agent', 'cinema-vault-release')

    ok = False
    for attempt in range(3):
        t0 = time.time()
        try:
            r = OPENER.open(req, timeout=3600)
            res = json.loads(r.read().decode('utf-8'))
            print('  ✅ 完成 %.1fs  下载地址: %s' % (time.time() - t0, res.get('browser_download_url')))
            ok = True
            break
        except urllib.error.HTTPError as e:
            body = e.read().decode('utf-8', 'replace')[:300]
            print('  ✗ HTTP %s %s' % (e.code, body))
            if e.code in (422, 400):
                break
            time.sleep(5 * (attempt + 1))
        except Exception as e:
            print('  ✗ %s: %s' % (type(e).__name__, str(e)[:200]))
            time.sleep(5 * (attempt + 1))
    if not ok:
        print('  ⚠ %s 上传未成功，可在网页端手动补传' % name)

# ------------------------------------------------------- 3) 汇总
s, rel2 = api('GET', '/repos/%s/%s/releases/tags/%s' % (OWNER, REPO, TAG))
print('\n' + '=' * 66)
print('Release: %s' % rel2.get('html_url'))
print('标签   : %s' % rel2.get('tag_name'))
for a in rel2.get('assets', []):
    print('  %-34s %8.1f MB  %s' % (a['name'], a['size'] / 1048576, a['browser_download_url']))
print('=' * 66)
