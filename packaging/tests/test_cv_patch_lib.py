import unittest, tempfile, os, json
from _cv_patch_lib import build_manifest, diff_manifest, sign_payload, verify_payload

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

if __name__ == '__main__': unittest.main()
