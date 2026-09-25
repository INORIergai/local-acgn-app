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
COMMIT_MSG = """v1.0.3：新增自动更新（设置 → 版本 一键检查 / 下载 / 安装）

- 自动更新（utils/updater.js + routes/update.js，新增）：查询 GitHub 最新 Release
  并与本地版本比对，按形态（安装版 / 便携版）自动匹配安装包，流式下载带实时进度，
  下载后校验字节数，可一键关闭本程序并启动安装包
- 双通道取版本信息：GitHub Releases API 为主；接口限流或未配置时自动回退到
  GitHub Atom feed + expanded_assets 网页通道（实测 API 未认证限流 60 次/小时后
  网页通道仍可拿到版本号与安装包直链）
- 网络容错：代理可用时走「设置 → 数据源」配的代理，代理连不上自动改直连；
  瞬时网络错误指数退避重试（本机直连 GitHub 时通时断是真实场景）
- Electron 主进程把真实版本号写入 runtime/app-version.json 并注入 CV_APP_VERSION，
  后端因此能拿到 exe 的真实版本（此前设置页「关于」写死 1.0.0）
- 设置页新增「🆙 版本」分组：当前版本 / 检查更新 / 更新说明 / 进度条 / 立即安装 /
  打开下载目录；应用启动时静默检查一次，有新版本只在侧栏提示不打断使用
- 配置模板 config.example.json 补 update 段（repo / 是否包含预发布 / 自动下载）

- 目录监控（utils/dir-watch.js）：开应用自启动，不新增任何常驻进程/服务。
  双通道：Windows 文件系统事件（亚秒级，负责快）+ 轮询兜底（负责不漏）。
  轮询退避：起始 5 秒，每轮没扫到新增就翻倍，上限 1 小时；一有新增立刻回到 5 秒。
  稳定判据（size+mtime 两次采样一致才入库）挡住下载中的半成品；忽略 .part/.xltd/
  .crdownload 等临时后缀；同一文件失败 3 次后本会话不再重试（防空转）。
  新增接口 GET /api/scanner/watch-status、POST /api/scanner/watch-now（手动立即检查）、
  POST /api/scanner/watch-toggle；前端顶栏加「🔄 检查新增」与「监控 开/关」
- 刮削：「重新刮削」不再每次都全部失败（成功判据修正 + 放宽番号置信度闸门，
  结果侧仍强制番号完全一致）；番号-only 影片会自动联网补齐真实片名，
  刮削标题不再被文件名里的番号覆盖
- 数据库自愈：索引损坏自动检测并重建，修掉「改名 / 编辑标题保存失败」
  「演员库内容突然消失」这类伪装成前端 bug 的故障
- 海报健康：「一键自动补封面」按内容类型自动分流（视频多点位截帧 / PDF 页 /
  EPUB 内封面），截帧过小取最大一帧兜底
- 面板串号：「刮削失败」与「海报健康」不再互相顶替；换封面弹窗会话隔离
- 阅读器：漫画 PDF 可正常打开翻页；EPUB 正文插图可显示 + 滚动/翻页双模式
- 我的收藏展示设置；演员头像回填；标签库铺满网格；年度报告不再闪烁
- AI 设置「获取」可刷新模型列表；设置页五组内容错位已修
- 启动四库增量扫描过程可见；刮削失败清单可点开；新作监视 / 女优库恢复
- 项目只做 exe：Docker 脚手架（Dockerfile / docker-compose.yml /
  docker-entrypoint.js / .dockerignore）已退役，发布副本不再包含
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
