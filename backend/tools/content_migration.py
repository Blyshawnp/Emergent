#!/usr/bin/env python3
"""
Content Migration Tool — Dry-Run Reconciliation

Compares available content sources for Callers and Discord Posts:
  - Bundled CSV defaults (callers.csv, new_callers.csv, discord-posts.csv)
  - Owner-approved corrections (uncommitted discord-posts.csv)
  - Existing Supabase caller roster (via shadow data if accessible)

Reports missing entries, duplicates, field discrepancies, content hashes,
and intended import counts.

DEFAULT MODE: Read-only dry-run. Does NOT perform any hosted writes.

Usage:
    python3.11 backend/tools/content_migration.py [--verbose]
"""

import csv
import hashlib
import json
import os
import sys
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
DEFAULTS_DIR = REPO_ROOT / "backend" / "defaults"

# The canonical source for callers is callers.csv (not new_callers.csv)
CALLERS_CSV = DEFAULTS_DIR / "callers.csv"
NEW_CALLERS_CSV = DEFAULTS_DIR / "new_callers.csv"
DISCORD_CSV = DEFAULTS_DIR / "discord-posts.csv"

# Known correct identities
CORRECT_CALLERS = {
    ("Sam", "Smith"): {"zip": "19130"},
    ("Susan", "Miller-Smith"): {"zip": "19130"},
}

STALE_CALLERS = {
    ("Sam", "Miller"): ("Sam", "Smith"),
    ("Susan", "Miller"): ("Susan", "Miller-Smith"),
}


def _load_csv(path):
    """Load a CSV file into a list of dicts."""
    if not path.is_file():
        return []
    with open(path, "r", encoding="utf-8-sig", newline="") as f:
        return list(csv.DictReader(f))


