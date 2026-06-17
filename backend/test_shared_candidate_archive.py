import sys
import unittest
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import server  # noqa: E402


class SharedCandidateArchiveTests(unittest.TestCase):
    def test_pass_candidate_older_than_sixty_days_is_auto_archive_eligible(self):
        row = {
            "status": "Pass",
            "completed_at": "2026-03-01T12:00:00+00:00",
            "archived": "FALSE",
        }

        self.assertTrue(
            server._candidate_auto_archive_eligible(
                row,
                now=datetime(2026, 6, 1, tzinfo=timezone.utc),
            )
        )

    def test_failed_final_attempt_older_than_sixty_days_is_auto_archive_eligible(self):
        row = {
            "status": "FAIL-Final Attempt",
            "completed_at": "2026-03-01",
        }

        self.assertTrue(
            server._candidate_auto_archive_eligible(
                row,
                now=datetime(2026, 6, 1, tzinfo=timezone.utc),
            )
        )

    def test_active_or_ambiguous_candidates_are_not_auto_archived(self):
        now = datetime(2026, 6, 1, tzinfo=timezone.utc)
        self.assertFalse(server._candidate_auto_archive_eligible({"status": "INCOMPLETE", "completed_at": "2026-03-01"}, now=now))
        self.assertFalse(server._candidate_auto_archive_eligible({"status": "Fail", "completed_at": "2026-03-01"}, now=now))
        self.assertFalse(server._candidate_auto_archive_eligible({"status": "Pass", "completed_at": ""}, now=now))
        self.assertFalse(server._candidate_auto_archive_eligible({"status": "Pass", "completed_at": "2026-03-01", "archived": "TRUE"}, now=now))


if __name__ == "__main__":
    unittest.main()
