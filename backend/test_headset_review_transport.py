import asyncio
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
import server


class _AppsScriptClient:
    def __init__(self, post_result=None, post_error=None):
        self.post_result = post_result or {}
        self.post_error = post_error
        self.posts = []

    def post(self, action, payload):
        self.posts.append((action, payload))
        if self.post_error:
            raise self.post_error
        return dict(self.post_result)

    def get(self, action, _params=None):
        if action == "getHeadsets":
            return {"rows": []}
        return {"rows": []}


class _ValuesApi:
    def __init__(self):
        self.appended = []

    def append(self, **kwargs):
        self.appended.append(kwargs)
        return self

    def execute(self):
        return {}


class _SheetsApi:
    def __init__(self):
        self.values_api = _ValuesApi()

    def values(self):
        return self.values_api


class _Service:
    def __init__(self, sheets_api):
        self.sheets_api = sheets_api

    def spreadsheets(self):
        return self.sheets_api


class HeadsetReviewTransportTests(unittest.TestCase):
    def setUp(self):
        self.original_approved = server.EXTERNAL_CONTENT.get("approved_headsets")
        self.original_denied = server.EXTERNAL_CONTENT.get("denied_headsets")
        server.EXTERNAL_CONTENT["approved_headsets"] = []
        server.EXTERNAL_CONTENT["denied_headsets"] = []
        self.payload = {
            "source_session_id": "session-1",
            "candidate_name": "Candidate Example",
            "tester_name": "Tester Example",
            "headset_model": "ExampleBrand Model 9000",
            "note": "Trainer confirmed the submitted model.",
        }

    def tearDown(self):
        server.EXTERNAL_CONTENT["approved_headsets"] = self.original_approved
        server.EXTERNAL_CONTENT["denied_headsets"] = self.original_denied

    def test_apps_script_creation_uses_stable_id_without_direct_service(self):
        client = _AppsScriptClient()
        with mock.patch.object(server, "_shared_sheet_context", return_value={"ok": True, "appsScriptClient": client}):
            first = server._append_headset_review_log(self.payload)
            second = server._append_headset_review_log(self.payload)

        self.assertTrue(first["ok"])
        self.assertEqual(first["review_id"], second["review_id"])
        self.assertEqual(client.posts[0][0], "submitHeadsetReview")
        self.assertEqual(client.posts[0][1]["source_session_id"], "session-1")
        self.assertEqual(client.posts[0][1]["candidate_name"], "Candidate Example")
        self.assertEqual(client.posts[0][1]["tester_name"], "Tester Example")

    def test_direct_sheets_creation_writes_v2_payload_once(self):
        sheets_api = _SheetsApi()
        context = {
            "ok": True,
            "service": _Service(sheets_api),
            "sheet_id": "masked-in-test",
            "setupStatus": {"statuses": [{"tab": server.HEADSET_REVIEW_LOG_TAB, "schema": "review"}]},
        }
        with mock.patch.object(server, "_shared_sheet_context", return_value=context), \
                mock.patch.object(server, "_shared_read_rows", return_value=[]):
            result = server._append_headset_review_log(self.payload)

        self.assertTrue(result["ok"])
        self.assertEqual(len(sheets_api.values_api.appended), 1)
        values = sheets_api.values_api.appended[0]["body"]["values"][0]
        public = dict(zip(server.HEADSET_REVIEW_LOG_HEADERS, values))
        self.assertEqual(public["review_id"], result["review_id"])
        self.assertEqual(public["source_session_id"], "session-1")
        self.assertEqual(public["Status"], "pending")
        self.assertEqual(public["Brand"], "ExampleBrand")
        self.assertEqual(public["Model"], "Model 9000")

    def test_approved_headset_and_invalid_request_do_not_create_rows(self):
        server.EXTERNAL_CONTENT["approved_headsets"] = [{"brand": "ExampleBrand", "models": ["Model 9000"]}]
        approved = server._append_headset_review_log(self.payload)
        invalid = server._append_headset_review_log({"headset_model": "Unknown Model"})
        self.assertEqual(approved["reason"], "approved_headset")
        self.assertFalse(invalid["ok"])
        self.assertEqual(invalid["error"], "Headset review request data is incomplete.")

    def test_transport_failure_is_sanitized(self):
        client = _AppsScriptClient(post_error=RuntimeError("raw transport payload that must stay private"))
        with mock.patch.object(server, "_shared_sheet_context", return_value={"ok": True, "appsScriptClient": client}):
            result = server._append_headset_review_log(self.payload)
        self.assertFalse(result["ok"])
        self.assertEqual(result["error"], "Headset review request could not be submitted.")
        self.assertNotIn("raw transport", result["error"])

    def test_session_start_persists_locally_and_schedules_remote_headset_sync(self):
        background_tasks = mock.Mock()
        payload = {**self.payload, "headset_review_requested": True}
        with mock.patch.object(server.db.sessions, "replace_one", new=mock.AsyncMock()) as replace_one, \
                mock.patch.object(server.db.sessions, "update_one", new=mock.AsyncMock()) as update_one, \
                mock.patch.object(server, "_append_headset_review_log") as remote_append:
            result = asyncio.run(server.start_session(payload, None, background_tasks))

        self.assertTrue(result["ok"])
        self.assertEqual(result["session"]["headset_review_sync_status"], "pending")
        replace_one.assert_awaited_once()
        update_one.assert_awaited_once()
        background_tasks.add_task.assert_called_once()
        self.assertIs(background_tasks.add_task.call_args.args[0], server._sync_started_session_headset_review)
        remote_append.assert_not_called()

    def test_apps_script_decision_targets_stable_review_id(self):
        client = _AppsScriptClient({"updated": True})
        payload = {
            "action": "approve",
            "review_id": "review-1",
            "brand": "ExampleBrand",
            "model": "Model 9000",
            "actor": "SAM Admin",
        }
        with mock.patch.object(server, "_shared_sheet_context", return_value={"ok": True, "appsScriptClient": client}):
            result = server._headset_review_action(payload)
        self.assertTrue(result["ok"])
        self.assertEqual(client.posts[0][0], "approveHeadset")
        self.assertEqual(client.posts[0][1]["review_id"], "review-1")
        self.assertEqual(client.posts[0][1]["actor"], "SAM Admin")

    def test_direct_sheets_decision_updates_matching_review_id_and_headset_list(self):
        sheets_api = _SheetsApi()
        context = {
            "ok": True,
            "service": _Service(sheets_api),
            "sheet_id": "masked-in-test",
            "setupStatus": {"statuses": [{"tab": server.HEADSET_REVIEW_LOG_TAB, "schema": "review"}]},
        }
        review_row = dict(zip(server.HEADSET_REVIEW_LOG_HEADERS, [
            "review-1", "session-1", "Candidate Example", "Tester Example",
            "ExampleBrand", "Model 9000", "pending", "Trainer note",
            "2026-07-15T12:00:00+00:00", "2026-07-15T12:00:00+00:00", "", "", "",
        ]))
        review_row["_row_number"] = 2

        with mock.patch.object(server, "_shared_sheet_context", return_value=context), \
                mock.patch.object(server, "_shared_read_rows", return_value=[review_row]), \
                mock.patch.object(server, "_read_headsets_rows", return_value=[]), \
                mock.patch.object(server, "_shared_update_existing_row") as update_row, \
                mock.patch.object(server, "_sync_headset_content_cache"):
            result = server._headset_review_action({
                "action": "deny",
                "review_id": "review-1",
                "brand": "ExampleBrand",
                "model": "Model 9000",
                "reason": "Headset does not connect via USB",
                "actor": "SAM Admin",
            })

        self.assertTrue(result["ok"])
        self.assertEqual(result["status"], "denied")
        update_row.assert_called_once()
        update_args = update_row.call_args.args
        self.assertEqual(update_args[2], server.HEADSET_REVIEW_LOG_TAB)
        self.assertEqual(update_args[4], 2)
        updated_review = dict(zip(server.HEADSET_REVIEW_LOG_HEADERS, update_args[5]))
        self.assertEqual(updated_review["review_id"], "review-1")
        self.assertEqual(updated_review["Status"], "denied")
        self.assertEqual(updated_review["decision_by"], "SAM Admin")
        self.assertEqual(sheets_api.values_api.appended[0]["body"]["values"][0], [
            "ExampleBrand", "Model 9000", "denied", "Headset does not connect via USB",
        ])


if __name__ == "__main__":
    unittest.main()
