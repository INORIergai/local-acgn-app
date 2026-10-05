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
VER = '4.0.0'
TAG = 'v4.0'
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
    ('G_953000.pth', ['model', 'dist']),   # round77：VITS 权重（应用内按需下载）
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

## v4.0 更新

### 📚 系列自动归类（漫画 / 小说 / 动漫 / 影音）

- 扫描时按标题相似度（归一化 + 编辑距离 ≥0.8）自动归系列，剥离卷号 / 括号 / 扩展名噪声
- 根目录顶部胶囊显示系列名与册数，点击展开该系列全部作品；主界面同系列叠成**一摞卡牌**，点击展开成一张张海报
- 后端按「类型 + 父目录」分桶聚类，不同目录下的同名作品不会误合并

### 🎧 听书体验重构（对齐微信读书 / 番茄）

- **页驱动连播**：本页读完自动翻页 → 空页自动跳过 → 章末自动切下一章 → 全书读完标记完成
- 修复「严重漏段落」：播放循环原先把正在念的段硬切，改为播放结束事件驱动 + 后台预取流水线（段间无缝）
- 修复「自动跳回前页」与「自动下一章变成回首页」（章节索引未暴露给朗读器导致固定跳第 2 章）
- 支持**从当前页开始朗读**；朗读条可调音色 / 语速 / 自动连播

### 🗣 TTS 音色体系

- GPT-SoVITS 改为**音色**维度（千咲 / 夏以昼 / 爱弥斯 / 达妮娅 / 穗穗 / 绯雪 / 西格莉卡 / 尤诺），合成时热切换 GPT+SoVITS 权重并使用该音色自己的参考音频
- 每个音色可单独指定参考音；VITS 804 音色与 GPT 音色都在设置与小说朗读页同步
- 语速改由播放端无损变速，告别变尖失真

### 📖 排版修复

- EPUB 翻页模式「每页大片空白」：分页测量探针丢失 `data-html` 导致源码缩进被当正文，修复后同章页数 203 → 93

### ⬇ VITS 权重按需下载（本版新增）

- VITS 推理代码（147KB）随包体自带；**479MB 权重 G_953000.pth（804 音色）作为本 Release 的独立资产**
- 设置 → 语音朗读 一键下载，支持**断点续传 + 进度条 + 取消**；开机自检到 VITS 引擎缺权重时后台静默下载
- 若你本地已有 VITS 目录（如 Alife 整合包），直接沿用，不触发下载
- GPT-SoVITS 整合包体积约 10GB 且需自备音色，**不随本应用分发**，请自行下载后在设置里指定目录

## 下载

| 文件 | 说明 |
|---|---|
| `CinemaVault-Setup-4.0.0.exe` | **推荐** —— 标准安装版：装一次，桌面快捷方式双击秒开 |
| `CinemaVault-Portable-4.0.0.exe` | 绿色便携版：解压即用单文件，数据保存在 exe 同级的 `CinemaVault-Data\\` |
| `G_953000.pth` | **可选** —— VITS 权重（479MB，804 音色）。不装 VITS 无需下载；也可在应用设置里一键下载 |

## 系统要求

- Windows 10 / 11（x64）
- 无需额外安装 Node.js 或 Chromium（已完整集成内置）
- 使用 VITS 朗读需本机有 Python 3.10+ 及 torch 等依赖（设置页一键体检会提示缺哪些包）

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
