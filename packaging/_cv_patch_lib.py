import os, hashlib, datetime, io, zipfile, json

def _sha256(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(1 << 20), b''):
            h.update(chunk)
    return h.hexdigest()

def build_manifest(root, version, allowed_prefixes):
    files = {}
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d != 'node_modules']
        for name in filenames:
            full = os.path.join(dirpath, name)
            rel = os.path.relpath(full, root).replace(os.sep, '/')
            if not any(rel.startswith(p) for p in allowed_prefixes):
                continue
            files[rel] = {'sha256': _sha256(full), 'size': os.path.getsize(full)}
    return {
        'version': version,
        'generatedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
        'files': files,
        'binaryDirs': [],
        'fullFallback': {},
    }

import base64

def diff_manifest(baseline, target):
    b, t = baseline.get('files', {}), target.get('files', {})
    added = sorted(k for k in t if k not in b)
    removed = sorted(k for k in b if k not in t)
    modified = sorted(k for k in t if k in b and t[k]['sha256'] != b[k]['sha256'])
    return {'added': added, 'modified': modified, 'removed': removed}

def _key_from_env_or_obj(key):
    return key

def sign_payload(payload, key):
    sig = key.sign(payload)
    return base64.b64encode(sig).decode('ascii')

def verify_payload(payload, sig_b64, pubkey):
    try:
        pubkey.verify(base64.b64decode(sig_b64), payload)
        return True
    except Exception:
        return False

# patch.json 中参与签名的字段（顺序无关；客户端按同样字段拼 canonical JSON 验签）。
_SIGN_FIELDS = ('version', 'added', 'modified', 'removed', 'sha256')


def _canonical(payload):
    """客户端一致的 canonical JSON：键字母序、无空格、UTF-8。"""
    return json.dumps(payload, sort_keys=True, separators=(',', ':'),
                      ensure_ascii=False).encode('utf-8')


def build_patch(root, diff, target_version, sign_key):
    added = diff.get('added', [])
    modified = diff.get('modified', [])
    removed = diff.get('removed', [])
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, 'w', zipfile.ZIP_DEFLATED) as z:
        for rel in added + modified:
            z.write(os.path.join(root, rel.replace('/', os.sep)), 'changed/' + rel)
        z.writestr('removed.json', json.dumps(removed, ensure_ascii=False))
        meta = {
            'version': target_version,
            'added': added,
            'modified': modified,
            'removed': removed,
            'sha256': {rel: _sha256(os.path.join(root, rel.replace('/', os.sep)))
                       for rel in added + modified},
            'signature': '',
        }
        if sign_key:
            meta['signature'] = sign_payload(
                _canonical({k: meta[k] for k in _SIGN_FIELDS}), sign_key)
        z.writestr('patch.json', json.dumps(meta, ensure_ascii=False))
    return buf.getvalue()
