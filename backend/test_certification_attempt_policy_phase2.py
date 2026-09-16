import unittest
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))

import server  # noqa: E402


def failed_sessions(count, extra=0):
    return [
        {
            "session_id": f"cert-{index}",
            "attempt_number": index,
            "status": "Fail",
            "extra_attempts_granted": extra,
            "allowed_attempt_count": 3 + extra,
        }
        for index in range(1, count + 1)
    ]


class CertificationAttemptPolicyPhase2Tests(unittest.TestCase):
    def test_normal_and_extended_attempt_sequence(self):
        expected = [
            (0, 0, 1, False),
            (1, 0, 2, False),
            (2, 0, 3, True),
            (2, 1, 3, False),
            (3, 1, 4, True),
            (4, 2, 5, True),
        ]
        for used, extra, attempt, final in expected:
            with self.subTest(used=used, extra=extra):
                state = server.calculate_candidate_attempt_state(failed_sessions(used, extra))
                self.assertTrue(state["retry_allowed"])
                self.assertEqual(state["current_attempt"], attempt)
                self.assertEqual(state["max_attempts"], 3 + extra)
                self.assertEqual(state["final_attempt"], final)

    def test_exhaustion_blocks_normal_but_not_existing_supervisor_completion(self):
        state = server.calculate_candidate_attempt_state(failed_sessions(3))
        blocked = server.apply_certification_start_policy({"candidate_name": "Taylor"}, state)
        resumed = server.apply_certification_start_policy(
            {"candidate_name": "Taylor", "supervisor_only": True, "attempt_number": 3}, state
        )
        newbie = server.apply_certification_start_policy(
            {"candidate_name": "Taylor", "newbie_shift_request_type": "reschedule", "newbie_shift_counts_as_attempt": False}, state
        )
        self.assertFalse(blocked["ok"])
        self.assertEqual(blocked["error_code"], "CERTIFICATION_ATTEMPTS_EXHAUSTED")
        self.assertTrue(resumed["ok"])
        self.assertTrue(resumed["existing_session_completion"])
        self.assertEqual(resumed["session"]["attempt_number"], 3)
        self.assertTrue(newbie["ok"])
        self.assertTrue(newbie["existing_session_completion"])

    def test_physical_calls_do_not_change_certification_count(self):
        row = failed_sessions(1)[0]
        row["session_attempts"] = [{"id": f"call-{index}"} for index in range(1, 10)]
        state = server.calculate_candidate_attempt_state([row])
        self.assertEqual(state["counted_attempts"], 1)
        self.assertEqual(state["current_attempt"], 2)

    def test_exact_session_replay_does_not_increment_count(self):
        row = failed_sessions(1)[0]
        state = server.calculate_candidate_attempt_state([row, dict(row)])
        self.assertEqual(state["counted_attempts"], 1)
        self.assertEqual(state["current_attempt"], 2)

    def test_override_is_exact_and_does_not_change_allowance(self):
        state = server.calculate_candidate_attempt_state(failed_sessions(2))
        unchanged = server.apply_certification_start_policy({"final_attempt": True}, state)["session"]
        overridden = server.apply_certification_start_policy(
            {"final_attempt": False, "final_attempt_overridden": True}, state
        )["session"]
        toggled_back = server.apply_certification_start_policy(
            {"final_attempt": True, "final_attempt_overridden": True}, state
        )["session"]
        self.assertFalse(unchanged["final_attempt_overridden"])
        self.assertTrue(overridden["final_attempt_overridden"])
        self.assertFalse(overridden["final_attempt"])
        self.assertEqual(overridden["allowed_attempt_count"], 3)
        self.assertEqual(overridden["extra_attempts_granted"], 0)
        self.assertFalse(toggled_back["final_attempt_overridden"])

    def test_non_final_no_is_not_an_override(self):
        state = server.calculate_candidate_attempt_state([])
        result = server.apply_certification_start_policy(
            {"final_attempt": False, "final_attempt_overridden": True}, state
        )["session"]
        self.assertFalse(result["auto_final_attempt"])
        self.assertFalse(result["final_attempt_overridden"])

    def test_migration_has_replay_safe_override_notification_and_admin_wrapper(self):
        migration = (
            Path(__file__).resolve().parents[1]
            / "supabase/migrations/20260916000000_mts_final_attempt_override_alerts.sql"
        ).read_text(encoding="utf-8")
        required = [
            "create table mts_sam.final_attempt_overrides",
            "override_key text not null unique",
            "on conflict (override_key) do nothing",
            "insert into mts_sam.notifications",
            "on conflict (notification_id) do nothing",
            "create or replace function mts_sam.grant_sam_extra_attempt",
            "current_setting('request.jwt.claim.sub', true)",
            "role_key = 'administrator'",
            "mts_sam.grant_extra_attempt(",
            "set search_path = ''",
            "grant execute on function mts_sam.grant_sam_extra_attempt",
        ]
        for value in required:
            self.assertIn(value, migration)


if __name__ == "__main__":
    unittest.main()
