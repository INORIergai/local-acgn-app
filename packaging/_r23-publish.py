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
COMMIT_MSG = """v1.0.5：首页情报中心 + 影视/动漫双新库 + 通知中心 + 切片器

- 首页改版：启动直达首页（分类导航点击时才校验密码）；看板娘重新抠图（长发完整）
  + 浮出效果 + 对话框加大；ACG 情报榜覆盖来源站全部板块、热榜两排、本地片库热度同屏
- 榜单应用内详情：作品详情弹窗（fankuhub 官方接口 / acghub JSON-LD），不再跳浏览器
- 榜单一键「去观看」：直达在线观看 / 漫画站点并自动带词搜索，全程应用内
- 影视库（新）：TMDB 刮削（api.tmdb.org 主域名 + 双域名回退），豆瓣备用；
  扫描路径独立配置，与现有库同构（扫描 / 刮削 / 海报健康 / 年度报告 / 新作监视）
- 动漫库（新）：AniList（isAdult 参数化）+ Bangumi（镜像可配）刮削
- 原「影片库」更名 AV 库、「动漫库」更名里番库
- 密码守卫白名单制：server.js 页面级 302 移除，公开页白名单外一律 401，
  前端 gate.js 应用内检票框统一捕获；密码边界覆盖聚合视图切片
- 演员库 / 标签库切片器；新作监视七分类切片；年度报告 / 刮削失败 / 海报健康按库切片
- 通知中心（utils/notify.js + routes/notification.js）：站内信收件箱 + 右下角分级
  toast + 个性化偏好（7 事件 × 4 提醒方式）；目录监控入库 / 扫描完成 / 数据库自愈 /
  发现新版本等事件接入，前端 15s 轮询
- 首页 + ACG 情报榜（round33，utils/acg-rank.js + routes/acg.js + home.js）
- 应用内自动更新、目录监控等 v1.0.3 能力全部保留
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
            if e.code >= 500 and attempt < retries:
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


with ThreadPoolExecutor(max_workers=4) as ex:
    list(ex.map(make_blob, files))

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
