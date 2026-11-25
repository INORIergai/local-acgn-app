# -*- coding: utf-8 -*-
"""覆盖上传 v6.8.28 的 patch/manifest 附件（修复 updateDir 路径后重新发布）"""
import os, sys, json, time, urllib.request, urllib.parse, urllib.error, subprocess

OWNER = 'INORIergai'
REPO = 'local-acgn-app'
VER = '6.8.28'
TAG = 'v' + VER
_HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(_HERE, 'out')
GIT = os.environ.get('GIT_EXE') or 'C:/Program Files/Git/cmd/git.EXE'

FILES = ['cv-manifest-%s.json' % VER, 'cv-patch-6.8.27-6.8.28.zip']


def get_token():
    r = subprocess.run([GIT, 'credential', 'fill'],
                       input='protocol=https\nhost=github.com\n\n',
                       capture_output=True, text=True, encoding='utf-8', errors='replace')
    for line in r.stdout.splitlines():
        if line.startswith('password='):
            return line.split('=', 1)[1].strip()
    return None


TOKEN = get_token()
if not TOKEN:
    print('✗ 取不到凭据')
    sys.exit(1)

OPENER = urllib.request.build_opener(urllib.request.ProxyHandler())


def api(method, url, body=None, timeout=120):
    if not url.startswith('http'):
        url = 'https://api.github.com' + url
    data = json.dumps(body).encode('utf-8') if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header('Authorization', 'Bearer ' + TOKEN)
    req.add_header('Accept', 'application/vnd.github+json')
    req.add_header('User-Agent', 'cinema-vault-release')
    if data:
        req.add_header('Content-Type', 'application/json')
    r = OPENER.open(req, timeout=timeout)
    raw = r.read().decode('utf-8')
    return json.loads(raw) if raw.strip() else {}


rel = api('GET', '/repos/%s/%s/releases/tags/%s' % (OWNER, REPO, TAG))
existing = {a['name']: a for a in rel.get('assets', [])}
upload_url = rel['upload_url'].split('{')[0]

for name in FILES:
    p = os.path.join(OUT, name)
    if not os.path.exists(p):
        print('✗ 缺文件', name)
        continue
    if name in existing:
        print('删除旧附件', name)
        api('DELETE', '/repos/%s/%s/releases/assets/%s' % (OWNER, REPO, existing[name]['id']))

    print('上传', name, '%.1f KB' % (os.path.getsize(p) / 1024))
    with open(p, 'rb') as fh:
        data = fh.read()
    url = '%s?name=%s' % (upload_url, urllib.parse.quote(name))
    req = urllib.request.Request(url, data=data, method='POST')
    req.add_header('Authorization', 'Bearer ' + TOKEN)
    req.add_header('Content-Type', 'application/octet-stream')
    req.add_header('User-Agent', 'cinema-vault-release')
    for attempt in range(3):
        try:
            r = OPENER.open(req, timeout=600)
            res = json.loads(r.read().decode('utf-8'))
            print('  ✅', res.get('browser_download_url'))
            break
        except Exception as e:
            print('  ✗', type(e).__name__, str(e)[:200])
            time.sleep(5 * (attempt + 1))
print('done')
