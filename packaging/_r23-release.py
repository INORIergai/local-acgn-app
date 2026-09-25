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
VER = '1.0.3'
TAG = 'v' + VER
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
    return None
GIT = os.environ.get('GIT_EXE') or 'C:/Program Files/Git/cmd/git.EXE'

BODY = """本地优先的私人媒体库：**影片 / 动漫 / 漫画 / 小说** 四合一。
自动扫描、多源刮削元数据与海报，自带网页播放器、漫画 / 小说阅读器、播放列表、新作监视、年度报告。
界面原生 HTML/CSS/JS，后端 Node + SQLite，**数据全部留在本机**。

## v1.0.3 更新

- **自动更新（新）**：「设置 → 🆙 版本」可一键查询 GitHub 上是否发布了新版本，并直接下载安装
  - 应用启动时**静默检查一次**，有新版本只在设置页图标上提示，不打断使用
  - 显示新版本的**更新说明**、发布时间、文件大小；按你当前用的是安装版还是便携版**自动匹配对应的安装包**
  - 下载有**实时进度条**（百分比 / 已下字节 / 速度），可随时取消；下完点「立即安装」自动关闭本程序并启动安装包
  - 下载完会**校验字节数**，下坏了不会让你装一个坏包；网络不通时提示可去「设置 → 🌐 数据源」配代理
  - GitHub 接口限流（未登录每小时 60 次）时**自动改走网页通道**，不会因此查不到更新

## v1.0.2 更新（桌面版实测反馈修复）

- **目录监控（新）**：**应用一启动就自动开始**，不用点任何开关 —— 新下载的片子秒级被发现，自动入库、刮削片名、补封面
  - 两条通道：Windows 文件系统事件（负责快，亚秒级）+ 轮询兜底（负责不漏，事件收不到时也能发现）
  - **轮询会自己变懒**：起始 5 秒一次，每轮没扫到新增就翻倍，最长 1 小时才查一次；一有新文件立刻回到 5 秒
  - 下载到一半的文件不会被误入库（体积不再变化才判定完成）；`.part` / `.xltd` / `.crdownload` 等临时文件直接忽略
  - 顶栏新增「🔄 检查新增」按钮可随时手动查一次（只看增量，比全量扫描快得多），旁边「监控 开/关」可随时暂停
- **刮削**：「重新刮削」不再每次都全部失败 —— 修正成功判据、放宽番号置信度闸门（结果侧仍强制番号完全一致，不会配错图）
- **片名自动补全**：只有番号的影片会自动联网补齐真实片名；刮削到的标题不再被文件名里的番号覆盖
- **数据库自愈**：索引损坏会被自动检测并重建 —— 修掉「改名 / 编辑标题提示保存失败」「演员库内容忽然消失」这类看起来像前端 bug 的故障
- **海报健康**：「一键自动补封面」按内容类型自动分流（视频多点位截帧 / PDF 内容页 / EPUB 内封面），截帧过小也会取最大一帧兜底
- **面板串号**：「刮削失败」与「海报健康」两个面板的操作不再互相顶替；换封面弹窗做了会话隔离
- **启动扫描**：启动时四库增量扫描的过程变得可见
- **刮削失败清单**：每条记录都可以点开
- **新作监视 / 女优库**：修复损坏数据库导致的加载失败
- 后端只保留桌面版形态（Docker 部署已下线）

> v1.0.1 的修复（漫画 PDF 阅读器、EPUB 插图与双阅读模式、收藏展示设置、演员头像、标签库网格、年度报告闪烁、AI 设置模型列表、设置页错位）全部包含在当前版本中。

## 下载

| 文件 | 说明 |
|---|---|
| `CinemaVault-Setup-1.0.3.exe` | **推荐** —— 安装版：装一次，桌面快捷方式双击秒开 |
| `CinemaVault-Portable-1.0.3.exe` | 免安装单文件，数据存在 exe 同级的 `CinemaVault-Data\\` |

> 便携版每次启动都要把约 90MB 运行时解压到临时目录，**首次打开要等 20 秒上下**。
> 安装版没有这一步，装好后是秒开。图省事就选安装版。

**不需要装 Node、不需要 Docker。**

## 首次启动

1. 双击运行 → 自动建库（约 1 秒）
2. **默认不设密码，打开就能用**
3. 进「设置 → 📂 扫描路径」添加你的媒体文件夹 → 点「扫描」
4. 想加访问密码：「设置 → 🔒 安全与通知」勾选「进入影库需要输入密码」，填至少 4 位并保存

## 系统要求

- Windows 10 / 11（x64）
- 无需额外运行时（Electron 已内置）

## 说明

- 本程序只管理**你自己合法拥有**的本地媒体文件，不上传任何数据到服务器。
- **未做代码签名**，Windows SmartScreen 可能提示「未知发布者」→ 点「更多信息 → 仍要运行」。
- 首次启动「闪一下就没了」= 本机 Chromium 沙箱不可用（第三方杀软 / 企业安全策略 / 远程桌面环境常见）。
  程序会自己记下来，**再双击一次即可**恢复正常。
- 可选依赖：`ffmpeg`（视频截帧取封面 / 读时长，放进数据目录的 `bin\\` 即可）、Chromium（过 Cloudflare 的站点刮削）。
"""


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
        'name': 'Cinema Vault v%s · 午夜场' % VER,
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
