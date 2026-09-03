import os
import unittest
from unittest.mock import MagicMock, patch

class SamSupabaseSharedDataTests(unittest.TestCase):
    """Hard regression tests ensuring zero Sheets/Apps Script calls in Supabase mode."""

    def setUp(self):
        self.env_patcher = patch.dict(os.environ, {
            "MTS_DATA_PROVIDER": "supabase",
            "MTS_SHADOW_COMPARE": "false",
            "MTS_DUAL_WRITE_ENABLED": "false",
            "MTS_DUAL_WRITE_DOMAINS": "[]",
        })
        self.env_patcher.start()

    def tearDown(self):
        self.env_patcher.stop()

    def _forbidden_sheets_context(self):
        raise AssertionError("CRITICAL REGRESSION: _shared_sheet_context() was called while MTS_DATA_PROVIDER=supabase!")

    def _mock_supabase_provider(self):
        provider = MagicMock()
        data_map = {
            "candidate_sessions": [
                {
                    "session_id": "sess-1",
                    "candidate_name": "Candidate Alpha",
                    "status": "PASS",
                    "created_at": "2026-08-30T10:00:00Z",
                    "completed_at": "2026-08-30T10:30:00Z",
                    "attempt_number": 1,
                    "final_attempt": False,
                    "withdrawn": False,
                    "archived": False,
                },
                {
                    "session_id": "sess-2",
                    "candidate_name": "Candidate Beta",
                    "status": "FAIL",
                    "created_at": "2026-08-30T11:00:00Z",
                    "completed_at": "2026-08-30T11:30:00Z",
                    "attempt_number": 1,
                    "final_attempt": False,
                    "withdrawn": False,
                    "archived": False,
                },
            ],
            "supervisor_transfers": [
                {
                    "pending_id": "transfer-1",
                    "source_session_id": "sess-2",
                    "candidate_name": "Candidate Beta",
                    "status": "pending",
                    "created_at": "2026-08-30T11:35:00Z",
                }
            ],
            "pending_requests": [
                {
                    "request_id": "req-1",
                    "source_session_id": "sess-2",
                    "candidate_name": "Candidate Beta",
                    "request_type": "newbie_shift_initial",
                    "category": "newbie_initial",
                    "status": "pending",
                    "created_at": "2026-08-30T11:40:00Z",
                }
            ],
            "headset_reviews": [
                {
                    "review_id": "rev-1",
                    "source_session_id": "sess-1",
                    "brand": "Logitech",
                    "model": "H390",
                    "status": "pending",
                    "created_at": "2026-08-30T10:05:00Z",
                }
            ],
            "headset_catalog": [
                {
                    "brand": "Logitech",
                    "model": "Zone Wireless",
                    "status": "approved",
                    "note": "Certified",
                }
            ],
        }
        provider.list_resource.side_effect = lambda resource, limit=5000: data_map.get(resource, [])
        return provider

    def test_shared_admin_snapshot_makes_zero_sheets_calls_in_supabase_mode(self):
        """_shared_admin_snapshot must return ok=True with zero Sheets/Apps Script calls."""
        import server
        mock_provider = self._mock_supabase_provider()
        with patch("server._shared_sheet_context", side_effect=self._forbidden_sheets_context), \
             patch("server._get_active_data_provider", return_value=mock_provider):
            snapshot = server._shared_admin_snapshot()
        self.assertTrue(snapshot.get("ok"), "Expected snapshot.ok to be True")
        self.assertIn("candidateTracking", snapshot)
        self.assertIn("pendingRequests", snapshot)
        self.assertIn("headsetReviews", snapshot)
        self.assertTrue(snapshot["candidateTracking"].get("ok"))
        self.assertTrue(snapshot["pendingRequests"].get("ok"))
        self.assertTrue(snapshot["headsetReviews"].get("ok"))

    def test_candidate_snapshot_views_and_groups_preserved_in_supabase_mode(self):
        """_shared_admin_candidate_snapshot preserves exact frontend views contract."""
        import server
        mock_provider = self._mock_supabase_provider()
        with patch("server._shared_sheet_context", side_effect=self._forbidden_sheets_context), \
             patch("server._get_active_data_provider", return_value=mock_provider):
            candidate_snapshot = server._shared_admin_candidate_snapshot()
        self.assertTrue(candidate_snapshot.get("ok"))
        self.assertEqual(len(candidate_snapshot.get("candidates", [])), 2)
        views = candidate_snapshot.get("views", {})
        for expected_key in ["pending", "failedNotFinal", "failedFinalAttempts", "incomplete",
                             "withdrawn", "extraAttemptGranted", "passedCertifications",
                             "archived", "allActive"]:
            self.assertIn(expected_key, views, f"Missing view key {expected_key}")

    def test_pending_requests_snapshot_counts_preserved_in_supabase_mode(self):
        """_shared_pending_request_snapshot formats counts and targeting correctly."""
        import server
        mock_provider = self._mock_supabase_provider()
        with patch("server._shared_sheet_context", side_effect=self._forbidden_sheets_context), \
             patch("server._get_active_data_provider", return_value=mock_provider):
            req_snapshot = server._shared_pending_request_snapshot()
        self.assertTrue(req_snapshot.get("ok"))
        self.assertEqual(len(req_snapshot.get("requests", [])), 1)
        self.assertIn("counts", req_snapshot)
        self.assertEqual(req_snapshot["targeting"]["mode"], "all_authorized_admins")

    def test_lookup_and_transfers_make_zero_sheets_calls_in_supabase_mode(self):
        """_lookup_shared_candidate_sessions and _get_shared_pending_sup_transfers bypass Sheets."""
        import server
        mock_provider = self._mock_supabase_provider()
        with patch("server._shared_sheet_context", side_effect=self._forbidden_sheets_context), \
             patch("server._get_active_data_provider", return_value=mock_provider):
            transfers = server._get_shared_pending_sup_transfers()
            lookup = server._lookup_shared_candidate_sessions("Beta")
        self.assertTrue(transfers.get("ok"))
        self.assertTrue(lookup.get("ok"))
        self.assertIn("attemptState", lookup)

    def test_supabase_error_does_not_fall_back_to_sheets(self):
        """When Supabase fails, snapshot returns ok=False without touching Sheets."""
        import server
        error_provider = MagicMock()
        error_provider.list_resource.side_effect = RuntimeError("Supabase network failure")
        with patch("server._shared_sheet_context", side_effect=self._forbidden_sheets_context), \
             patch("server._get_active_data_provider", return_value=error_provider):
            snapshot = server._shared_admin_snapshot()
        self.assertFalse(snapshot.get("ok"))
        self.assertFalse(snapshot["candidateTracking"].get("ok"))
        self.assertFalse(snapshot["pendingRequests"].get("ok"))
        self.assertFalse(snapshot["headsetReviews"].get("ok"))

if __name__ == "__main__":
    unittest.main()
