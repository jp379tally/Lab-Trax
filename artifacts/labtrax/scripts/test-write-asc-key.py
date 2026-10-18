import importlib.util
import stat
import subprocess
import tempfile
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location(
    "writer", Path(__file__).with_name("write-asc-key.py"),
)
writer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(writer)


class KeyWriterTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.path = Path(self.directory.name) / "test.p8"
        # Synthetic credential, never the environment's real ASC key.
        self.pem = subprocess.check_output([
            "openssl", "genpkey", "-algorithm", "EC",
            "-pkeyopt", "ec_paramgen_curve:P-256",
        ]).decode()

    def test_normal_and_encoded_newlines(self):
        for value in [self.pem, self.pem.replace("\n", "\\n"),
                      self.pem.replace("\n", " "), self.pem.replace("\n", "\r\n")]:
            writer.write_key(value, self.path)
            self.assertEqual(self.path.read_text(), self.pem)
            self.assertEqual(stat.S_IMODE(self.path.stat().st_mode), 0o600)

    def test_invalid_key_preserves_previous_file(self):
        writer.write_key(self.pem, self.path)
        for value in ["", "not a key", "-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----"]:
            with self.assertRaises(ValueError):
                writer.write_key(value, self.path)
            self.assertEqual(self.path.read_text(), self.pem)
        self.assertEqual(list(self.path.parent.glob(".asc-key-*")), [])

    def test_replaces_symlink_without_touching_target(self):
        target = self.path.parent / "unrelated"
        target.write_text("preserve")
        self.path.symlink_to(target)
        writer.write_key(self.pem, self.path)
        self.assertFalse(self.path.is_symlink())
        self.assertEqual(target.read_text(), "preserve")
        self.assertEqual(stat.S_IMODE(self.path.stat().st_mode), 0o600)

    def test_rejects_a_valid_key_on_the_wrong_curve(self):
        p384 = subprocess.check_output([
            "openssl", "genpkey", "-algorithm", "EC",
            "-pkeyopt", "ec_paramgen_curve:P-384",
        ]).decode()
        with self.assertRaises(ValueError):
            writer.write_key(p384, self.path)
        self.assertFalse(self.path.exists())


if __name__ == "__main__":
    unittest.main()
