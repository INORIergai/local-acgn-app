# -*- coding: utf-8 -*-
"""
_r23-publish.py —— 用 GitHub REST API 把 git/ 全量推到远端仓库
==========================================================================
为什么不用 git push：
  1) 本机 git 直连 github.com:443 不稳定（ls-remote 超时），而 REST API 走系统代理稳定；
  2) 远端那个 2026-09-20 的旧提交里含 config.json / config.docker.json（个人目录结构、
     内网 IP），必须从 main 分支上撤掉。用「无父提交的孤儿 commit」一次性替换，
     旧提交就从分支上彻底不可达了。

用法：
  python _r23-publish.py check      # 只看要推什么，不写远端
  python _r23-publish.py push       # 推仓库内容
"""
import os
import sys
import json
import time
import base64
import urllib.request
import urllib.error
import subprocess
from concurrent.futures import ThreadPoolExecutor

OWNER = 'INORIergai'
REPO = 'local-acgn-app'
BRANCH = 'main'
# 按脚本位置推导（round24）：不写死开发机绝对路径 —— 换台机器 clone 下来就能直接跑，
# 也不会把作者的项目目录带进公开仓库。
# 本脚本要同时兼容两种落点，所以这里做了探测：
#   A) 开发树   <开发根>/packaging/_r23-publish.py  → 要推的是 <开发根>/git/
#   B) 公开仓库 <仓库根>/packaging/_r23-publish.py  → 仓库根自己就是待推内容
_HERE = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.abspath(os.path.join(_HERE, '..'))
PUB = os.path.join(_ROOT, 'git') if os.path.isdir(os.path.join(_ROOT, 'git')) else _ROOT
GIT = os.environ.get('GIT_EXE') or 'C:/Program Files/Git/cmd/git.EXE'
COMMIT_MSG = """v4.5.0：语音朗读真流式 + 网盘 OAuth 与在线阅读 + 界面性能与稳定性修复

- TTS 体系重构（round85~88）：Breeze-TTS-2 / IndexTTS-2 改常驻 worker（模型仅加载一次，状态机 progressMsg、GPU 崩溃降级 CPU），Breeze 真流式朗读（worker chunk → /api/tts/synthesize-stream → 前端 WebAudio 边收边播，热态首声 ~0.4s，预缓冲+重缓冲根治「每秒卡」）；IndexTTS-2 首次跑通（零样本克隆 29 音色，热 RTF≈1.1）；VITS 原神 MB 中文包（49 音色，热 RTF≈0.02）；阅读页语速滑块修复（defaultPlaybackRate+playbackRate 双写）、引擎感知分句切块、从当前页开始朗读、启动加载门 bootGate、聊天🔊语音开关、Live2D 流式口型
- 网盘接入（round91~103）：123 云盘 / 百度网盘 OAuth + 一键快速授权（Alist 公共通道）、token JWT exp 自愈不再每天误报未授权；网盘目录绑定 + 本地/网盘/全部三态切片；元数据备份到网盘 + 定时同步 + 保留份数清理；网盘封面本地映射库（EPUB/CBZ/ZIP Range 抽封面）；KOOB.ONE 在线阅读打通（书库式 EPUB 阅读器 + 卷选择 + 键盘翻页）；网盘阅读器接入统一阅读设置
- 界面与性能（round89/90/99）：全站 backdrop-filter 降级 + 极光无限动画停用；GPU 崩溃软渲染降级可观测并可恢复 + 弹窗暂停背景视频；玻璃态可读性修复；切片器分段按钮截字修复 + 动效；网盘卡片封面去黑罩；统计卡不再压系列胶囊；新作监视去重、Cookie 一键导入、封面批量重刮
- 稳定性修复：双击 EXE「有进程无窗口」修复（端口 HTTP 探测 + 收编孤儿后端）；内置站点整站反代 5 类通用缺陷修复（ES 模块加载/裸 JSON CDN Referer/innerHTML 内联图/脚本改写安全网）；漫画 EPUB 章节图片修复、未读海报去灰、站内信一键清除"""


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
    print('✗ 取不到 GitHub 凭据')
    sys.exit(1)
OPENER = urllib.request.build_opener(urllib.request.ProxyHandler())


def api(method, path, body=None, timeout=90, retries=5):
    """带重试的 GitHub API 调用。

    round25 实测：本机走宿主代理时，长连接偶发
      `SSL: UNEXPECTED_EOF_WHILE_READING` / `Tunnel connection failed: 502`
    —— 属于**瞬时**故障（同一路径立刻重试就好了）。原来一次性返回 0，
    导致 149 个 blob 全传完、最后「创建 commit」这一步被打断，白跑 8 分钟。
    这里对网络类异常与 5xx 做指数退避重试；4xx 直接返回（重试无意义）。
    """
    url = path if path.startswith('http') else 'https://api.github.com' + path
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
            if (e.code >= 500 or (e.code == 400 and 'malformed request' in txt)) and attempt < retries:
                last = (e.code, txt)
            else:
                return e.code, txt
        except Exception as e:
            last = (0, '%s: %s' % (type(e).__name__, str(e)[:220]))
            if attempt >= retries:
                return last
        wait = min(2 ** (attempt + 1), 20)
        print('  ! %s .../%s 失败（%s）→ %ds 后重试 %d/%d'
              % (method, path.rstrip('/').split('/')[-1], str(last[1])[:70], wait, attempt + 1, retries))
        sys.stdout.flush()
        time.sleep(wait)
    return last


