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
VER = '6.8.27'
TAG = 'v6.8.27'
# 按脚本位置推导（round24）：与 _r23-publish.py 同理，不写死开发机绝对路径。
_HERE = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.abspath(os.path.join(_HERE, '..'))
EXE = os.path.join(_ROOT, 'exe')


def _android_ver():
    """当前 Android 发行包版本号：优先 android-dist/android-version.json，回退 build.gradle。"""
    try:
        with open(os.path.join(_ROOT, 'android-dist', 'android-version.json'), encoding='utf-8') as f:
            v = str(json.load(f).get('versionName') or '').strip()
            if v:
                return v
    except Exception:
        pass
    try:
        import re
        with open(os.path.join(_ROOT, 'android', 'app', 'build.gradle'), encoding='utf-8') as f:
            m = re.search(r'versionName\s*=?\s*["\']([^"\']+)["\']', f.read())
            return m.group(1) if m else ''
    except Exception:
        return ''
# 成品落点（按顺序找第一个存在的）：
#   exe\<子目录>\    ← 整理后的自用区（round24 起本地只留免安装版，安装版/便携版通常不在这儿）
#   packaging\dist\ ← electron-builder 的默认产出目录（刚打完包就在这）
ASSETS = [
    ('CinemaVault-Setup-%s.exe' % VER, ['安装版', 'dist']),
    ('CinemaVault-Portable-%s.exe' % VER, ['便携版', 'dist']),
    # Android 安装包：与 PC 同一 Release 下发。版本号从 android-version.json 动态读，
    # 避免发新版 APK 时还得回来改这里（曾因写死 v5.1.0 导致上传被跳过）。
    ('CinemaVault-v%s-Android.apk' % _android_ver(), ['android-dist', 'out']),
]

# 增量热更新产物：发布者在跑本脚本前手动执行
#   python _cv_patch.py gen-manifest --root <root> --version <VER> --out out/cv-manifest-<VER>.json
#   python _cv_patch.py gen-patch --root <root> --baseline ... --target ... --out out/cv-patch-<from>-<to>.zip
# 脚本只识别并上传已生成的文件，不自动跑生成器（避免误发半成品）。
_OUT = os.path.join(_HERE, 'out')


def _extra_assets():
    """已生成的 manifest / patch 才加入上传清单（沿用下方上传/重试/跳过逻辑）。"""
    extra = []
    manifest = 'cv-manifest-%s.json' % VER
    if os.path.exists(os.path.join(_OUT, manifest)):
        extra.append((manifest, ['out']))
    if os.path.isdir(_OUT):
        for name in sorted(os.listdir(_OUT)):
            # 只上传目标版本的 patch，避免把历史 patch 一并带进来变成多余附件
            if name.startswith('cv-patch-') and name.endswith('-%s.zip' % VER) \
                    and os.path.isfile(os.path.join(_OUT, name)):
                extra.append((name, ['out']))
    return extra


ASSETS += _extra_assets()


def asset_path(name, subs):
    for sub in subs:
        if sub == 'dist':
            p = os.path.join(_HERE, 'dist', name)
        elif sub == 'out':
            p = os.path.join(_OUT, name)
        elif sub == 'android-dist':
            p = os.path.join(_ROOT, 'android-dist', name)
        else:
            p = os.path.join(EXE, sub, name)
        if os.path.exists(p):
            return p
    # 兼容根目录 exe/ 下直接命名的文件
    p_direct = os.path.join(EXE, name)
    if os.path.exists(p_direct):
        return p_direct
    return None
GIT = os.environ.get('GIT_EXE') or 'C:/Program Files/Git/cmd/git.EXE'

BODY = """本地优先的私人媒体库：AV / 里番 / 影视 / 动漫 / 漫画 / 小说 六库合一。数据全部留在本机。

## v6.8.27 · 后台分集下载 + 插件商店 + 2.4K 增强

- 后台分集下载：选源后点「⬇ 下载本季」，整季进入后台队列（最多 2 并发），关掉页面也会继续；下载任务抽屉可看进度、取消、打开文件位置。
- 2.4K 增强：下载时勾选「2.4K 增强」，ffmpeg 用 lanczos 放大到 2560×1440 并做轻锐化（确定性画质增强，不是 AI 超分；UI 已注明）。
- 插件商店：追番页「🧩 插件商店」列出全部在线源，支持搜索、按「网页规则 / JSON 接口 / Kazumi 规则」筛选、单个启停、全选/全不选，并可检查 Kazumi 规则更新。
- 稳定性：播放代理的 Referer/UA/Cookie token 抽成共享模块，播放与下载共用同一条代理链；下载走本机代理，避免 ffmpeg 直连源站被防盗链 400。

- 内置 Android v5.2.0 安装包。

首次升级到本版仍需全量一次；之后可增量。如有 bug 欢迎提 issue。"""


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
