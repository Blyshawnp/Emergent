import sys
import unittest
from pathlib import Path
from unittest import mock

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

    def test_legacy_headset_review_rows_keep_submission_metadata(self):
        row = server._normalize_headset_review_row({
            "headset_model": "Acme USB 100",
            "tester_name": "Tester One",
            "entered_at": "2026-06-23T12:00:00+00:00",
            "review_status": "pending",
            "notes": "Candidate entry",
            "_row_number": 2,
        }, "legacy")
        self.assertEqual(row["brand"], "Acme")
        self.assertEqual(row["model"], "USB 100")
        self.assertEqual(row["tester"], "Tester One")
        self.assertEqual(row["submitted_date"], "2026-06-23T12:00:00+00:00")

    def test_other_denied_headset_note_is_included_in_fail_summary(self):
        summaries = server._auto_fail_review_summaries({
            "candidate_name": "Candidate",
            "auto_fail_reason": "Wrong headset (Other: Ear cups are damaged)",
        })
        self.assertIn("Headset review note: Ear cups are damaged.", summaries["fail"])

    def test_denied_headset_form_reasons_map_to_supported_choices(self):
        self.assertEqual(
            server._map_auto_fail_for_form("Wrong headset (not USB)"),
            "Wrong headset (not USB)",
        )
        self.assertEqual(
            server._map_auto_fail_for_form("Wrong headset (not noise cancelling)"),
            "Wrong headset (not noise cancelling)",
        )

    def test_vpn_auto_fail_form_payload_maps_to_existing_vpn_choice(self):
        session = {
            "candidate_name": "Candidate",
            "tester_name": "Tester",
            "headset_brand": "Logitech H390",
            "auto_fail_reason": "Unable to turn off VPN",
            "final_status": "Fail",
            "candidate_ip_intelligence": {
                "verdict": "VPN / PROXY LIKELY",
                "testerDecision": {"decision": "auto_fail"},
            },
        }
        payload = server.build_form_fill_payload(session, {})
        summaries = server.generate_summaries(session)
        self.assertEqual(payload["auto_fail"], "Unable to turn off VPN")
        self.assertIn("VPN", payload["fail_reason"])
        self.assertIn("VPN", summaries["fail"])
        self.assertEqual(server._classify_auto_fail_reason(session["auto_fail_reason"]), "vpn")

    def test_gemini_prompt_source_logging_only_repeats_when_source_changes(self):
        server._last_logged_gemini_prompt_sources.clear()
        with mock.patch.object(server.logger, "info") as info:
            server._log_gemini_prompt_source("coaching", "local")
            server._log_gemini_prompt_source("coaching", "local")
            self.assertEqual(info.call_count, 1)
            server._log_gemini_prompt_source("coaching", "google_sheet_override")
            self.assertEqual(info.call_count, 2)

    def test_screenshot_defaults_include_release_candidate_assets(self):
        content = server._load_local_defaults_content()
        screenshots = content.get("discord_screenshots") or []
        titles = {item.get("title") for item in screenshots}
        self.assertTrue({
            "Script Disposition", "Click Transfer", "Queue", "Transfer", "Station Settings", "Station Settings 2",
        }.issubset(titles))
        headset_connections = {
            item.get("title"): item
            for item in screenshots
            if item.get("category") == "Headset Connections"
        }
        self.assertEqual(headset_connections.get("USB Connection", {}).get("image_url"), "/usb.png")
        self.assertEqual(headset_connections.get("3.5 mm connections", {}).get("image_url"), "/3.5mm.png")
        self.assertTrue((server.ROOT_DIR.parent / "frontend" / "public" / "usb.png").is_file())
        self.assertTrue((server.ROOT_DIR.parent / "frontend" / "public" / "3.5mm.png").is_file())

    def test_candidate_matching_and_visibility(self):
        import datetime
        mock_candidates = [
            {
                "candidate_name": "Lisa Rusie",
                "status": "PASS",
                "completed_at": (datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(days=2)).isoformat(),
                "created_at": (datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(days=2)).isoformat(),
                "notes": "Passed recently",
                "tester_name": "Tester A",
            },
            {
                "candidate_name": "Lisa Expired",
                "status": "PASS",
                "completed_at": (datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(days=12)).isoformat(),
                "created_at": (datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(days=12)).isoformat(),
                "notes": "Passed long ago",
                "tester_name": "Tester B",
            },
            {
                "candidate_name": "Lisa Failure",
                "status": "FAIL",
                "completed_at": (datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(days=15)).isoformat(),
                "created_at": (datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(days=15)).isoformat(),
                "notes": "Failed",
                "tester_name": "Tester C",
            },
        ]
        
        mock_client = mock.MagicMock()
        mock_client.get.return_value = {
            "rows": mock_candidates,
            "pendingRows": []
        }
        
        with mock.patch("server._shared_sheet_context") as mock_ctx:
            mock_ctx.return_value = {
                "ok": True,
                "appsScriptClient": mock_client,
                "sheet_id": "test-sheet",
            }
            
            result = server._lookup_shared_candidate_sessions("Lisa")
            self.assertTrue(result["ok"])
            names = [m["candidate_name"] for m in result["matches"]]
            self.assertIn("Lisa Rusie", names)
            self.assertIn("Lisa Failure", names)
            self.assertNotIn("Lisa Expired", names)
            self.assertFalse(result["finalAttempt"])
            self.assertFalse(result["finalAttemptUsed"])
            
            result_narrow = server._lookup_shared_candidate_sessions("Lisa R")
            names_narrow = [m["candidate_name"] for m in result_narrow["matches"]]
            self.assertIn("Lisa Rusie", names_narrow)
            self.assertNotIn("Lisa Failure", names_narrow)
            
            result_exact = server._lookup_shared_candidate_sessions("Lisa Rusie")
            self.assertEqual(len(result_exact["matches"]), 1)
            self.assertEqual(result_exact["matches"][0]["candidate_name"], "Lisa Rusie")
            self.assertEqual(result_exact["matches"][0]["matchConfidence"], 100)

    @mock.patch("server.logger")
    def test_screenshot_merge_logic(self, mock_logger):
        def merge_screenshots(sheet_content, local_content):
            live_screenshots_ok = False
            if sheet_content.get("discord_screenshots"):
                live_screenshots_ok = True

            if not live_screenshots_ok:
                if local_content.get("discord_screenshots"):
                    sheet_content["discord_screenshots"] = local_content.get("discord_screenshots")
            return sheet_content

        sheet = {"discord_screenshots": [{"title": "Live Screenshot", "image_url": "http://live"}]}
        local = {"discord_screenshots": [{"title": "Default Screenshot", "image_url": "http://default"}]}
        res = merge_screenshots(sheet.copy(), local)
        self.assertEqual(res["discord_screenshots"], [{"title": "Live Screenshot", "image_url": "http://live"}])

        sheet_empty = {"discord_screenshots": []}
        res_empty = merge_screenshots(sheet_empty.copy(), local)
        self.assertEqual(res_empty["discord_screenshots"], [{"title": "Default Screenshot", "image_url": "http://default"}])

        sheet_none = {"discord_screenshots": None}
        res_none = merge_screenshots(sheet_none.copy(), local)
        self.assertEqual(res_none["discord_screenshots"], [{"title": "Default Screenshot", "image_url": "http://default"}])


if __name__ == "__main__":
    unittest.main()