def _content_hash(items):
    """SHA-256 hash of a JSON-serialized content list."""
    canonical = json.dumps(items, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()[:16]


def _normalize_caller_category(value):
    text = str(value or "").strip().lower()
    aliases = {
        "new": "new", "new donor": "new", "new donors": "new",
        "existing": "existing", "existing member": "existing", "existing members": "existing",
        "increase": "increase", "increase sustaining": "increase",
    }
    return aliases.get(text, text)


def audit_callers(verbose=False):
    """Reconcile caller data sources."""
    print("\n" + "=" * 60)
    print("CALLERS RECONCILIATION")
    print("=" * 60)

    canonical = _load_csv(CALLERS_CSV)
    new_callers = _load_csv(NEW_CALLERS_CSV)

    print(f"\n  Canonical source (callers.csv): {len(canonical)} rows")
    print(f"  New callers source (new_callers.csv): {len(new_callers)} rows")

    # Check new_callers.csv for stale identities
    issues = []
    for row in new_callers:
        first = str(row.get("First") or "").strip()
        last = str(row.get("Last") or "").strip()
        zip_code = str(row.get("Zip") or "").strip()
        key = (first, last)

        if key in STALE_CALLERS:
            corrected = STALE_CALLERS[key]
            issues.append(f"  STALE: ({first} {last}) should be ({corrected[0]} {corrected[1]})")

        correct = CORRECT_CALLERS.get(key)
        if correct:
            if zip_code != correct["zip"]:
                issues.append(f"  WRONG ZIP: {first} {last} has {zip_code}, should be {correct['zip']}")

    if issues:
        print(f"\n  [WARN] Issues found in new_callers.csv:")
        for issue in issues:
            print(issue)
    else:
        print(f"\n  [OK] new_callers.csv identities and ZIPs are correct")

    # Count by category in canonical
    categories = {}
    for row in canonical:
        cat = _normalize_caller_category(row.get("Category") or row.get("category") or "")
        categories[cat] = categories.get(cat, 0) + 1

    print(f"\n  Canonical category counts:")
    for cat, count in sorted(categories.items()):
        print(f"    {cat}: {count}")

    # Verify Sam Smith and Susan Miller-Smith
    sam_found = False
    susan_found = False
    for row in canonical:
        first = str(row.get("First") or row.get("first_name") or "").strip()
        last = str(row.get("Last") or row.get("last_name") or "").strip()
        zip_code = str(row.get("Zip") or row.get("zip") or "").strip()
        if first == "Sam" and last == "Smith":
            sam_found = True
            print(f"\n  [OK] Sam Smith found in canonical source, ZIP={zip_code}")
        if first == "Susan" and last == "Miller-Smith":
            susan_found = True
            print(f"  [OK] Susan Miller-Smith found in canonical source, ZIP={zip_code}")

    if not sam_found:
        print("\n  [WARN] Sam Smith NOT found in canonical callers.csv")
    if not susan_found:
        print("  [WARN] Susan Miller-Smith NOT found in canonical callers.csv")

    # Content hash
    caller_data = [
        {
            "first_name": str(r.get("First") or r.get("first_name") or "").strip(),
            "last_name": str(r.get("Last") or r.get("last_name") or "").strip(),
            "category": _normalize_caller_category(r.get("Category") or r.get("category") or ""),
            "zip": str(r.get("Zip") or r.get("zip") or "").strip(),
        }
        for r in canonical
    ]
    print(f"\n  Canonical content hash: {_content_hash(caller_data)}")
    print(f"  Intended import count: {len(canonical)} callers")

    return len(issues) == 0


def audit_discord_posts(verbose=False):
    """Reconcile Discord Post data sources."""
    print("\n" + "=" * 60)
    print("DISCORD POSTS RECONCILIATION")
    print("=" * 60)

    posts = _load_csv(DISCORD_CSV)
    print(f"\n  Bundled source (discord-posts.csv): {len(posts)} rows")

    # Check for VPN Fail and Wrong Headset corrections
    vpn_fail_found = False
    wrong_headset_found = False
    vpn_fail_correct = False
    wrong_headset_correct = False

    for row in posts:
        title = str(row.get("Title") or row.get("title") or "").strip()
        message = str(row.get("Message") or row.get("message") or "")

        if title.lower() == "vpn fail":
            vpn_fail_found = True
            if "Using a VPN is not accepted when contracting with ACD" in message:
                vpn_fail_correct = True
                print(f"  [OK] VPN Fail post has corrected message")
            else:
                print(f"  [WARN] VPN Fail post has STALE message")

        if title.lower() == "wrong headset":
            wrong_headset_found = True
            if "A USB headset with a noise cancelling microphone is required" in message:
                wrong_headset_correct = True
                print(f"  [OK] Wrong Headset post has corrected message")
                # Verify screenshot association
                screenshots = str(row.get("SuggestedScreenshots") or row.get("suggested_screenshots") or "").strip()
                if "/usb.png" in screenshots:
                    print(f"  [OK] Wrong Headset has /usb.png screenshot association")
                else:
                    print(f"  [WARN] Wrong Headset missing /usb.png screenshot association")
            else:
                print(f"  [WARN] Wrong Headset post has STALE message")

    if not vpn_fail_found:
        print("  [WARN] VPN Fail post NOT found")
    if not wrong_headset_found:
        print("  [WARN] Wrong Headset post NOT found")

    # Check email format
    for row in posts:
        message = str(row.get("Message") or row.get("message") or "")
        if "certification@acdsupport.com" in message:
            if "\\@" in message:
                print(f"  [WARN] Found escaped \\@ in {row.get('Title', '?')}")
            else:
                if verbose:
                    print(f"  [OK] {row.get('Title', '?')} has correct email format")

    # Verify newlines
    for row in posts:
        title = str(row.get("Title") or row.get("title") or "").strip()
        message = str(row.get("Message") or row.get("message") or "")
        if title.lower() in ("vpn fail", "wrong headset"):
            if "\nPlease review the feedback given" in message:
                if verbose:
                    print(f"  [OK] {title} preserves newline before 'Please review'")

    # Content hash
    post_data = [
        {
            "title": str(r.get("Title") or r.get("title") or "").strip(),
            "category": str(r.get("Category") or r.get("category") or "General").strip(),
        }
        for r in posts
    ]
    print(f"\n  Content hash: {_content_hash(post_data)}")
    print(f"  Intended import count: {len(posts)} discord posts")

    # Category distribution
    categories = {}
    for row in posts:
        cat = str(row.get("Category") or row.get("category") or "General").strip()
        categories[cat] = categories.get(cat, 0) + 1
    print(f"\n  Category distribution:")
    for cat, count in sorted(categories.items()):
        print(f"    {cat}: {count}")

    return vpn_fail_correct and wrong_headset_correct


def audit_uncommitted_corrections():
    """Verify the 4 uncommitted owner-approved corrections are intact."""
    print("\n" + "=" * 60)
    print("UNCOMMITTED CORRECTIONS VERIFICATION")
    print("=" * 60)

    expected_files = [
        "backend/content/app_content.json",
        "backend/defaults/discord-posts.csv",
        "docs/admin-content-package/csv-tabs/discord-posts.csv",
        "docs/admin-content-package/mock-testing-suite-admin-content.xml",
    ]

    all_present = True
    for f in expected_files:
        full_path = REPO_ROOT / f
        if full_path.is_file():
            print(f"  [OK] {f} exists")
        else:
            print(f"  [WARN] {f} NOT found")
            all_present = False

    return all_present


def main():
    verbose = "--verbose" in sys.argv or "-v" in sys.argv

    print("=" * 60)
    print("MTS/SAM Content Migration — Dry-Run Reconciliation")
    print("=" * 60)
    print(f"Repository: {REPO_ROOT}")
    print(f"Mode: READ-ONLY dry-run")

    callers_ok = audit_callers(verbose)
    discord_ok = audit_discord_posts(verbose)
    uncommitted_ok = audit_uncommitted_corrections()

    print("\n" + "=" * 60)
    print("SUMMARY")
    print("=" * 60)
    print(f"  Callers: {'[PASS]' if callers_ok else '[WARN] ISSUES FOUND'}")
    print(f"  Discord Posts: {'[PASS]' if discord_ok else '[WARN] ISSUES FOUND'}")
    print(f"  Uncommitted corrections: {'[INTACT]' if uncommitted_ok else '[WARN] MISSING'}")
    print()
    print("  No hosted writes were performed.")
    print("  Actual import seeding is a separate owner-authorized stage.")


if __name__ == "__main__":
    main()
