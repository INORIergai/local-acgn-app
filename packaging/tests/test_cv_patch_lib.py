import unittest, tempfile, os, json
from _cv_patch_lib import build_manifest, diff_manifest, build_patch, sign_payload, verify_payload

class ManifestTest(unittest.TestCase):
    def test_manifest_lists_text_files_with_sha256_and_size(self):
        with tempfile.TemporaryDirectory() as root:
            os.makedirs(os.path.join(root, 'public', 'js'))
            p = os.path.join(root, 'public', 'js', 'app.js')
            open(p, 'w').write('console.log(1)')
            m = build_manifest(root, '6.8.3', ['public/', 'routes/', 'utils/'])
            self.assertEqual(m['version'], '6.8.3')
            entry = m['files']['public/js/app.js']
            self.assertEqual(entry['size'], len('console.log(1)'))
            self.assertEqual(len(entry['sha256']), 64)  # sha256 hex
            self.assertNotIn('node_modules', m['files'])

class DiffSignTest(unittest.TestCase):
    def test_diff_reports_added_modified_removed(self):
        base = {'files': {'a.js': {'sha256': '1'}, 'b.js': {'sha256': '2'}, 'c.js': {'sha256': '3'}}}
        target = {'files': {'a.js': {'sha256': '1'}, 'b.js': {'sha256': '9'}, 'd.js': {'sha256': '4'}}}
        d = diff_manifest(base, target)
        self.assertEqual(d, {'added': ['d.js'], 'modified': ['b.js'], 'removed': ['c.js']})

    def test_sign_verify_roundtrip_and_tamper(self):
        from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
        key = Ed25519PrivateKey.generate()
        pub = key.public_key()
        msg = b'hello'
        sig = sign_payload(msg, key)
        self.assertTrue(verify_payload(msg, sig, pub))
        self.assertFalse(verify_payload(b'tampered', sig, pub))

class PatchZipTest(unittest.TestCase):
    def test_patch_zip_has_changed_removed_and_signed_patch_json(self):
        import io, zipfile
        with tempfile.TemporaryDirectory() as root:
            open(os.path.join(root, 'x.js'), 'w').write('x')
            d = {'added': ['x.js'], 'modified': [], 'removed': ['old.js']}
            blob = build_patch(root, d, '6.8.3', None)
            z = zipfile.ZipFile(io.BytesIO(blob))
            names = set(z.namelist())
            self.assertIn('changed/x.js', names)
            self.assertIn('removed.json', names)
            meta = json.loads(z.read('patch.json'))
            self.assertEqual(meta['version'], '6.8.3')
            self.assertEqual(json.loads(z.read('removed.json')), ['old.js'])

    def test_patch_signature_is_real_and_verifies_with_canonical_bytes(self):
        """签名须写入 patch.json，且字节与客户端一致：键字母序、无空格、UTF-8。"""
        import io, zipfile
        from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
        with tempfile.TemporaryDirectory() as root:
            open(os.path.join(root, 'x.js'), 'w').write('x')
            d = {'added': ['x.js'], 'modified': [], 'removed': ['old.js']}
            key = Ed25519PrivateKey.generate()
            blob = build_patch(root, d, '6.8.3', key)
            meta = json.loads(zipfile.ZipFile(io.BytesIO(blob)).read('patch.json'))
            self.assertTrue(meta['signature'], 'patch.json 必须写入真实签名，不能是空串')
            # 客户端 canonical：字段子集 + sort_keys + 无空格 + UTF-8。
            payload = json.dumps(
                {k: meta[k] for k in ('version', 'added', 'modified', 'removed', 'sha256')},
                sort_keys=True, separators=(',', ':'), ensure_ascii=False,
            ).encode('utf-8')
            self.assertTrue(verify_payload(payload, meta['signature'], key.public_key()))


if __name__ == '__main__': unittest.main()
