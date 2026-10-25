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
VER = '4.7.0'
TAG = 'v4.7.0'
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
| `CinemaVault-Setup-4.7.0.exe` | **推荐** —— 标准安装版：装一次，桌面快捷方式双击秒开 |
| `CinemaVault-Portable-4.7.0.exe` | 绿色便携版：单文件，数据保存在 exe 同级的 CinemaVault-Data 目录 |

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
