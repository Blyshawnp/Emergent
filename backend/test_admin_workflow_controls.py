import os
import sys
import unittest
from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock, patch

sys.path.insert(0, os.path.dirname(__file__))

from fastapi import HTTPException
from fastapi.testclient import TestClient

from server import (
    DEFAULT_SETTINGS,
    NEWBIE_REQUEST_INITIAL,
    NEWBIE_REQUEST_PENDING,
    NEWBIE_REQUEST_POLICY_APPROVED_ACTOR,
    NEWBIE_REQUEST_RESCHEDULE,
    _candidate_session_row,
    _get_headset_notification_mode,
    _is_newbie_shift_approval_required,
    _newbie_shift_request_row,
    _normalize_headset_notification_mode,
    _pending_sup_transfer_row,
    _sync_newbie_shift_request,
    app,
    db,
    normalize_settings_payload,
    sanitize_settings,
)


class AdminWorkflowControlsTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(app)

    # =============================================================
    # SETTINGS NORMALIZATION & ACCESS CONTROL
    # =============================================================

    def test_default_settings_include_admin_controls(self):
        """Default settings must have require_newbie_shift_approval=True and headset_notification_mode='all'."""
        self.assertIn("require_newbie_shift_approval", DEFAULT_SETTINGS)
        self.assertTrue(DEFAULT_SETTINGS["require_newbie_shift_approval"])
        self.assertIn("headset_notification_mode", DEFAULT_SETTINGS)
        self.assertEqual(DEFAULT_SETTINGS["headset_notification_mode"], "all")

    def test_sanitize_settings_defaults_and_preserves_values(self):
        """sanitize_settings should provide defaults and normalize mode."""
        sanitized = sanitize_settings({})
        self.assertTrue(sanitized["require_newbie_shift_approval"])
        self.assertEqual(sanitized["headset_notification_mode"], "all")

        custom = sanitize_settings({
            "require_newbie_shift_approval": False,
            "headset_notification_mode": "muted",
        })
        self.assertFalse(custom["require_newbie_shift_approval"])
        self.assertEqual(custom["headset_notification_mode"], "muted")

        invalid_mode = sanitize_settings({"headset_notification_mode": "invalid_value"})
        self.assertEqual(invalid_mode["headset_notification_mode"], "all")

    def test_normalize_settings_payload(self):
        """normalize_settings_payload correctly casts boolean and normalizes notification mode."""
        payload = {
            "require_newbie_shift_approval": False,
            "headset_notification_mode": "action_required_only",
        }
        res = normalize_settings_payload(payload)
        sets = res.get("$set", {})
        self.assertFalse(sets["require_newbie_shift_approval"])
        self.assertEqual(sets["headset_notification_mode"], "action_required_only")

    def test_non_admin_cannot_mutate_admin_controlled_settings(self):
        """Non-admin mutation of require_newbie_shift_approval or headset_notification_mode must be rejected."""
        with patch.dict(os.environ, {"MTS_ADMIN_TOKEN": "valid-admin-token"}):
            # Attempt mutation without admin token header -> 403 / 401
            res = self.client.put("/api/settings", json={"require_newbie_shift_approval": False})
            self.assertIn(res.status_code, (401, 403))

            res = self.client.put("/api/settings", json={"headset_notification_mode": "muted"})
            self.assertIn(res.status_code, (401, 403))

            # With valid admin token -> 200 OK
            res_admin = self.client.put(
                "/api/settings",
                json={"require_newbie_shift_approval": False, "headset_notification_mode": "muted"},
                headers={"X-MTS-Admin-Token": "valid-admin-token"},
            )
            self.assertEqual(res_admin.status_code, 200)

    # =============================================================
    # TEST 1 — APPROVAL ON
    # =============================================================

    def test_1_approval_on_creates_pending_request(self):
        """When approval is ON, new newbie shift requests default to pending status awaiting Admin action."""
        with patch.object(db.settings, "_read_document", return_value={"require_newbie_shift_approval": True}):
            session = {
                "candidate_name": "Alice Candidate",
                "session_id": "sess-100",
                "newbie_shift_request_id": "newbie-100",
                "newbie_shift_scheduled_at": "2026-09-01T10:00:00Z",
                "newbie_shift_timezone": "EST (Eastern)",
                "tester_name": "Bob Tester",
            }
            row, req_id = _newbie_shift_request_row(session)
            # request_status is at index 7
            status = row[7]
            self.assertEqual(status, "pending")
            self.assertEqual(req_id, "newbie-100")
            # Decision columns (index 19 decision_at, index 20 decision_by) should be empty
            self.assertEqual(row[19], "")
            self.assertEqual(row[20], "")

    # =============================================================
    # TEST 2 — APPROVAL OFF
    # =============================================================

    def test_2_approval_off_creates_policy_approved_request(self):
        """When approval is OFF, new newbie shift requests are auto-approved by policy with full schedule preserved."""
        with patch.object(db.settings, "_read_document", return_value={"require_newbie_shift_approval": False}):
            session = {
                "candidate_name": "Alice Candidate",
                "session_id": "sess-101",
                "newbie_shift_request_id": "newbie-101",
                "newbie_shift_scheduled_at": "2026-09-01T10:00:00Z",
                "newbie_shift_timezone": "EST (Eastern)",
                "tester_name": "Bob Tester",
                "newbie_shift_request_created_at": "2026-08-29T12:00:00Z",
            }
            row, req_id = _newbie_shift_request_row(session)
            status = row[7]
            decision_at = row[19]
            decision_by = row[20]

            self.assertEqual(status, "approved")
            self.assertEqual(decision_by, NEWBIE_REQUEST_POLICY_APPROVED_ACTOR)
            self.assertEqual(decision_at, "2026-08-29T12:00:00Z")
            self.assertEqual(req_id, "newbie-101")
            # Schedule and candidate data preserved
            self.assertEqual(row[2], "Alice Candidate")
            self.assertEqual(row[14], "2026-09-01T10:00:00Z")
            self.assertEqual(row[15], "EST (Eastern)")

    # =============================================================
    # TEST 3 — UNANSWERED REQUEST DOES NOT BLOCK SUPERVISOR TRANSFER
    # =============================================================

    def test_3_unanswered_newbie_request_does_not_block_supervisor_transfer(self):
        """Candidate with pending/unanswered newbie shift request can proceed and complete supervisor transfer."""
        session = {
            "candidate_name": "Charlie Transfer",
            "session_id": "sess-102",
            "call_1": {"result": "Pass"},
            "call_2": {"result": "Pass"},
            "call_3": {"result": "Pass"},
            "sup_transfer_1": {"result": "Pass"},
            "sup_transfer_2": {"result": "Pass"},
            "newbie_shift_request_id": "newbie-102",
            "newbie_shift_request_status": "pending",
            "newbie_shift_scheduled_at": "2026-09-02T14:00:00Z",
            "tester_name": "Bob Tester",
        }
        row, pending_id, needs_sup = _candidate_session_row(session, [])
        # Final status should be Pass
        shared_status = row[8]
        self.assertEqual(shared_status, "PASS")
        self.assertFalse(needs_sup)

    # =============================================================
    # TEST 4 — REQUEST DATE PASSES WITHOUT RESPONSE
    # =============================================================

    def test_4_passed_request_date_does_not_block_supervisor_transfer(self):
        """Candidate whose scheduled newbie shift date was in the past can still complete supervisor transfer."""
        session = {
            "candidate_name": "Past Candidate",
            "session_id": "sess-103",
            "call_1": {"result": "Pass"},
            "call_2": {"result": "Pass"},
            "call_3": {"result": "Pass"},
            "sup_transfer_1": {"result": "Pass"},
            "sup_transfer_2": {"result": "Pass"},
            "newbie_shift_request_id": "newbie-103",
            "newbie_shift_request_status": "pending",
            "newbie_shift_scheduled_at": "2026-08-01T10:00:00Z", # Past date
            "tester_name": "Bob Tester",
        }
        row, pending_id, needs_sup = _candidate_session_row(session, [])
        shared_status = row[8]
        self.assertEqual(shared_status, "PASS")

    # =============================================================
    # TEST 5 — HISTORY IMMUTABILITY ON SETTING TOGGLE
    # =============================================================

    def test_5_history_immutability_when_toggling_setting(self):
        """Existing approved, denied, or pending records are not rewritten when setting toggles."""
        # Case A: Existing denied request stays denied under approval OFF
        with patch.object(db.settings, "_read_document", return_value={"require_newbie_shift_approval": False}):
            session_denied = {
                "candidate_name": "Dan Denied",
                "session_id": "sess-104",
                "newbie_shift_request_id": "newbie-104",
                "newbie_shift_request_status": "denied",
                "newbie_shift_admin_decision_by": "Admin Alice",
                "newbie_shift_denial_reason": "No slots available",
            }
            row, _ = _newbie_shift_request_row(session_denied)
            self.assertEqual(row[7], "denied")
            self.assertEqual(row[20], "Admin Alice")
            self.assertEqual(row[21], "No slots available")

        # Case B: Existing approved request by human Admin stays attributed to human Admin under approval OFF
        with patch.object(db.settings, "_read_document", return_value={"require_newbie_shift_approval": False}):
            session_human = {
                "candidate_name": "Eve Human",
                "session_id": "sess-105",
                "newbie_shift_request_id": "newbie-105",
                "newbie_shift_request_status": "approved",
                "newbie_shift_admin_decision_by": "Human Supervisor",
                "newbie_shift_admin_decision_at": "2026-08-20T10:00:00Z",
            }
            row, _ = _newbie_shift_request_row(session_human)
            self.assertEqual(row[7], "approved")
            self.assertEqual(row[20], "Human Supervisor")
            self.assertEqual(row[19], "2026-08-20T10:00:00Z")

    # =============================================================
    # TEST 6 — CROSS-DEVICE CONFIG AUTHORITY
    # =============================================================

    def test_6_cross_device_config_authority(self):
        """Backend configuration is authoritative and returned accurately by get_settings."""
        with patch.object(db.settings, "find_one", new_callable=AsyncMock) as mock_find:
            mock_find.return_value = {
                "require_newbie_shift_approval": False,
                "headset_notification_mode": "muted",
            }
            res = self.client.get("/api/settings")
            self.assertEqual(res.status_code, 200)
            data = res.json()
            self.assertFalse(data["require_newbie_shift_approval"])
            self.assertEqual(data["headset_notification_mode"], "muted")

    # =============================================================
    # TEST 7 — POLICY AUDIT
    # =============================================================

    def test_7_policy_audit_decision_source_attribution(self):
        """Auto-approval under approval=OFF attributes to Policy (Auto-Approved), not a human Admin."""
        with patch.object(db.settings, "_read_document", return_value={"require_newbie_shift_approval": False}):
            session = {
                "candidate_name": "Frank Audit",
                "session_id": "sess-106",
                "newbie_shift_request_id": "newbie-106",
                "tester_name": "Tester Tim",
                "newbie_shift_request_created_at": "2026-08-29T14:30:00Z",
            }
            row, _ = _newbie_shift_request_row(session)
            status = row[7]
            decision_by = row[20]
            decision_at = row[19]

            self.assertEqual(status, "approved")
            self.assertEqual(decision_by, "Policy (Auto-Approved)")
            self.assertEqual(decision_at, "2026-08-29T14:30:00Z")
            # Verify no fake human Admin username is used
            self.assertNotEqual(decision_by, "Admin")
            self.assertNotEqual(decision_by, "Tester Tim")


if __name__ == "__main__":
    unittest.main()
