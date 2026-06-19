import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import server  # noqa: E402


def passing_session():
    return {
        "candidate_name": "Taylor Example",
        "tester_name": "Tester One",
        "headset_usb": True,
        "noise_cancel": True,
        "vpn_on": False,
        "chrome_default": True,
        "extensions_disabled": True,
        "popups_allowed": True,
        "call_1": {"result": "Pass"},
        "call_2": {"result": "Pass"},
        "sup_transfer_1": {"result": "Pass"},
    }


class FinalReadinessRulesTests(unittest.TestCase):
    def test_no_override_does_not_add_readiness_context(self):
        session = passing_session()
        session["finalReadinessJudgment"] = {
            "calculatedResult": "Pass",
            "overrideApplied": False,
        }

        self.assertEqual(server._readiness_context_text(session), "")
        self.assertEqual(server._append_readiness_override_note("Base summary", session), "Base summary")

    def test_pass_to_fail_override_updates_fail_summary_and_form_flags(self):
        session = passing_session()
        session["finalReadinessJudgment"] = {
            "calculatedResult": "Pass",
            "overrideApplied": True,
            "overrideResult": "Fail",
            "primaryReason": "Accuracy/detail concerns",
            "explanation": "Repeated detail issues.",
        }

        self.assertEqual(server.compute_final_status(session), "Fail")
        fail = server.build_clean_fail(session)
        self.assertIn("Evaluator Override Applied", fail)
        self.assertIn("Accuracy/detail concerns", fail)
        self.assertIn("Repeated detail issues.", fail)
        self.assertEqual(server._completion_flags_for_form(session)["mock_complete"], "No")
        self.assertEqual(server._completion_flags_for_form(session)["sup_complete"], "No")

    def test_pass_to_needs_retest_override_maps_incomplete(self):
        session = passing_session()
        session["finalReadinessJudgment"] = {
            "calculatedResult": "Pass",
            "overrideApplied": True,
            "overrideResult": server.FINAL_READINESS_NEEDS_RETEST,
            "primaryReason": "Needed excessive prompting",
            "explanation": "Needs additional coaching before retest.",
        }

        self.assertEqual(server.compute_final_status(session), server.FINAL_READINESS_NEEDS_RETEST)
        flags = server._completion_flags_for_form(session)
        self.assertEqual(flags["mock_complete"], "No")
        self.assertEqual(flags["sup_complete"], "No")

    def test_fail_to_pass_override_is_ignored(self):
        session = passing_session()
        session["call_1"] = {"result": "Fail"}
        session["call_2"] = {"result": "Fail"}
        session["sup_transfer_1"] = {}
        session["finalReadinessJudgment"] = {
            "calculatedResult": "Fail",
            "overrideApplied": True,
            "overrideResult": "Pass",
            "primaryReason": "Other",
            "explanation": "Invalid pass override.",
        }

        self.assertFalse(server._readiness_override_applied(session))
        self.assertEqual(server.compute_final_status(session), "Fail")
        self.assertEqual(server._readiness_context_text(session), "")


if __name__ == "__main__":
    unittest.main()
