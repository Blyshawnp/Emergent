import asyncio
import csv
import json
import sys
import unittest
import xml.etree.ElementTree as ET
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))

import server  # noqa: E402


class ReleaseCandidateWorkflowLogicTests(unittest.TestCase):
    def _run_fill_form_with_mocks(self, selenium_result, status_result=None, status_error=None):
        async_mock_settings = mock.AsyncMock(return_value={"form_url": "https://forms.office.com/r/test123"})
        async def fake_record(*_args, **_kwargs):
            if status_error:
                raise status_error
            return status_result or {"form_fill_status": "filled", "form_filled_at": "2026-07-13T10:00:00Z"}

        payload = {
            "coaching": "Coaching summary",
            "fail_reason": "N/A",
            "session": {"history_id": "hist-1", "candidate_name": "Taylor Example"},
        }
        with mock.patch.object(server.db.settings, "find_one", async_mock_settings), \
             mock.patch.object(server, "fill_cert_form", return_value=selenium_result), \
             mock.patch.object(server, "_record_form_fill_status", side_effect=fake_record):
            return asyncio.run(server.fill_form(payload, None))

    def test_form_fill_success_records_metadata_separately(self):
        response = self._run_fill_form_with_mocks({"ok": True, "message": "Filled"})

        self.assertTrue(response["ok"])
        self.assertTrue(response["automation_completed"])
        self.assertTrue(response["form_filled"])
        self.assertTrue(response["local_status_saved"])
        self.assertEqual(response["error_code"], "")

    def test_form_fill_success_with_metadata_failure_is_partial_success(self):
        response = self._run_fill_form_with_mocks(
            {"ok": True, "message": "Filled"},
            status_error=RuntimeError("sqlite status update failed"),
        )

        self.assertTrue(response["ok"])
        self.assertTrue(response["automation_completed"])
        self.assertTrue(response["form_filled"])
        self.assertFalse(response["local_status_saved"])
        self.assertEqual(response["error_code"], "metadata_status_save_failed")
        self.assertIn("Microsoft Form was filled", response["warning"])

    def test_form_fill_automation_failure_is_not_marked_filled(self):
        response = self._run_fill_form_with_mocks({"ok": False, "message": "Browser failed"})

        self.assertFalse(response["ok"])
        self.assertFalse(response["automation_completed"])
        self.assertFalse(response["form_filled"])
        self.assertTrue(response["local_status_saved"])
        self.assertEqual(response["error_code"], "form_automation_failed")

    def test_default_reschedule_admin_mention_is_configured(self):
        self.assertNotIn("newbieShiftRescheduleAdminMention", server.DEFAULT_SETTINGS)
        self.assertNotIn("newbieShiftRescheduleAdminMention", server.sanitize_settings({}))

    def test_trainer_help_response_excludes_admin_setup_document(self):
        with mock.patch.object(
            server,
            "_refresh_help_and_faq_markdown",
            return_value=("# Trainer Help", "# Trainer FAQ"),
        ):
            response = asyncio.run(server.get_help_content())

        self.assertEqual(response["help_markdown"], "# Trainer Help")
        self.assertEqual(response["faq_markdown"], "# Trainer FAQ")
        self.assertNotIn("admin_setup_markdown", response)

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
        self.assertEqual(server.build_clean_fail(session), "N/A")

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

    def test_supervisor_transfer_only_ncns_form_and_summary(self):
        session = {
            "candidate_name": "Taylor Example",
            "supervisor_only": True,
            "final_attempt": True,
            "auto_fail_reason": "NC/NS",
            "headset_brand": "Approved USB",
            "chrome_default": True,
            "current_session_tech_issue": False,
            "historical_tech_issue": "Discord issues",
            "tech_issue": "N/A",
            "call_1": {"result": "Pass"},
            "call_2": {"result": "Pass"},
        }
        summaries = server.generate_summaries(session)
        self.assertEqual(server.compute_final_status(session), "NC/NS")
        self.assertIn("Taylor Example was a No Call No Show for the supervisor transfer.", summaries["fail"])
        self.assertIn("This session was their final attempt.", summaries["fail"])
        payload = server.build_form_fill_payload(session, {}, summaries["coaching"], summaries["fail"])
        self.assertEqual(payload["skills"], ["Supervisor Transfer"])
        self.assertEqual(payload["mock_complete"], "Yes")
        self.assertEqual(payload["sup_complete"], "No")
        self.assertEqual(payload["all_complete"], "No")
        self.assertEqual(payload["auto_fail"], "NC/NS")
        self.assertEqual(payload["tech_issue_choice"], "N/A")

    def test_newbie_reschedule_candidate_exactly_24_hours_not_attempt(self):
        session = {
            "candidate_name": "Taylor Example",
            "newbie_shift_request_type": "reschedule",
            "newbie_shift_requested_by": "candidate",
            "newbie_shift_request_reason": "Scheduling conflict",
            "newbie_shift_within_24_hours": False,
            "newbie_shift_counts_as_attempt": False,
            "newbie_shift_data": {"newbie_date": "07/15/2026", "newbie_time": "10:00 AM", "newbie_tz": "EST (Eastern)"},
            "call_1": {"result": "Pass"},
            "call_2": {"result": "Pass"},
        }
        summaries = server.generate_summaries(session)
        self.assertEqual(server.compute_final_status(session), "Incomplete")
        self.assertIn("24 hours or more", summaries["coaching"])
        self.assertEqual(summaries["fail"], "N/A")
        payload = server.build_form_fill_payload(session, {}, summaries["coaching"], summaries["fail"])
        self.assertEqual(payload["auto_fail"], "N/A")
        self.assertEqual(payload["fail_reason"], "N/A")

    def test_newbie_reschedule_candidate_under_24_hours_counts_as_ncns(self):
        session = {
            "candidate_name": "Taylor Example",
            "newbie_shift_request_type": "reschedule",
            "newbie_shift_requested_by": "candidate",
            "newbie_shift_request_reason": "Internet outage",
            "newbie_shift_within_24_hours": True,
            "newbie_shift_counts_as_attempt": True,
            "newbie_shift_data": {"newbie_date": "07/15/2026", "newbie_time": "10:00 AM", "newbie_tz": "EST (Eastern)"},
            "call_1": {"result": "Pass"},
            "call_2": {"result": "Pass"},
        }
        summaries = server.generate_summaries(session)
        self.assertEqual(server.compute_final_status(session), "NC/NS")
        self.assertIn("less than 24 hours", summaries["coaching"])
        self.assertIn("will count as an attempt", summaries["fail"])
        payload = server.build_form_fill_payload(session, {}, summaries["coaching"], summaries["fail"])
        self.assertEqual(payload["skills"], ["Mock Calls", "Supervisor Transfer"])
        self.assertEqual(payload["mock_complete"], "Yes")
        self.assertEqual(payload["sup_complete"], "No")
        self.assertEqual(payload["all_complete"], "No")
        self.assertEqual(payload["auto_fail"], "NC/NS")

    def test_certification_support_email_used_in_final_attempt_reschedule_text(self):
        session = {
            "candidate_name": "Taylor Example",
            "newbie_shift_request_type": "reschedule",
            "newbie_shift_requested_by": "candidate",
            "newbie_shift_request_reason": "Scheduling conflict",
            "newbie_shift_within_24_hours": True,
            "newbie_shift_counts_as_attempt": True,
            "final_attempt": True,
            "newbie_shift_data": {"newbie_date": "07/15/2026", "newbie_time": "10:00 AM", "newbie_tz": "EST (Eastern)"},
            "call_1": {"result": "Pass"},
            "call_2": {"result": "Pass"},
        }

        summaries = server.generate_summaries(session)
        payload = server.build_form_fill_payload(session, {}, summaries["coaching"], summaries["fail"])
        legacy = "certification@" + "acddirect.com"

        self.assertEqual(server.CERTIFICATION_SUPPORT_EMAIL, "certification@acdsupport.com")
        self.assertIn("certification@acdsupport.com", summaries["coaching"])
        self.assertIn("certification@acdsupport.com", summaries["fail"])
        self.assertIn("certification@acdsupport.com", payload["fail_reason"])
        self.assertNotIn(legacy, summaries["coaching"])
        self.assertNotIn(legacy, summaries["fail"])
        self.assertNotIn(legacy, payload["fail_reason"])

    def test_legacy_certification_email_normalization_is_exact(self):
        legacy = "certification@" + "acddirect.com"
        unrelated = "support@acddirect.com"
        normalized = server._normalize_managed_content_certification_email({
            "message": f"Email {legacy}. Keep {unrelated}.",
            "rows": [{"message": f"{legacy} only"}],
        })

        self.assertIn("certification@acdsupport.com", normalized["message"])
        self.assertIn(unrelated, normalized["message"])
        self.assertIn("certification@acdsupport.com", normalized["rows"][0]["message"])
        self.assertNotIn(legacy, str(normalized))

    def test_obsolete_certification_email_absent_from_user_facing_defaults(self):
        legacy = "certification@" + "acddirect.com"
        repo_root = Path(__file__).resolve().parents[1]
        paths = [
            repo_root / "backend" / "content" / "app_content.json",
            repo_root / "backend" / "defaults",
            repo_root / "docs" / "admin-content-package",
            repo_root / "docs" / "default-content",
            repo_root / "frontend" / "src" / "pages",
            repo_root / "frontend" / "src" / "utils",
        ]
        offenders = []
        for path in paths:
            candidates = [path] if path.is_file() else [item for item in path.rglob("*") if item.is_file()]
            for candidate in candidates:
                if candidate.suffix.lower() not in {".csv", ".json", ".md", ".jsx", ".js"}:
                    continue
                if ".test." in candidate.name:
                    continue
                text = candidate.read_text(encoding="utf-8", errors="ignore")
                if legacy in text:
                    offenders.append(str(candidate.relative_to(repo_root)))

        self.assertEqual(offenders, [])

    def test_release_discord_templates_are_exact_and_synchronized(self):
        repo_root = Path(__file__).resolve().parents[1]
        expected = {
            "Sup Request Instructions": (
                "When you need to transfer, you will….\n\n"
                "1) Ask in chat first before transferring - include the station, caller's name, and issue ex.: "
                "WXYZ, sup request, member's name, and member issue\n\n"
                "2) Give the CCM time to check to see if a Supervisor is available\n\n"
                "We never put our caller on hold so try to minimize dead air.\n\n"
                "3) When the CCM says ok to transfer...\n\n"
                "— Let your caller know you are transferring"
            ),
            "Disposition": (
                "After you click blind transfer, you will need to disposition the call in the script and in Call Corp DTE.\n\n"
                "*Script*\n"
                "- Click the cancel button in the script (red phone) and disposition as **Test / Training**.\n\n"
                "Next, Please Disposition the call in Call Corp *DTE*.\n\n"
                "- You will choose the option from the list that best matches what happened on the call.\n"
                "- This call should be dispositioned as **Test Call**.\n"
                "- DTE will go back to “Ready Status” automatically in 30 seconds or when you click Complete Wrap-Up.\n\n"
                "Let me know when you have done, please."
            ),
            "Passed All": (
                "**:tada: Congratulations! Great job! You have successfully completed your test calls.**\n\n"
                "- Watch your inbox for your step 4 final instructions - your Welcome Team TLMS information.\n\n"
                "- Please log out of Call Corp and Simple Script with the Log Out links (never \"X\" out of these windows).\n\n"
                "- If you haven't already done so be sure to complete any additional courses assigned in your TLMS. "
                "You may email certification@acdsupport.com for any questions on courses.\n\n"
                "- If you're signed up on any additional mock or testing shifts, please take a moment to go to Current "
                "Schedule under My Schedule in Gateway and remove them.\n\n"
                "**Welcome to ACDD! Have a fabulous remainder of your day!**\n\n"
                "https://gyazo.com/54533787846921462083e8029c028304"
            ),
        }
        first_line = "We are now going to proceed with the instructions for the Supervisor transfer."

        app_content = json.loads((repo_root / "backend" / "content" / "app_content.json").read_text(encoding="utf-8"))
        app_rows = {row["title"]: row["message"] for row in app_content["discord_templates"]}

        def csv_rows(path):
            with path.open(encoding="utf-8-sig", newline="") as handle:
                return {row["Title"]: row["Message"] for row in csv.DictReader(handle)}

        csv_sources = [
            csv_rows(repo_root / "backend" / "defaults" / "discord-posts.csv"),
            csv_rows(repo_root / "docs" / "admin-content-package" / "csv-tabs" / "discord-posts.csv"),
        ]

        xml_root = ET.parse(repo_root / "docs" / "admin-content-package" / "mock-testing-suite-admin-content.xml").getroot()
        namespace = {"ss": "urn:schemas-microsoft-com:office:spreadsheet"}
        xml_rows = {}
        for row in xml_root.findall(".//ss:Worksheet[@ss:Name='Discord Posts']/ss:Table/ss:Row", namespace)[1:]:
            values = [str(data.text or "") for data in row.findall("ss:Cell/ss:Data", namespace)]
            if len(values) >= 2:
                xml_rows[values[0]] = values[1]

        for rows in [app_rows, *csv_sources, xml_rows]:
            self.assertEqual(rows["Sup Instructions #1"].splitlines()[0], first_line)
            for title, message in expected.items():
                self.assertEqual(rows[title].replace("\r\n", "\n"), message)

        canonical_rows = {
            title: server._normalize_discord_message(message)
            for title, message in csv_sources[0].items()
        }
        for rows in [app_rows, csv_sources[1], xml_rows]:
            normalized_rows = {
                title: server._normalize_discord_message(message)
                for title, message in rows.items()
            }
            self.assertEqual(set(normalized_rows), set(canonical_rows))
            self.assertEqual(normalized_rows, canonical_rows)

    def test_discord_whitespace_normalization_preserves_markdown_and_one_blank_line(self):
        rows = [{
            "Category": "Sup Transfer Process",
            "Title": "Whitespace Fixture",
            "Message": "Heading\r\n\r\n\r\n- **Bullet**\r\n\r\n\r\nhttps://example.test/path\r\n",
        }]

        normalized = server._normalize_discord_posts(rows)

        self.assertEqual(
            normalized[0]["message"],
            "Heading\n\n- **Bullet**\n\nhttps://example.test/path",
        )

    def test_pending_request_public_mapping_and_counts(self):
        newbie = server._public_newbie_request({
            "request_id": "req-1",
            "request_type": "reschedule",
            "request_status": "pending",
            "candidate_name": "Taylor Example",
            "tester_name": "Tester One",
            "requested_by": "candidate",
            "within_24_hours": "TRUE",
            "counts_as_attempt": "TRUE",
            "final_attempt": "FALSE",
        })
        deletion = server._public_deletion_request({
            "request_id": "del-1",
            "status": "pending",
            "candidate_name": "Taylor Example",
            "reason": "Duplicate candidate record",
            "audit_summary": "final_attempt=TRUE; form_fill_status=failed; internal_note=do-not-display",
        })
        counts = server._request_category_counts([newbie, deletion], headset_pending_count=2)
        self.assertEqual(newbie["category"], "newbie_reschedule")
        self.assertTrue(newbie["within_24_hours"])
        self.assertEqual(deletion["target_scope"], "single_session")
        self.assertEqual(deletion["categoryLabel"], "Candidate Deletion Request")
        self.assertEqual(deletion["reason"], "Duplicate candidate record")
        self.assertEqual(deletion["details"], "")
        self.assertTrue(deletion["final_attempt"])
        self.assertEqual(deletion["form_fill_status"], "failed")
        self.assertEqual(deletion["deletion_scope"], "Session History and Candidate Tracking")
        self.assertNotIn("internal_note", str(deletion))
        self.assertEqual(counts["reschedules"], 1)
        self.assertEqual(counts["candidateDeletions"], 1)
        self.assertEqual(counts["headsetReviews"], 2)
        self.assertEqual(counts["unresolved"], 4)

    def test_pending_request_denial_requires_reason_before_sheet_access(self):
        result = server._shared_pending_request_action({
            "request_id": "req-1",
            "category": "newbie_reschedule",
            "decision": "denied",
            "expected_status": "pending",
        })
        self.assertFalse(result["ok"])
        self.assertIn("denial reason", result["error"].lower())

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
        self.assertEqual(server.compute_final_status(ended), "Incomplete")
        self.assertEqual(server.generate_summaries(ended)["fail"], "N/A")
        self.assertEqual(server.build_form_fill_payload(ended, {})["tech_issue_choice"], "Discord issues")

    def test_resumed_supervisor_transfer_ignores_original_technical_issue_for_form(self):
        stale_original_issue = {
            "candidate_name": "Candidate",
            "supervisor_only": True,
            "resumed_sup_transfer_only": True,
            "resume_source_history_id": "history-123",
            "tech_issue": "Calls would not route - unresolved",
            "tech_issue_ended_session": True,
            "current_session_tech_issue": False,
            "tech_issues_log": [{"issue": "Calls would not route - unresolved", "resolved": False}],
            "historical_tech_issue": "Calls would not route - unresolved",
        }
        payload = server.build_form_fill_payload(stale_original_issue, {})
        self.assertEqual(payload["tech_issue_choice"], "N/A")

        current_issue = {
            **stale_original_issue,
            "tech_issue": "Discord issues - unresolved",
            "current_session_tech_issue": True,
            "tech_issues_log": [{"issue": "Discord issues - unresolved", "resolved": False}],
        }
        self.assertEqual(server.build_form_fill_payload(current_issue, {})["tech_issue_choice"], "Discord issues")

    def test_same_day_drop_uses_ncns_form_mapping_with_distinct_fail_summary(self):
        session = {
            "candidate_name": "Candidate",
            "auto_fail_reason": "Same Day Drop",
            "final_status": "Fail",
        }
        summaries = server.generate_summaries(session)
        payload = server.build_form_fill_payload(session, {})
        self.assertEqual(server.compute_final_status(session), "NC/NS")
        self.assertEqual(payload["auto_fail"], "NC/NS")
        self.assertIn("dropped the session within 24 hours", summaries["fail"])
        self.assertIn("dropped the session within 24 hours", payload["fail_reason"])

    def test_required_call_fail_and_dte_screenshot_defaults_are_present(self):
        content = server._load_local_defaults_content()
        self.assertIn("Did not search for member", content.get("call_fails") or [])
        screenshots = content.get("discord_screenshots") or []
        dte = {item.get("title"): item.get("image_url") for item in screenshots if item.get("category") == "DTE"}
        self.assertEqual(dte.get("DTE Taskbar"), "/DTE-Taskbar.png")
        self.assertEqual(dte.get("DTE Allow"), "/DTE-allow.png")
        self.assertEqual(dte.get("DTE Permission"), "/DTE-permission.png")
        self.assertEqual(dte.get("DTE Profile"), "/DTE-profile.png")
        self.assertEqual(dte.get("DTE Ready"), "/DTE-ready.png")
        posts = {item.get("title"): item for item in content.get("discord_templates") or []}
        self.assertEqual(posts.get("Sup-Launch DTE #1", {}).get("suggested_screenshots"), ["/DTE-Taskbar.png"])
        self.assertEqual(posts.get("Sup-Launch DTE #2", {}).get("suggested_screenshots"), ["/DTE-allow.png"])
        self.assertEqual(posts.get("Sup-Launch DTE #3", {}).get("suggested_screenshots"), ["/DTE-permission.png"])
        self.assertEqual(posts.get("Sup-Launch DTE #4", {}).get("suggested_screenshots"), ["/DTE-profile.png"])
        self.assertEqual(posts.get("Change DTE Status", {}).get("suggested_screenshots"), ["/DTE-ready.png"])

    def test_remote_fail_reasons_override_defaults_but_keep_required_items(self):
        rows = [{"FailReason": "Remote Custom Fail"}, {"FailReason": "Did not search for member"}]
        normalized = server._normalize_fail_reasons(rows, "call_fails", "unit remote")
        self.assertEqual(normalized, ["Remote Custom Fail", "Did not search for member"])

        missing_required = server._normalize_fail_reasons(
            [{"FailReason": "Remote Custom Fail"}],
            "call_fails",
            "unit remote",
        )
        self.assertEqual(missing_required, ["Remote Custom Fail", "Did not search for member"])

    def test_google_sheet_content_remote_rows_replace_local_defaults(self):
        local_content = {
            "call_fails": ["Local Fail", "Did not search for member"],
            "discord_templates": [{"category": "Local", "title": "Local Trigger", "message": "Local message"}],
        }

        def fake_fetch(_sheet_id, tab_name):
            if tab_name == "call-fail-reasons":
                return "FailReason\nRemote Custom Fail\n"
            if tab_name == "discord-posts":
                return "Category,Title,Message\nRemote,Remote Trigger,Remote message\n"
            raise RuntimeError("not available in unit test")

        with mock.patch.object(server, "_resolve_content_sheet_id", return_value="configured"), \
             mock.patch.object(server, "_fetch_google_sheet_tab_csv", side_effect=fake_fetch):
            loaded = server._load_google_sheet_content({}, local_content)

        self.assertEqual(loaded["call_fails"], ["Remote Custom Fail", "Did not search for member"])
        self.assertEqual(loaded["discord_templates"], [{
            "category": "Remote",
            "title": "Remote Trigger",
            "message": "Remote message",
        }])

    def test_google_sheet_content_failure_returns_no_remote_override(self):
        with mock.patch.object(server, "_resolve_content_sheet_id", return_value="configured"), \
             mock.patch.object(server, "_fetch_google_sheet_tab_csv", side_effect=RuntimeError("temporary outage")):
            loaded = server._load_google_sheet_content({}, {
                "call_fails": ["Local Fail", "Did not search for member"],
                "discord_templates": [{"category": "Local", "title": "Local Trigger", "message": "Local message"}],
            })
        self.assertEqual(loaded, {})

    def test_managed_content_read_keeps_direct_sheets_as_first_choice(self):
        with mock.patch.object(server, "_fetch_google_sheet_tab_csv_authenticated", return_value="Brand,Model,Status\nDirect,USB 1,approved\n"), \
             mock.patch("services.apps_script_api.create_apps_script_sheet_service") as create_service, \
             mock.patch.object(server, "urlopen") as public_fetch:
            result = server._fetch_google_sheet_tab_csv("sheet", "headsets")

        self.assertIn("Direct,USB 1", result)
        create_service.assert_not_called()
        public_fetch.assert_not_called()

    def test_packaged_managed_content_uses_named_apps_script_read(self):
        client = mock.Mock()
        client.get.return_value = {
            "rows": [{"Brand": "Poly", "Model": "Blackwire 5210", "Status": "approved"}],
        }
        with mock.patch.object(server, "_fetch_google_sheet_tab_csv_authenticated", return_value=""), \
             mock.patch("services.apps_script_api.create_apps_script_sheet_service", return_value={"ok": True, "client": client}), \
             mock.patch.object(server, "urlopen") as public_fetch:
            result = server._fetch_google_sheet_tab_csv("sheet", "headsets")

        client.get.assert_called_once_with("getHeadsets", {})
        public_fetch.assert_not_called()
        self.assertIn("Blackwire 5210", result)

    def test_legacy_saved_call_fail_list_without_override_marker_follows_defaults(self):
        original = list(server.DEFAULT_SETTINGS["call_fails"])
        try:
            server.DEFAULT_SETTINGS["call_fails"] = ["Remote Custom Fail", "Did not search for member"]
            settings = server.sanitize_settings({
                "call_fails": ["Legacy Local Fail"],
            })
        finally:
            server.DEFAULT_SETTINGS["call_fails"] = original

        self.assertEqual(settings["call_fails"], ["Remote Custom Fail", "Did not search for member"])
        self.assertFalse(settings["call_fails_customized"])

    def test_explicit_call_fail_override_wins_but_keeps_required_reason_once(self):
        original = list(server.DEFAULT_SETTINGS["call_fails"])
        try:
            server.DEFAULT_SETTINGS["call_fails"] = ["Remote Custom Fail", "Did not search for member"]
            settings = server.sanitize_settings({
                "call_fails": ["Local Custom Fail", "Did not search for member", "Did not search for member"],
                "call_fails_customized": True,
            })
        finally:
            server.DEFAULT_SETTINGS["call_fails"] = original

        self.assertEqual(settings["call_fails"], ["Local Custom Fail", "Did not search for member"])
        self.assertTrue(settings["call_fails_customized"])

    def test_merge_required_fail_reasons_ordering(self):
        # 1. Other is last when remote data already contains it
        items = ["Other", "Reason A", "Reason B"]
        result = server._merge_required_fail_reasons(items, "call_fails")
        self.assertEqual(result, ["Reason A", "Reason B", "Did not search for member", "Other"])

        # 2. Other is last when required reasons are merged
        items = ["Reason A", "Other"]
        result = server._merge_required_fail_reasons(items, "call_fails")
        self.assertEqual(result, ["Reason A", "Did not search for member", "Other"])

        # 3. Did not search for member appears before Other
        items = ["Reason A", "Other", "Reason B"]
        result = server._merge_required_fail_reasons(items, "call_fails")
        self.assertEqual(result, ["Reason A", "Reason B", "Did not search for member", "Other"])

        # 4. no duplicate Other (case-insensitive)
        items = ["other", "Reason A", "Other", "OTHER"]
        result = server._merge_required_fail_reasons(items, "call_fails")
        self.assertEqual(result, ["Reason A", "Did not search for member", "Other"])

        # 5. no duplicate Did not search for member
        items = ["Did not search for member", "Reason A", "Other"]
        result = server._merge_required_fail_reasons(items, "call_fails")
        self.assertEqual(result, ["Did not search for member", "Reason A", "Other"])

        # 6. remote order is preserved for all other reasons
        items = ["Reason B", "Reason A", "Reason C", "Other"]
        result = server._merge_required_fail_reasons(items, "call_fails")
        self.assertEqual(result, ["Reason B", "Reason A", "Reason C", "Did not search for member", "Other"])

        # 7. stale local override path still produces correct final ordering
        items = ["Legacy Local Fail", "Other", "Legacy Local Fail", "other"]
        result = server._merge_required_fail_reasons(items, "call_fails")
        self.assertEqual(result, ["Legacy Local Fail", "Did not search for member", "Other"])

    def test_candidate_tracking_quota_message_is_trainer_safe(self):
        message = server._candidate_tracking_temporary_unavailable_message()
        self.assertIn("Candidate Tracking is temporarily unavailable", message)
        self.assertIn("SAM will retry automatically", message)
        self.assertNotIn("RATE_LIMIT_EXCEEDED", message)
        self.assertNotIn("spreadsheet", message.lower())
        self.assertNotIn("service account", message.lower())
        self.assertTrue(server._google_sheet_quota_or_temporary_error(Exception("HTTP 429 RATE_LIMIT_EXCEEDED")))

    def test_incomplete_technical_issue_ignores_stale_fail_summary(self):
        session = {
            "candidate_name": "Candidate",
            "call_1": {"result": "Pass"},
            "call_2": {"result": "Pass"},
            "tech_issue": "Discord issues - unresolved",
            "tech_issue_ended_session": True,
            "newbie_shift_data": {"newbie_date": "2026-06-23", "newbie_time": "10:00 AM", "newbie_tz": "ET"},
        }
        payload = server.build_form_fill_payload(session, {}, fail_summary="Stale generated fail summary.")
        self.assertEqual(server.compute_final_status(session), "Incomplete")
        self.assertEqual(server.generate_summaries(session)["fail"], "N/A")
        self.assertEqual(payload["fail_reason"], "N/A")
        self.assertEqual(payload["mock_complete"], "Yes")
        self.assertEqual(payload["sup_complete"], "No")

    def test_not_enough_time_for_supervisor_transfer_is_incomplete_form_payload(self):
        session = {
            "candidate_name": "Candidate",
            "call_1": {"result": "Pass", "type": "New Donor - One Time"},
            "call_2": {"result": "Pass", "type": "Existing Member - One Time"},
            "time_for_sup": False,
            "newbie_shift_prompt": {"trigger": "not_enough_time_sup_transfer", "status": "dismissed"},
        }
        payload = server.build_form_fill_payload(session, {}, fail_summary="Stale fail text")
        self.assertEqual(server.compute_final_status(session), "Incomplete")
        self.assertEqual(server.generate_summaries(session)["fail"], "N/A")
        self.assertEqual(payload["fail_reason"], "N/A")
        self.assertEqual(payload["mock_complete"], "Yes")
        self.assertEqual(payload["sup_complete"], "No")
        self.assertEqual(payload["all_complete"], "No")

    def test_non_final_double_supervisor_transfer_failure_is_incomplete_form_payload(self):
        session = {
            "candidate_name": "Candidate",
            "call_1": {"result": "Pass"},
            "call_2": {"result": "Pass"},
            "sup_transfer_1": {"result": "Fail", "fails": {"Did not ask permission to transfer": True}},
            "sup_transfer_2": {"result": "Fail", "fails": {"Transferred to wrong queue": True}},
            "final_attempt": False,
        }
        payload = server.build_form_fill_payload(session, {})
        self.assertEqual(server.compute_final_status(session), "Incomplete")
        self.assertEqual(server.generate_summaries(session)["fail"], "N/A")
        self.assertIn("Sup Transfer 1", server.build_clean_coaching(session))
        self.assertIn("Sup Transfer 2", server.build_clean_coaching(session))
        self.assertEqual(payload["fail_reason"], "N/A")

    def test_failed_final_attempt_supervisor_transfer_populates_fail_summary(self):
        session = {
            "candidate_name": "Candidate",
            "call_1": {"result": "Pass"},
            "call_2": {"result": "Pass"},
            "sup_transfer_1": {"result": "Fail", "fails": {"Did not ask permission to transfer": True}},
            "sup_transfer_2": {"result": "Fail", "fails": {"Transferred to wrong queue": True}},
            "final_attempt": True,
        }
        payload = server.build_form_fill_payload(session, {})
        self.assertEqual(server.compute_final_status(session), "FAIL-Final Attempt")
        self.assertNotEqual(server.generate_summaries(session)["fail"], "N/A")
        self.assertIn("Sup Transfer", payload["fail_reason"])

    def test_denied_headsets_are_excluded_from_approved_groups(self):
        rows = [
            {"Brand": "Allowed", "Model": "USB 1", "Status": "approved", "Note": ""},
            {"Brand": "Blocked", "Model": "USB 2", "Status": "denied", "Note": "No USB"},
        ]
        self.assertEqual(server._normalize_approved_headsets(rows), [{"brand": "Allowed", "models": ["USB 1"]}])
        self.assertEqual(server._normalize_denied_headsets(rows)[0]["model"], "USB 2")

    def test_approved_headsets_are_case_deduped_and_naturally_sorted(self):
        rows = [
            {"Brand": " Poly ", "Model": " Blackwire   5210 ", "Status": "approved"},
            {"Brand": "poly", "Model": "blackwire 5210", "Status": "active"},
            {"Brand": "Poly", "Model": "Blackwire 3325", "Status": "approved"},
            {"Brand": "Poly", "Model": "Blackwire 3220", "Status": "approved"},
            {"Brand": "Test", "Model": "Test Headset", "Status": "denied"},
            {"Brand": "Test", "Model": "Test Hearing", "Status": "approved"},
        ]

        self.assertEqual(server._normalize_approved_headsets(rows), [
            {"brand": "Poly", "models": ["Blackwire 3220", "Blackwire 3325", "Blackwire 5210"]},
            {"brand": "Test", "models": ["Test Hearing"]},
        ])
        self.assertEqual(server._normalize_denied_headsets(rows)[0]["model"], "Test Headset")

    def test_forced_headset_refresh_preserves_last_success_on_failure(self):
        previous_cache = dict(server._headset_cache)
        server._headset_cache.update({
            "groups": [{"brand": "Plantronics", "models": ["Blackwire 5210"]}],
            "denied": [{"brand": "Test", "model": "Test Headset", "status": "denied", "note": ""}],
            "last_fetch": 1,
        })
        try:
            with mock.patch.object(server, "_refresh_managed_content_sections", return_value=False):
                groups, denied, error = asyncio.run(server._fetch_approved_headsets(force=True))
        finally:
            server._headset_cache.clear()
            server._headset_cache.update(previous_cache)

        self.assertEqual(groups[0]["models"], ["Blackwire 5210"])
        self.assertEqual(denied[0]["model"], "Test Headset")
        self.assertIn("last available list", error)

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

    def test_candidate_lookup_returns_latest_visible_session_per_candidate(self):
        import datetime
        now = datetime.datetime.now(datetime.timezone.utc)
        mock_candidates = [
            {
                "candidate_name": "Jordan Tester",
                "status": "FAIL",
                "completed_at": (now - datetime.timedelta(days=8)).isoformat(),
                "created_at": (now - datetime.timedelta(days=8)).isoformat(),
                "notes": "Older failure",
                "tester_name": "Tester A",
            },
            {
                "candidate_name": "Jordan Tester",
                "status": "PASS",
                "completed_at": (now - datetime.timedelta(days=1)).isoformat(),
                "created_at": (now - datetime.timedelta(days=1)).isoformat(),
                "notes": "Latest pass",
                "tester_name": "Tester B",
            },
            {
                "candidate_name": "Jordan Other",
                "status": "FAIL",
                "completed_at": (now - datetime.timedelta(days=2)).isoformat(),
                "created_at": (now - datetime.timedelta(days=2)).isoformat(),
                "notes": "Other candidate",
                "tester_name": "Tester C",
            },
        ]

        mock_client = mock.MagicMock()
        mock_client.get.return_value = {"rows": mock_candidates, "pendingRows": []}

        with mock.patch("server._shared_sheet_context") as mock_ctx:
            mock_ctx.return_value = {
                "ok": True,
                "appsScriptClient": mock_client,
                "sheet_id": "test-sheet",
            }

            result = server._lookup_shared_candidate_sessions("Jordan Tester")

        self.assertTrue(result["ok"])
        self.assertTrue(result["passedCertification"])
        self.assertEqual(len(result["matches"]), 1)
        self.assertEqual(result["matches"][0]["candidate_name"], "Jordan Tester")
        self.assertEqual(result["matches"][0]["status"], "PASS")

    def test_summary_labels_are_human_readable_and_override_note_dedupes(self):
        session = {
            "candidate_name": "Candidate",
            "call_1": {
                "result": "Fail",
                "fails": {
                    "Verification_Name": True,
                    "Paraphrased script": True,
                },
                "failReasonDetails": {
                    "Paraphrased script": "terms",
                },
            },
            "final_attempt": True,
            "finalReadinessJudgment": {
                "overrideApplied": True,
                "calculatedResult": "Pass",
                "overrideResult": "Fail",
                "primaryReason": "Evaluator Override Applied: Candidate did not meet certification standards.",
            },
        }

        summaries = server.generate_summaries(session)

        self.assertIn("Verify the candidate's name.", summaries["coaching"])
        self.assertIn("Verify the candidate's name", summaries["fail"])
        self.assertNotIn("Verification_Name", summaries["coaching"])
        self.assertNotIn("Verification_Name", summaries["fail"])
        self.assertIn("Paraphrased the terms section of the script.", summaries["fail"])
        self.assertEqual(summaries["fail"].count("Evaluator Override Applied"), 1)

    def test_professional_summary_labels_group_children_and_remove_internal_keys(self):
        session = {
            "candidate_name": "Candidate",
            "call_1": {
                "result": "Fail",
                "coaching": {
                    "Verification": True,
                    "Verification_Name": True,
                    "Verification_Address": True,
                    "Verification_Phone": True,
                    "Verification_Card/EFT": True,
                    "Show appreciation_After donation amount is given": True,
                    "Show appreciation_For Current/Existing Donors": True,
                    "Screenshots/Discord Chat": True,
                },
                "fails": {
                    "Paraphrased script": True,
                },
                "failReasonDetails": {
                    "Paraphrased script": "Monthly Sustaining Terms",
                },
            },
            "call_2": {
                "result": "Fail",
                "fails": {
                    "Script navigation issues": True,
                },
            },
            "final_attempt": True,
        }

        coaching = server.build_clean_coaching(session)
        fail = server.build_clean_fail(session)
        combined = f"{coaching}\n{fail}"

        self.assertNotIn("_", combined)
        self.assertNotIn("Verification_Name", combined)
        self.assertNotIn("Show appreciation_After donation amount is given", combined)
        self.assertIn("Verification:", coaching)
        self.assertEqual(coaching.count("Verification:"), 1)
        self.assertIn("Verify the candidate's name.", coaching)
        self.assertIn("Verify the candidate's address.", coaching)
        self.assertIn("Show appreciation after the donation amount is given.", coaching)
        self.assertIn("Show appreciation for current or existing donors.", coaching)
        self.assertIn("Coaching was provided using the standard screenshots and Discord chat.", coaching)
        self.assertIn("Paraphrased the Monthly Sustaining Terms section of the script.", fail)

    def test_pending_supervisor_transfers_exclude_terminal_latest_candidate_rows(self):
        pending_rows = [
            {
                "pending_id": "pending-old",
                "candidate_name": "Taylor Done",
                "status": "pending",
                "created_at": "2026-07-01T12:00:00+00:00",
            },
            {
                "pending_id": "pending-live",
                "candidate_name": "Jordan Pending",
                "status": "pending",
                "created_at": "2026-07-03T12:00:00+00:00",
            },
        ]
        candidate_rows = [
            {
                "candidate_name": "Taylor Done",
                "status": "INCOMPLETE",
                "needs_sup_transfer": "TRUE",
                "pending_sup_transfer_id": "pending-old",
                "completed_at": "2026-07-01T12:00:00+00:00",
            },
            {
                "candidate_name": "Taylor Done",
                "status": "RESUMED-PASS",
                "needs_sup_transfer": "FALSE",
                "pending_sup_transfer_id": "",
                "completed_at": "2026-07-04T12:00:00+00:00",
            },
            {
                "candidate_name": "Jordan Pending",
                "status": "INCOMPLETE",
                "needs_sup_transfer": "TRUE",
                "pending_sup_transfer_id": "pending-live",
                "completed_at": "2026-07-03T12:00:00+00:00",
            },
        ]

        filtered = server._filter_current_pending_sup_transfers(pending_rows, candidate_rows)

        self.assertEqual([row["candidate_name"] for row in filtered], ["Jordan Pending"])

    @mock.patch("server.logger")
    def test_screenshot_merge_logic(self, mock_logger):
        def merge_screenshots(sheet_content, local_content):
            live_screenshots_ok = False
            if sheet_content.get("discord_screenshots"):
                live_screenshots_ok = True

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

    @mock.patch("server._shared_sheet_context")
    def test_apps_script_decide_pending_request_contract(self, mock_sheet_context):
        mock_client = mock.MagicMock()
        mock_sheet_context.return_value = {
            "ok": True,
            "appsScriptClient": mock_client,
            "sheet_id": "test-sheet-id"
        }

        # 1. Test approve command is sent as 'approve' and stored status 'approved' is normalized correctly
        mock_client.post.return_value = {
            "ok": True,
            "request_id": "req-123",
            "request_type": "initial_newbie_shift",
            "status": "approved",
            "decision": "approve",
        }

        response = server._shared_pending_request_action({
            "request_id": "req-123",
            "category": "newbie_initial",
            "decision": "approved",
            "expected_status": "pending",
            "actor": "AdminTester",
        })

        mock_client.post.assert_called_with("decidePendingRequest", {
            "request_id": "req-123",
            "request_type": "initial_newbie_shift",
            "decision": "approve",
            "expected_status": "pending",
            "decision_by": "AdminTester",
            "denial_reason": "",
        })
        self.assertTrue(response["ok"])
        self.assertEqual(response["decision"], "approve")
        self.assertEqual(response["status"], "approved")

        # 2. Test deny command is sent as 'deny' and stored status 'denied' is normalized correctly with denial reason
        mock_client.reset_mock()
        mock_client.post.return_value = {
            "ok": True,
            "request_id": "req-456",
            "request_type": "newbie_shift_reschedule",
            "status": "denied",
            "decision": "deny",
            "denial_reason": "No capacity",
        }

        response = server._shared_pending_request_action({
            "request_id": "req-456",
            "category": "newbie_reschedule",
            "decision": "deny",
            "expected_status": "pending",
            "actor": "AdminTester",
            "denial_reason": "No capacity",
        })

        mock_client.post.assert_called_with("decidePendingRequest", {
            "request_id": "req-456",
            "request_type": "newbie_shift_reschedule",
            "decision": "deny",
            "expected_status": "pending",
            "decision_by": "AdminTester",
            "denial_reason": "No capacity",
        })
        self.assertTrue(response["ok"])
        self.assertEqual(response["decision"], "deny")
        self.assertEqual(response["status"], "denied")
        self.assertEqual(response["denial_reason"], "No capacity")

        # 3. Test already-resolved conflict remaining an error (AppsScriptApiError)
        from services.apps_script_api import AppsScriptApiError
        mock_client.reset_mock()
        mock_client.post.side_effect = AppsScriptApiError("Apps Script API rejected the request: Pending request status has changed.")

        response = server._shared_pending_request_action({
            "request_id": "req-123",
            "category": "newbie_initial",
            "decision": "approve",
            "expected_status": "pending",
        })
        self.assertFalse(response["ok"])
        self.assertEqual(response["error"], "Request has already been resolved.")

    @mock.patch("server._shared_read_rows")
    @mock.patch("server._shared_sheet_context")
    def test_direct_sheets_fallback_unchanged(self, mock_sheet_context, mock_read_rows):
        mock_sheet_context.return_value = {
            "ok": True,
            "service": mock.MagicMock(),
            "sheet_id": "test-sheet-id"
        }
        mock_read_rows.return_value = [
            {"request_id": "req-sheet", "request_status": "pending", "session_id": "session-1", "_row_number": 2}
        ]

        with mock.patch("server._shared_update_existing_row") as mock_update, \
             mock.patch("server._update_candidate_request_fields") as mock_fields_update:
            response = server._shared_pending_request_action({
                "request_id": "req-sheet",
                "category": "newbie_initial",
                "decision": "approve",
                "expected_status": "pending",
                "actor": "AdminTester",
            })
            self.assertTrue(response["ok"])
            self.assertEqual(response["status"], "approved")
            mock_update.assert_called_once()
            mock_fields_update.assert_called_once()

    @mock.patch("server._shared_read_rows")
    @mock.patch("server._shared_sheet_context")
    def test_direct_sheets_candidate_deletion_approval_is_non_destructive(self, mock_sheet_context, mock_read_rows):
        mock_sheet_context.return_value = {
            "ok": True,
            "service": mock.MagicMock(),
            "sheet_id": "test-sheet-id",
        }
        mock_read_rows.return_value = [
            {
                "request_id": "delete-request",
                "status": "pending",
                "session_id": "session-1",
                "candidate_name": "Test Candidate",
                "_row_number": 2,
            }
        ]

        with mock.patch("server._shared_update_existing_row") as mock_update, \
             mock.patch("server._shared_admin_candidate_action") as mock_candidate_action:
            response = server._shared_pending_request_action({
                "request_id": "delete-request",
                "category": "candidate_deletion",
                "decision": "approve",
                "expected_status": "pending",
                "actor": "AdminTester",
            })

        self.assertTrue(response["ok"])
        self.assertEqual(response["status"], "approved")
        self.assertTrue(response["deletion_action_required"])
        mock_update.assert_called_once()
        mock_candidate_action.assert_not_called()


if __name__ == "__main__":
    unittest.main()
