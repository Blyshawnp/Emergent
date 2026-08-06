import csv
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
BACKEND_DIR = ROOT / "backend"
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from server import _normalize_callers  # noqa: E402


def test_fallback_callers_match_expected_category_counts():
    callers_path = ROOT / "backend" / "defaults" / "callers.csv"
    with callers_path.open(newline="", encoding="utf-8") as handle:
        rows = list(csv.DictReader(handle))

    grouped = _normalize_callers(rows)

    assert sum(len(value) for value in grouped.values()) == 22
    assert len(grouped["donors_new"]) == 10
    assert len(grouped["donors_existing"]) == 10
    assert len(grouped["donors_increase"]) == 2

    for row in rows:
        for field in ("Category", "First", "Last", "Address", "City", "State", "Zip", "Phone", "Email"):
            assert row[field].strip(), f"{field} missing for {row}"

    assert grouped["donors_new"][0] == [
        "Sam",
        "Smith",
        "400 N Broad St",
        "Philadelphia",
        "PA",
        "19130",
        "215-515-1212",
        "ssmith@test.com",
        "",
    ]
    assert grouped["donors_existing"][0][0:2] == ["Ron", "Jones"]
    assert grouped["donors_increase"][0][0:2] == ["Alison", "DeRudder"]
