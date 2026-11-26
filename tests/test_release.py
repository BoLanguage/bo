import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools"))

import release  # noqa: E402


class ReleaseChangelog(unittest.TestCase):
    def render(self, text):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "CHANGELOG.md"
            path.write_text(text, encoding="utf-8")
            with mock.patch.object(release, "CHANGELOG", path):
                return release.changelog_with_release("0.9.0", "2026-12-01")

    def test_unreleased_heading_becomes_the_release(self):
        text = "# Changelog\n\n## Unreleased\n\n- A change.\n\n## 0.8.5 (2026-11-22)\n\n- Old.\n"
        self.assertEqual(
            self.render(text),
            "# Changelog\n\n## 0.9.0 (2026-12-01)\n\n- A change.\n\n## 0.8.5 (2026-11-22)\n\n- Old.\n",
        )

    def test_a_missing_or_empty_unreleased_section_stops_the_release(self):
        for text in ("# Changelog\n\n## 0.8.5 (2026-11-22)\n\n- Old.\n",
                     "# Changelog\n\n## Unreleased\n\n## 0.8.5 (2026-11-22)\n\n- Old.\n"):
            with self.subTest(text=text), self.assertRaises(release.Stop):
                self.render(text)

    def test_versions_compare_numerically(self):
        self.assertLess(release.as_tuple("0.8.9"), release.as_tuple("0.8.10"))
        with self.assertRaises(release.Stop):
            release.check_preconditions("0.8", allow_dirty=True)


if __name__ == "__main__":
    unittest.main()
