import unittest
from unittest.mock import MagicMock, patch
import os
import sys

BACKEND_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__)))
if BACKEND_DIR not in sys.path:
    sys.path.insert(0, BACKEND_DIR)

from server import (
    merge_source_with_canonical,
    _headset_review_snapshot,
    _shared_admin_candidate_snapshot,
    _filter_obsolete_pending_newbie_requests,
    _candidate_terminal_for_newbie_shift,
    _public_newbie_request,
)


class TestSamQueueCorrectness(unittest.TestCase):
    def test_merge_source_with_canonical_precedence(self):
        source = {
            "Status": "pending",
            "final_result": "Incomplete",
            "candidate_name": "Carlisa Speed",
            "custom_trainer_note": "Keep this note",
        }
        canonical = {
            "status": "approved",
            "final_result": "RESUMED-PASS",
            "candidate_name": None,
            "scheduled_at": "2026-08-15T12:00:00Z",
        }
        merged = merge_source_with_canonical(source, canonical)
        self.assertEqual(merged["status"], "approved")
        self.assertEqual(merged["final_result"], "RESUMED-PASS")
        self.assertEqual(merged["candidate_name"], "Carlisa Speed")
        self.assertEqual(merged["custom_trainer_note"], "Keep this note")
        self.assertEqual(merged["scheduled_at"], "2026-08-15T12:00:00Z")

    def test_headset_review_canonical_status_overrides_stale_payload(self):
        mock_provider = MagicMock()
        mock_provider.list_resource.side_effect = lambda resource, limit=5000: (
            [
                {
                    "id": "rev-1",
                    "status": "approved",
                    "brand": "Jabra",
                    "model": "Evolve2 65",
                    "source_payload": {
                        "Status": "pending",
                        "Brand": "Jabra",
                        "Model": "Evolve2 65",
                    },
                }
            ]
            if resource == "headset_reviews"
            else [
                {
                    "id": "cat-1",
                    "status": "approved",
                    "brand": "Jabra",
                    "model": "Evolve2 65",
                    "source_payload": {"Status": "approved"},
                }
            ]
        )
        with patch("server.configured_provider_mode", return_value="supabase"), \
             patch("server._get_active_data_provider", return_value=mock_provider):
            snapshot = _headset_review_snapshot()
            self.assertTrue(snapshot["ok"])
            self.assertEqual(len(snapshot["pending"]), 0)
            self.assertEqual(len(snapshot["approved"]), 1)

    def test_newbie_shift_request_source_session_and_candidate_exposed(self):
        row = {
            "request_id": "newbie-123",
            "session_id": "uuid-pk-session",
            "source_session_id": "human-session-id",
            "candidate_id": "cand-uuid",
            "request_type": "newbie_shift_initial",
            "candidate_name": "Rico Tester",
            "request_status": "pending",
        }
        public = _public_newbie_request(row)
        self.assertEqual(public["session_id"], "uuid-pk-session")
        self.assertEqual(public["source_session_id"], "human-session-id")
        self.assertEqual(public["candidate_id"], "cand-uuid")
        self.assertEqual(public["raw_status"], "pending")

    def test_filter_obsolete_excludes_terminal_candidate_via_source_session_id(self):
        requests = [
            {
                "id": "req-1",
                "session_id": "uuid-pk-session",
                "source_session_id": "human-session-id",
                "category": "newbie_initial",
                "raw_status": "pending",
                "candidate": "Rico Tester",
            },
            {
                "id": "req-2",
                "session_id": "active-uuid",
                "source_session_id": "active-human",
                "category": "newbie_initial",
                "raw_status": "pending",
                "candidate": "Active Incomplete Candidate",
            },
        ]
        candidate_tracking = {
            "candidates": [
                {
                    "session_id": "human-session-id",
                    "status": "Pass",
                    "candidate_name": "Rico Tester",
                },
                {
                    "session_id": "active-human",
                    "status": "Incomplete",
                    "candidate_name": "Active Incomplete Candidate",
                },
            ]
        }
        filtered = _filter_obsolete_pending_newbie_requests(requests, candidate_tracking)
        self.assertEqual(len(filtered), 1)
        self.assertEqual(filtered[0]["id"], "req-2")

    def test_filter_obsolete_does_not_filter_on_date_alone(self):
        requests = [
            {
                "id": "req-past",
                "session_id": "active-session",
                "source_session_id": "",
                "category": "newbie_initial",
                "raw_status": "pending",
                "candidate": "Non Terminal Past Date Candidate",
                "requested_schedule": "2020-01-01T10:00:00Z",
            }
        ]
        candidate_tracking = {
            "candidates": [
                {
                    "session_id": "active-session",
                    "status": "Incomplete",
                }
            ]
        }
        filtered = _filter_obsolete_pending_newbie_requests(requests, candidate_tracking)
        self.assertEqual(len(filtered), 1)
        self.assertEqual(filtered[0]["id"], "req-past")


if __name__ == "__main__":
    unittest.main()
