import os, sys, json, argparse
from _cv_patch_lib import build_manifest, diff_manifest, build_patch

ALLOWED = ['public/', 'routes/', 'utils/', 'server.js', 'package.json']

def cmd_gen_manifest(args):
    m = build_manifest(args.root, args.version, ALLOWED)
    json.dump(m, open(args.out, 'w', encoding='utf-8'), ensure_ascii=False, indent=2)
    print('manifest ->', args.out, 'files=', len(m['files']))

def cmd_gen_patch(args):
    base = json.load(open(args.baseline, encoding='utf-8'))
    target = json.load(open(args.target, encoding='utf-8'))
    d = diff_manifest(base, target)
    key = None
    if args.sign_key:
        from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
        key = Ed25519PrivateKey.from_private_bytes(bytes.fromhex(args.sign_key))
    blob = build_patch(args.root, d, target['version'], key)
    open(args.out, 'wb').write(blob)
    print('patch ->', args.out, 'bytes=', len(blob), 'diff=', d)

if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest='cmd', required=True)
    gm = sub.add_parser('gen-manifest')
    gm.add_argument('--root', required=True); gm.add_argument('--version', required=True); gm.add_argument('--out', required=True)
    gm.set_defaults(func=cmd_gen_manifest)
    gp = sub.add_parser('gen-patch')
    gp.add_argument('--root', required=True); gp.add_argument('--baseline', required=True); gp.add_argument('--target', required=True)
    gp.add_argument('--out', required=True); gp.add_argument('--sign-key', default=os.environ.get('CV_UPDATE_SIGNING_KEY', ''))
    gp.set_defaults(func=cmd_gen_patch)
    args = ap.parse_args(); args.func(args)
