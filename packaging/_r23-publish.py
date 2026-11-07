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
TAG = 'v5.0.0'
# 按脚本位置推导（round24）：不写死开发机绝对路径 —— 换台机器 clone 下来就能直接跑，
# 也不会把作者的项目目录带进公开仓库。
# 本脚本要同时兼容两种落点，所以这里做了探测：
#   A) 开发树   <开发根>/packaging/_r23-publish.py  → 要推的是 <开发根>/git/
#   B) 公开仓库 <仓库根>/packaging/_r23-publish.py  → 仓库根自己就是待推内容
_HERE = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.abspath(os.path.join(_HERE, '..'))
PUB = os.path.join(_ROOT, 'git') if os.path.isdir(os.path.join(_ROOT, 'git')) else _ROOT
GIT = os.environ.get('GIT_EXE') or 'C:/Program Files/Git/cmd/git.EXE'
COMMIT_MSG = """v5.0.0：V5「典藏放映室」大改版 + 首页今夜主映放映台 + 双皮肤对比度全达标 + 猜你喜欢提速约 40 倍

【V5 视觉与信息架构】round150 量化评审 -> round151 改版
- 首页新增「今夜主映 · Curated Screening Stage」：35mm 胶片齿孔饰边 + 环境光模糊 + 3D 立书/海报主视觉，支持立即翻阅/放映、藏品档案、换一部、AI 导读
- 右侧新增 Archive Pulse 馆藏脉搏四格计数器与 Curated Reel 今夜候选胶片条；AI 升级为「典藏策展人」，配 4 枚一键策展胶囊
- 竖版书封不再被 16:9 裁切：3D 书脊立书 + 同色系高斯模糊景深底衬，无图藏品自动生成布面典藏扉页
- 漫画/小说库改亚麻布面藏书函套（纸=亚麻米 / 夜=深焙胡桃），解析文件夹命名拆成作者铭牌 + 正题 + 完结徽章 + 藏书章；全库 0 处「第 ? 卷」，清洗 Z-Library 尾缀
- 新增单文件收束层 public/css/round151-v5-edition.css

【对比度根治】round150 实锤的两处 P0
- 纸皮肤快捷键面板 1.43:1 -> 7.04:1：背景与前景成对锁死，不再只锁 color 不锁 background
- 夜皮肤首页 AI 卡 1.01:1 -> 7.07:1；纸 7.30:1 / 夜 7.07:1，双皮肤 88/88 项达标 WCAG AA/AAA
- AI 回复改 mdLite() 富文本渲染，0 裸露 ** 与 ##

【性能】
- 猜你喜欢首屏 9391ms -> 153~279ms：移除每次请求 18618 次同步 SQLite 查询与 9 秒同步 AI 阻塞，改后台异步预热 + 观看历史亲和度/有封面优先召回
- utils/media-tree.js 复用 Intl.Collator，树构建排序 ~1.5s -> <10ms

【交互人体工学】
- 详情弹窗自动收起首次引导遮罩，消除双层模态遮挡
- 移除常驻断网黄条；通知 toast 移右上、扫描胶囊移左下，不再压搜索框
- 顶栏纸/夜切换显式带文字标签；桌面端设置页左栏常驻展开；移动端语音球/扫描胶囊抬高到 Tab 栏之上

【v4.8 开发线上尚未单独发布的功能，并入本版】
- AI 对话内可点击播放卡片：utils/agent/cards.js 归一化工具返回并下发带海报卡片，点一下才播，同轮同片只画一张
- Fish Audio 云端 TTS：utils/tts/fishaudio-engine.js，音色 ID / 模型档位 / 独立代理；保存配置只回脱敏串（不回吐 apiKey）
- 里番竖版海报优先：AniList -> FANZA -> 91动漫 -> hanime；hanime 搜索参数 ?q= -> ?query= 等三处真 bug
- 首页左栏可选 AI 对话框 / Live2D 形象；修复隐私六项强制归组覆盖用户拖动排序
- 女优头像串行补齐队列 utils/actress-avatar-queue.js
- 前端缓存版本号修正：motion-v2 ?v=9、tts-panel ?v=23"""


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

# ---------------------------------------------------------------- 建 commit
# ★round152：原来是「无父提交的孤儿 commit」，当初是为了把含 config.json 的旧提交
# 从 main 上彻底抹掉（一次性清理）。现在历史已经干净了，再砍父提交等于每次发布都把
# main 的历史清零 —— 改成「接在远端 main 后面」，保留完整提交历史。
print('\n创建 commit（父提交 = 远端 main %s）...' % (old_sha or '(无)'))
_commit_body = {'message': COMMIT_MSG, 'tree': tree_sha}
if old_sha:
    _commit_body['parents'] = [old_sha]
s, res = api('POST', '/repos/%s/%s/git/commits' % (OWNER, REPO), _commit_body, timeout=120)
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

# ---------------------------------------------------------------- 打 tag
print('\n创建 tag %s ...' % TAG)
s, res = api('GET', '/repos/%s/%s/git/ref/tags/%s' % (OWNER, REPO, TAG))
if s == 200:
    print('  tag 已存在，改为指向新 commit ...')
    s, res = api('PATCH', '/repos/%s/%s/git/refs/tags/%s' % (OWNER, REPO, TAG),
                 {'sha': new_sha, 'force': True}, timeout=60)
else:
    s, res = api('POST', '/repos/%s/%s/git/refs' % (OWNER, REPO),
                 {'ref': 'refs/tags/' + TAG, 'sha': new_sha}, timeout=60)
if s in (200, 201):
    print('  ✅ tag %s -> %s' % (TAG, new_sha))
else:
    print('  ! tag 创建失败：%s %s' % (s, res))

print('\n' + '=' * 66)
print('✅ 仓库内容推送完成')
print('   https://github.com/%s/%s' % (OWNER, REPO))
print('   上一条 main: %s' % (old_sha or '?'))
print('=' * 66)
