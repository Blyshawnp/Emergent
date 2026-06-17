import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import server  # noqa: E402


class CoachingDefaultsBackfillTests(unittest.TestCase):
    def test_custom_call_coaching_backfills_required_defaults_once(self):
        merged = server._sanitize_coaching_setting(
            "call_coaching",
            [
                {"id": "custom", "label": "Custom Coaching"},
                {"id": "c-search-name", "label": "Search name for every call"},
            ],
            "test",
        )

        labels = [item.get("label") for item in merged]
        self.assertEqual(labels.count("Custom Coaching"), 1)
        self.assertEqual(labels.count("Search name for every call"), 1)
        self.assertEqual(labels.count("Do not volunteer information"), 1)
        search_item = next(item for item in merged if item.get("label") == "Search name for every call")
        volunteer_item = next(item for item in merged if item.get("label") == "Do not volunteer information")
        self.assertEqual(
            search_item.get("helper"),
            "Search the caller's name on every call to avoid duplicate member records.",
        )
        self.assertEqual(
            volunteer_item.get("helper"),
            "Do not verify details the member has not provided, such as an email address.",
        )

    def test_custom_sup_coaching_backfills_required_defaults_once(self):
        merged = server._sanitize_coaching_setting(
            "sup_coaching",
            [
                {"label": "Custom Supervisor Coaching"},
                {
                    "label": "Do not volunteer information",
                    "helper": "Do not verify details the member has not provided, such as an email address.",
                },
            ],
            "test",
        )

        labels = [item.get("label") for item in merged]
        self.assertEqual(labels.count("Custom Supervisor Coaching"), 1)
        self.assertEqual(labels.count("Search name for every call"), 1)
        self.assertEqual(labels.count("Do not volunteer information"), 1)


if __name__ == "__main__":
    unittest.main()
