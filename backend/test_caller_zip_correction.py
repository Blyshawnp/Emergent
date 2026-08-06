import ast
import csv
import hashlib
import json
import sys
import unittest
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parent
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from data_providers.factory import configured_provider_mode
from tools.caller_zip_correction import (
    NEW_ZIP,
    OLD_ZIP,
    SETTING_KEY,
    CallerZipCorrectionError,
    apply_correction_overlay,
    build_correction_setting,
    plan_current_shadow_corrections,
)


ROOT = Path(__file__).resolve().parents[1]
TARGET_NAMES = ("Sam Smith", "Susan Miller-Smith")


def _csv_rows(relative_path):
    with (ROOT / relative_path).open(newline="", encoding="utf-8-sig") as handle:
        return list(csv.DictReader(handle))


def _name(row):
    return f"{row.get('First', '').strip()} {row.get('Last', '').strip()}".strip()


def _other_rows_hash(rows):
    other = [row for row in rows if _name(row) not in TARGET_NAMES]
    payload = json.dumps(other, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(payload.encode()).hexdigest()


def _target_non_zip_hash(row):
    payload = json.dumps(
        {key: value for key, value in row.items() if key != "Zip"},
        sort_keys=True,
        separators=(",", ":"),
    )
    return hashlib.sha256(payload.encode()).hexdigest()[:12]


def _synthetic_row(name, zip_code=OLD_ZIP, suffix="1", batch="batch-current"):
    first, last = name.split(" ", 1)
    return {
        "id": f"row-{suffix}",
        "import_batch_id": batch,
        "source_tab": "callers",
        "source_row_number": int(suffix) + 1,
        "source_row_key": f"source-{suffix}",
        "raw_row": {
            "Category": "New",
            "First": first,
            "Last": last,
            "Address": f"Synthetic address {suffix}",
            "City": "Synthetic city",
            "State": "PA",
            "Zip": zip_code,
            "Phone": f"synthetic-phone-{suffix}",
            "Email": f"synthetic-{suffix}@example.invalid",
        },
    }


class CallerZipRepositoryTests(unittest.TestCase):
    def test_active_fallback_and_admin_defaults_use_corrected_zip(self):
        fallback = _csv_rows("backend/defaults/callers.csv")
        admin_default = _csv_rows("docs/admin-content-package/csv-tabs/callers-new.csv")
        for rows in (fallback, admin_default):
            matches = {name: [row for row in rows if _name(row) == name] for name in TARGET_NAMES}
            self.assertEqual({name: len(items) for name, items in matches.items()}, {name: 1 for name in TARGET_NAMES})
            self.assertTrue(all(items[0]["Zip"] == NEW_ZIP for items in matches.values()))
            self.assertTrue(all(items[0]["Zip"] != OLD_ZIP for items in matches.values()))

    def test_unrelated_default_callers_remain_byte_for_byte_equivalent(self):
        self.assertEqual(
            _other_rows_hash(_csv_rows("backend/defaults/callers.csv")),
            "2aec5d7cd394a50e557399cc015a25f3e22a68a26303bf40052c887dc7b9c1da",
        )
        self.assertEqual(
            _other_rows_hash(_csv_rows("docs/admin-content-package/csv-tabs/callers-new.csv")),
            "7842b5a7ecff65bb60d95aff07371d065e9f817f0cdd45a4bdf75949057f7d73",
        )

    def test_target_identity_and_non_zip_fields_are_unchanged(self):
        expected = {
            "backend/defaults/callers.csv": {
                "Sam Smith": "0740bba760e3",
                "Susan Miller-Smith": "32af95fcd1da",
            },
            "docs/admin-content-package/csv-tabs/callers-new.csv": {
                "Sam Smith": "bad89779470d",
                "Susan Miller-Smith": "af2a875f33de",
            },
        }
        for path, expected_hashes in expected.items():
            rows = _csv_rows(path)
            actual = {
                _name(row): _target_non_zip_hash(row)
                for row in rows
                if _name(row) in TARGET_NAMES
            }
            self.assertEqual(actual, expected_hashes)

    def test_builtin_fallback_sam_record_uses_corrected_zip(self):
        module = ast.parse((ROOT / "backend/server.py").read_text(encoding="utf-8"))
        assignment = next(
            node for node in module.body
            if isinstance(node, ast.Assign)
            and any(isinstance(target, ast.Name) and target.id == "NEW_DONORS" for target in node.targets)
        )
        records = ast.literal_eval(assignment.value)
        match = [row for row in records if row[0] == "Sam" and row[1] == "Smith"]
        self.assertEqual(len(match), 1)
        self.assertEqual(match[0][5], NEW_ZIP)

    def test_sheets_remains_the_default_provider(self):
        self.assertEqual(configured_provider_mode({}), "sheets")


class CallerZipShadowCorrectionTests(unittest.TestCase):
    def setUp(self):
        self.rows = [
            _synthetic_row("Sam Smith", suffix="1"),
            _synthetic_row("Susan Miller-Smith", suffix="2"),
            _synthetic_row("Unrelated Caller", zip_code="99999", suffix="3"),
        ]

    def test_plan_targets_only_two_exact_stable_identities(self):
        plan = plan_current_shadow_corrections(self.rows)
        self.assertEqual([item["staging_row_id"] for item in plan], ["row-1", "row-2"])
        self.assertEqual([item["caller_name"] for item in plan], list(TARGET_NAMES))
        self.assertTrue(all(item["zip"] == NEW_ZIP for item in plan))
        setting = build_correction_setting(plan)
        self.assertEqual(SETTING_KEY, "caller_roster_zip_corrections_v1")
        self.assertFalse(setting["provider_cutover"])

    def test_zero_match_fails_closed(self):
        with self.assertRaises(CallerZipCorrectionError):
            plan_current_shadow_corrections(self.rows[1:])

    def test_multiple_match_fails_closed(self):
        with self.assertRaises(CallerZipCorrectionError):
            plan_current_shadow_corrections([*self.rows, dict(self.rows[0], id="duplicate")])

    def test_already_corrected_is_idempotent(self):
        rows = [
            _synthetic_row("Sam Smith", zip_code=NEW_ZIP, suffix="1"),
            _synthetic_row("Susan Miller-Smith", zip_code=NEW_ZIP, suffix="2"),
        ]
        plan = plan_current_shadow_corrections(rows)
        self.assertTrue(all(item["status"] == "already_corrected" for item in plan))
        setting = build_correction_setting(plan)
        first = apply_correction_overlay(rows[0], setting)
        second = apply_correction_overlay(first, setting)
        self.assertEqual(first, second)

    def test_overlay_preserves_historical_row_and_all_non_zip_fields(self):
        original = json.loads(json.dumps(self.rows[0]))
        setting = build_correction_setting(plan_current_shadow_corrections(self.rows))
        corrected = apply_correction_overlay(self.rows[0], setting)
        self.assertEqual(self.rows[0], original)
        self.assertEqual(corrected["raw_row"]["Zip"], NEW_ZIP)
        self.assertEqual(
            {key: value for key, value in corrected["raw_row"].items() if key != "Zip"},
            {key: value for key, value in original["raw_row"].items() if key != "Zip"},
        )

    def test_overlay_leaves_unrelated_record_unchanged(self):
        setting = build_correction_setting(plan_current_shadow_corrections(self.rows))
        self.assertEqual(apply_correction_overlay(self.rows[2], setting), self.rows[2])

    def test_overlay_rejects_identity_drift(self):
        setting = build_correction_setting(plan_current_shadow_corrections(self.rows))
        drifted = {**self.rows[0], "source_row_key": "different-source"}
        with self.assertRaises(CallerZipCorrectionError):
            apply_correction_overlay(drifted, setting)

    def test_different_batches_fail_closed(self):
        rows = [self.rows[0], {**self.rows[1], "import_batch_id": "other-batch"}]
        with self.assertRaises(CallerZipCorrectionError):
            plan_current_shadow_corrections(rows)


if __name__ == "__main__":
    unittest.main()
