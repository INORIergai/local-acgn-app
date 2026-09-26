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
VER = '1.0.5'
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

BODY = """本地优先的私人媒体库：**AV / 里番 / 影视 / 动漫 / 漫画 / 小说** 六库合一。
自动扫描、多源刮削元数据与海报，自带网页播放器、漫画 / 小说阅读器、播放列表、新作监视、年度报告、首页情报榜。
界面原生 HTML/CSS/JS，后端 Node + SQLite，**数据全部留在本机**。

## v1.0.5 更新（首页情报中心 + 影视 / 动漫双新库）

### 🏠 首页改版

- **启动直达首页**：不再一打开就逼你选功能入口；分类导航点击时才校验密码（如已设置）
- 小人看板娘**重新抠图**（长发完整保留）、加浮出突出效果、对话框加大
- **ACG 情报榜**覆盖来源站全部板块（动漫 / 漫画 / 游戏等），热榜两排排布，内容密度更高；本地片库热度榜同屏对照
- 榜单点击**全部在应用内展示**（作品详情弹窗），不再跳浏览器

### 📚 影视库 / 动漫库（新）

- 原「影片库」更名 **AV 库**、「动漫库」更名 **里番库**；新增真正的**影视库**与**动漫库**
- 影视库：**TMDB** 刮削（中文片名 / 简介 / 海报；「设置 → 数据源」填入免费 API Key 即生效），豆瓣备用
- 动漫库：**AniList + Bangumi** 刮削；扫描路径与各库独立配置
- 与现有库完全同构：扫描 / 刮削 / 海报健康 / 年度报告 / 新作监视全覆盖，不漏功能

### 🔒 安全

- 密码守卫改**白名单制**：未解锁时除首页 / 情报榜等公开页外一律拦截，弹应用内检票框
- 密码边界覆盖聚合视图（年度报告 / 刮削失败 / 海报健康切片同样受保护）

### 🔔 通知中心

- **站内信收件箱** + 右下角**分级 toast**（信息 / 成功 / 警告 / 错误）
- **个性化通知偏好**：7 类事件 × 4 种提醒方式（站内信+弹窗 / 仅站内信 / 仅弹窗 / 关闭），按需开关
- 目录监控入库、扫描完成、数据库自愈、发现新版本等事件全部接入

### 🔎 榜单联动与切片器

- 榜单作品一键「**去观看**」：直达在线观看 / 漫画站点并**自动带词搜索**，全程应用内不跳浏览器
- 演员库 / 标签库新增**切片器**；新作监视七分类切片（影视 / 动漫 / 里番 / AV / 漫画 / 小说 / 全部）
- 年度报告 / 刮削失败 / 海报健康支持按库切片

> v1.0.3 及以前的更新（自动更新、目录监控、刮削修复、数据库自愈、阅读器修复等）全部包含在当前版本中。

## 下载

| 文件 | 说明 |
|---|---|
| `CinemaVault-Setup-1.0.5.exe` | **推荐** —— 安装版：装一次，桌面快捷方式双击秒开 |
| `CinemaVault-Portable-1.0.5.exe` | 免安装单文件，数据存在 exe 同级的 `CinemaVault-Data\\` |

> 便携版每次启动都要把约 90MB 运行时解压到临时目录，**首次打开要等 20 秒上下**。
> 安装版没有这一步，装好后是秒开。图省事就选安装版。

**不需要装 Node。**

## 首次启动

1. 双击运行 → 自动建库（约 1 秒）
2. **默认不设密码，打开就能用**
3. 进「设置 → 📂 扫描路径」添加你的媒体文件夹（影视 / 动漫库各有独立路径配置）→ 点「扫描」
4. 影视库想用 TMDB 刮削：「设置 → 🌐 数据源」填入 TMDB API Key（themoviedb.org 免费申请）
5. 想加访问密码：「设置 → 🔒 安全与通知」设置密码；未解锁时受保护页面会弹检票框

## 系统要求

- Windows 10 / 11（x64）
- 无需额外运行时（Electron 已内置）

## 说明

- 本程序只管理**你自己合法拥有**的本地媒体文件，不上传任何数据到服务器。
- **未做代码签名**，Windows SmartScreen 可能提示「未知发布者」→ 点「更多信息 → 仍要运行」。
- 首次启动「闪一下就没了」= 本机 Chromium 沙箱不可用（第三方杀软 / 企业安全策略 / 远程桌面环境常见）。
  程序会自己记下来，**再双击一次即可**恢复正常。
- 可选依赖：`ffmpeg`（视频截帧取封面 / 读时长，放进数据目录的 `bin\\` 即可）、Chromium（过 Cloudflare 的站点刮削）。

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
