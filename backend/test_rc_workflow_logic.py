import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import server  # noqa: E402


class ReleaseCandidateWorkflowLogicTests(unittest.TestCase):
    def test_full_session_newbie_shift_keeps_failed_call_out_of_fail_summary(self):
        session = {
            "candidate_name": "Candidate",
            "call_1": {"result": "Fail", "fails": {"Skipped parts of script": True}},
            "call_2": {"result": "Pass"},
            "call_3": {"result": "Pass"},
            "newbie_shift_data": {"newbie_date": "2026-06-23", "newbie_time": "10:00 AM", "newbie_tz": "ET"},
        }

        self.assertEqual(server.compute_final_status(session), "Incomplete")
        self.assertEqual(server.generate_summaries(session)["fail"], "N/A")
        payload = server.build_form_fill_payload(session, {})
        self.assertEqual(payload["skills"], ["Mock Calls", "Supervisor Transfer"])
        self.assertEqual(payload["mock_complete"], "Yes")
        self.assertEqual(payload["sup_complete"], "No")
        self.assertEqual(payload["all_complete"], "No")
        self.assertEqual(payload["fail_reason"], "N/A")
        self.assertIn("Call 1", server.build_clean_fail(session))

    def test_supervisor_only_newbie_shift_form_mapping(self):
        session = {
            "candidate_name": "Candidate",
            "supervisor_only": True,
            "newbie_shift_data": {"newbie_date": "2026-06-23"},
        }
        payload = server.build_form_fill_payload(session, {})
        self.assertEqual(payload["skills"], ["Supervisor Transfer"])
        self.assertEqual(payload["mock_complete"], "Yes")
        self.assertEqual(payload["sup_complete"], "No")
        self.assertEqual(payload["all_complete"], "No")
        self.assertEqual(payload["fail_reason"], "N/A")

    def test_final_readiness_fail_and_needs_retest_require_fail_summary(self):
        base = {
            "candidate_name": "Candidate",
            "call_1": {"result": "Pass"},
            "call_2": {"result": "Pass"},
            "sup_transfer_1": {"result": "Pass"},
        }
        for result in ("Fail", server.FINAL_READINESS_NEEDS_RETEST):
            session = {
                **base,
                "finalReadinessJudgment": {
                    "overrideApplied": True,
                    "calculatedResult": "Pass",
                    "overrideResult": result,
                    "primaryReason": "Evaluator judgment",
                },
            }
            self.assertNotEqual(server.generate_summaries(session)["fail"], "N/A")
            self.assertNotEqual(server.build_form_fill_payload(session, {})["fail_reason"], "N/A")

    def test_only_session_ending_technical_issue_requires_summary(self):
        resolved = {"candidate_name": "Candidate", "tech_issue": "Discord issues", "tech_issue_ended_session": False}
        ended = {**resolved, "tech_issue": "Discord issues - unresolved", "tech_issue_ended_session": True}
        self.assertEqual(server.generate_summaries(resolved)["fail"], "N/A")
        self.assertIn("Technical Issues", server.generate_summaries(ended)["fail"])
        self.assertEqual(server.build_form_fill_payload(ended, {})["tech_issue_choice"], "Discord issues")

    def test_denied_headsets_are_excluded_from_approved_groups(self):
        rows = [
            {"Brand": "Allowed", "Model": "USB 1", "Status": "approved", "Note": ""},
            {"Brand": "Blocked", "Model": "USB 2", "Status": "denied", "Note": "No USB"},
        ]
        self.assertEqual(server._normalize_approved_headsets(rows), [{"brand": "Allowed", "models": ["USB 1"]}])
        self.assertEqual(server._normalize_denied_headsets(rows)[0]["model"], "USB 2")

    def test_other_headset_denial_requires_note_before_sheet_access(self):
        result = server._headset_review_action({
            "action": "deny",
            "brand": "Example",
            "model": "Model 1",
            "reason": "Other",
            "note": "",
        })
        self.assertFalse(result["ok"])
        self.assertIn("note is required", result["error"])

    def test_screenshot_defaults_include_release_candidate_assets(self):
        content = server._load_local_defaults_content()
        titles = {item.get("title") for item in content.get("discord_screenshots") or []}
        self.assertTrue({
            "Script Disposition", "Click Transfer", "Queue", "Transfer", "Station Settings", "Station Settings 2",
        }.issubset(titles))


if __name__ == "__main__":
    unittest.main()