# ---------------------------------------------------------------- 收集文件
def collect():
    out = []
    for dp, dns, fns in os.walk(PUB):
        dns[:] = [d for d in dns if d != '.git']
        for f in fns:
            p = os.path.join(dp, f)
            rel = os.path.relpath(p, PUB).replace('\\', '/')
            out.append((p, rel))
    return sorted(out, key=lambda x: x[1])


files = collect()
total_bytes = sum(os.path.getsize(p) for p, _ in files)

print('=' * 66)
print('仓库   : %s/%s  分支 %s' % (OWNER, REPO, BRANCH))
print('来源   : %s' % PUB)
print('文件数 : %d  合计 %.1f MB' % (len(files), total_bytes / 1048576))
print('=' * 66)
tops = {}
for _, rel in files:
    tops[rel.split('/')[0]] = tops.get(rel.split('/')[0], 0) + 1
for k in sorted(tops):
    print('  %-24s %d 个文件' % (k, tops[k]))

if len(sys.argv) > 1 and sys.argv[1] == 'check':
    print('\n(check 模式，未写远端)')
    sys.exit(0)

# ---------------------------------------------------------------- 当前远端状态
s, r = api('GET', '/repos/%s/%s' % (OWNER, REPO))
if s != 200:
    print('✗ 读仓库失败：%s %s' % (s, r))
    sys.exit(1)
print('\n远端默认分支: %s  |  private=%s' % (r.get('default_branch'), r.get('private')))
s, old = api('GET', '/repos/%s/%s/git/ref/heads/%s' % (OWNER, REPO, BRANCH))
old_sha = old.get('object', {}).get('sha') if s == 200 else None
print('旧 main sha: %s' % (old_sha or '(取不到)'))

# ---------------------------------------------------------------- 建 blob
print('\n上传 blob ...')
results = {}
errors = []
done = [0]


def make_blob(item):
    p, rel = item
    with open(p, 'rb') as fh:
        raw = fh.read()
    body = {'content': base64.b64encode(raw).decode('ascii'), 'encoding': 'base64'}
    st, res = 0, ''
    for attempt in range(5):
        st, res = api('POST', '/repos/%s/%s/git/blobs' % (OWNER, REPO), body)
        if st in (200, 201) and isinstance(res, dict) and res.get('sha'):
            break
        # 走系统代理偶尔会 RemoteDisconnected / 5xx，退避重试
        if st in (0, 429, 500, 502, 503, 504):
            time.sleep(1.2 * (attempt + 1))
            continue
        break
    done[0] += 1
    if st in (200, 201) and isinstance(res, dict) and res.get('sha'):
        results[rel] = res['sha']
    else:
        errors.append('%s -> %s %s' % (rel, st, res))
    if done[0] % 25 == 0 or done[0] == len(files):
        print('  %d/%d' % (done[0], len(files)))


with ThreadPoolExecutor(max_workers=2) as ex:
    list(ex.map(make_blob, files))

if errors:
    print('  ! %d 个 blob 需重试，转为单线程串行重试...' % len(errors))
    failed_items = [item for item in files if item[1] not in results]
    errors.clear()
    for item in failed_items:
        time.sleep(0.4)
        make_blob(item)

if errors:
    print('✗ 有 %d 个 blob 失败：' % len(errors))
    for e in errors[:8]:
        print('   ', e)
    sys.exit(1)
print('  ✅ %d 个 blob 就绪' % len(results))

# ---------------------------------------------------------------- 建 tree
print('\n创建 tree ...')
tree = [{'path': rel, 'mode': '100644', 'type': 'blob', 'sha': results[rel]} for _, rel in files]
s, res = api('POST', '/repos/%s/%s/git/trees' % (OWNER, REPO), {'tree': tree}, timeout=180)
if s not in (200, 201):
    print('✗ 建 tree 失败：%s %s' % (s, res))
    sys.exit(1)
tree_sha = res['sha']
print('  tree = %s' % tree_sha)

# ---------------------------------------------------------------- 建孤儿 commit
print('\n创建 commit（无父提交 → 旧提交从分支不可达）...')
s, res = api('POST', '/repos/%s/%s/git/commits' % (OWNER, REPO),
             {'message': COMMIT_MSG, 'tree': tree_sha}, timeout=120)
if s not in (200, 201):
    print('✗ 建 commit 失败：%s %s' % (s, res))
    sys.exit(1)
new_sha = res['sha']
print('  commit = %s' % new_sha)

# ---------------------------------------------------------------- 更新分支
print('\n更新 %s 分支 ...' % BRANCH)
s, res = api('PATCH', '/repos/%s/%s/git/refs/heads/%s' % (OWNER, REPO, BRANCH),
             {'sha': new_sha, 'force': True}, timeout=120)
if s not in (200, 201):
    print('✗ 更新分支失败：%s %s' % (s, res))
    sys.exit(1)
print('  ✅ %s 已指向 %s' % (BRANCH, res.get('object', {}).get('sha', new_sha)))

print('\n' + '=' * 66)
print('✅ 仓库内容推送完成')
print('   https://github.com/%s/%s' % (OWNER, REPO))
print('   旧提交 %s 已不在 %s 分支上' % (old_sha or '?', BRANCH))
print('=' * 66)
