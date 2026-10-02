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
VER = '2.4.0'
TAG = 'v2.4'
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

## v2.3 更新（底层 Chromium 140 大升级 + 全局 3D Remotion 动效重塑 + 深度交互打磨）

### ⚡ 底层核心升级（Chromium 140 + ES2025 原生支持）

- **Electron 33→38.8.6 升级**：内置 Chromium 底层从 130 跃升至 **140.0.7339.249**，Node.js 升级至 22.22.0
- **better-sqlite3 12.4.1 (ABI 139) 原生编译**：完全适配 Electron 38 原生二进制架构
- **PDF 阅读器双根因彻底根治**：
  - 采用 sessionStorage 消除 178 话兄弟目录传入 URL 时产生的 30KB 431 请求头溢出
  - 适配 Chromium 140 原生 ES2025 API（toHex / Map.getOrInsertComputed），告别 pdfjs 运行报错

### 🎬 视频截帧与视觉重塑

- **视频抽帧智能防黑帧算法**：检测生成图片字节与亮度色差；遇到多段拼接处或黑屏转场时自动执行多阶段时间戳跳跃避让（+4s/+8s/-4s/+15s），告别纯黑抽帧，且自带脏缓存自愈重抽
- **详情弹窗工具按钮重构**：14 枚 `.dbtn` 全面接入侧栏同款 **3D Remotion 实心光体 WebM+PNG** 双保险动效，鼠标悬停即刻重播立体演出；CSS 锁定为极简单行排列，永不折行
- **设置页左侧导航重构**：13 项设置全部升级为侧栏同款 3D Remotion 动效图标，悬停微缩放 + 专属色彩弥散光晕

### ✨ 动效系统与自定义扩展

- **设置页新增【动效设置】专属板块**：按本应用 14 种核心交互逻辑精细化分类定制（页面加载、弹窗对话框、轮播卡牌堆、卡片悬停、通知提示、导航标签栏、瀑布流级联、微交互触感、数字流动、搜索呼吸、滚动条、播放器悬浮岛、视差、渐进模糊），每类挂载 2~5 款真实 Skiper 方案并支持实时预览
- **自定义加载等待动画**：设置页支持上传任意 MP4/WebM/MOV/GIF，后端自动调用 Python + OpenCV + ffmpeg 执行智能背景抠像（自动识别黑底/白底/绿幕），等比居中缩放并转码为高质量透明 WebP 动图
- **随机推荐 3D 封面流轮播**：新增 3D Coverflow 舞台，支持每 3.2 秒自动顺滑巡航流转、鼠标悬停自动暂停、3D 鼠标透视视差景深追踪与浮空呼吸微动
- **内置播放器 iOS 视觉重构**：Apple TV / visionOS 磨砂玻璃风格，悬浮信息岛、圆角胶囊底栏与动态呼吸指示灯
- **在线观看站点多线路标签页系统**：站点栏升级为父子级架构，支持多线路镜像浮岛与新建标签，鼠标悬停平滑展开、移出自动收起隐藏
- **全局键盘方向键翻页**：所有功能页列表无死角支持 Left/Right 键上一页/下一页，详情弹窗内支持同级作品快速切片

## 下载

| 文件 | 说明 |
|---|---|
| `CinemaVault-Setup-2.3.0.exe` | **推荐** —— 标准安装版：装一次，桌面快捷方式双击秒开 |
| `CinemaVault-Portable-2.3.0.exe` | 绿色便携版：解压即用单文件，数据保存在 exe 同级的 `CinemaVault-Data\\` |

## 系统要求

- Windows 10 / 11（x64）
- 无需额外安装 Node.js 或 Chromium（已完整集成内置）

**如有 bug 或需求反馈，欢迎提 issue：https://github.com/INORIergai/local-acgn-app/issues**
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
