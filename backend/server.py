"""
Mock Testing Suite v3.0 — FastAPI Backend
All routes in a single file for simplicity. Uses MongoDB for persistence.
"""
import os
import json
import sys
import logging
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional
from contextlib import asynccontextmanager
from functools import lru_cache

from fastapi import FastAPI, APIRouter
from fastapi.middleware.cors import CORSMiddleware
from dotenv import load_dotenv
from motor.motor_asyncio import AsyncIOMotorClient
from pydantic import BaseModel
from services.form_filler import fill_form as fill_cert_form

ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / '.env')

logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(name)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

# ══════════════════════════════════════════════════════════════════
# CONSTANTS / DEFAULTS
# ══════════════════════════════════════════════════════════════════
APP_VERSION = "2.5.0"
DEFAULT_MONGO_URL = "mongodb://127.0.0.1:27017"
DEFAULT_DB_NAME = "mock_testing_suite"
DEFAULT_CERT_SHEET_URL = "https://acddirect-my.sharepoint.com/:x:/p/becky_sowles/IQDxXC0z-rUHS6oowjotk0e6AZeldAj2eFiqT8oNiOEAWjA?rtime=5Q1giSl33kg"

mongo_url = (os.getenv("MONGO_URL") or "").strip()
db_name = (os.getenv("DB_NAME") or "").strip()

if mongo_url:
    logger.info("[STARTUP] MONGO_URL loaded from environment.")
else:
    mongo_url = DEFAULT_MONGO_URL
    logger.warning("[STARTUP] MONGO_URL was not set. Using fallback %s", DEFAULT_MONGO_URL)

if db_name:
    logger.info("[STARTUP] DB_NAME loaded from environment.")
else:
    db_name = DEFAULT_DB_NAME
    logger.warning("[STARTUP] DB_NAME was not set. Using fallback %s", DEFAULT_DB_NAME)

client = AsyncIOMotorClient(mongo_url)
db = client[db_name]


def _content_file_candidates():
    candidates = []
    resources_root = (os.getenv("APP_RESOURCES_PATH") or "").strip()
    if resources_root:
        candidates.append(Path(resources_root) / "backend" / "content" / "app_content.json")
    if getattr(sys, "frozen", False):
        candidates.append(Path(sys.executable).resolve().parent / "content" / "app_content.json")
    candidates.append(ROOT_DIR / "content" / "app_content.json")
    return candidates


def _runtime_config_candidates():
    candidates = []
    resources_root = (os.getenv("APP_RESOURCES_PATH") or "").strip()
    if resources_root:
        candidates.append(Path(resources_root) / "backend" / "config" / "runtime_config.json")
    if getattr(sys, "frozen", False):
        candidates.append(Path(sys.executable).resolve().parent / "config" / "runtime_config.json")
    candidates.append(ROOT_DIR / "config" / "runtime_config.json")
    return candidates


def _load_external_content():
    for candidate in _content_file_candidates():
        try:
            if candidate.is_file():
                with candidate.open("r", encoding="utf-8") as f:
                    data = json.load(f)
                logger.info("[CONTENT] Loaded editable content from %s", candidate)
                return data
        except Exception as exc:
            logger.warning("[CONTENT] Failed to load %s: %s", candidate, exc)
    logger.info("[CONTENT] Using built-in content defaults")
    return {}


@lru_cache(maxsize=1)
def _load_backend_runtime_config():
    for candidate in _runtime_config_candidates():
        try:
            if candidate.is_file():
                with candidate.open("r", encoding="utf-8") as f:
                    data = json.load(f)
                logger.info("[CONFIG] Loaded backend runtime config from %s", candidate)
                return data
        except Exception as exc:
            logger.warning("[CONFIG] Failed to load %s: %s", candidate, exc)
    logger.info("[CONFIG] No backend runtime config found")
    return {}

CALL_TYPES = [
    "New Donor - One Time Donation",
    "New Donor - New Sustaining Donation",
    "Existing Member - One Time Donation",
    "Existing Member - New Monthly Sustaining Donation",
    "Existing Member - Increase Current Sustaining Amount",
]

SUP_REASONS = [
    "Hung up on", "Charged for a cancelled sustaining", "Double Charged",
    "Damaged Gift", "Didn't Receive Gift", "Cancel Sustaining", "Use Own/Other",
]

# [Show Name, One-Time, Monthly, Gift]
SHOWS = [
    ["New Divas - Live in Vienna", "$216", "$18", "The New Divas - Best of Live in Vienna (CD) + Wine Glasses + PBS Retro Speaker"],
    ["Alan Jackson's Precious Memories", "$120", "$10", "2-CD Set"],
    ["Doo Wop Project", "$192", "$16", "Combo-DVD & 3 CDs"],
    ["Aging Backwards 3", "$240", "$20", "Aging Backwards 3: (DVD) + 4-DVD Workouts Set + Calendar + TV Subscription + HBK"],
    ["Great American Recipes", "$360", "$30", "Great American Recipes cookbook and Finding Your Roots companion book (HBK)"],
    ["Easy Yoga", "$144", "$12", "Easy Yoga for Everything 10 DVD combo"],
]

# [First, Last, Address, City, State, Zip, Phone, Email]
NEW_DONORS = [
    ["Sam", "Smith", "400 N Broad St", "Philadelphia", "PA", "19103", "215-515-1212", "ssmith@test.com"],
    ["Harold", "Smith", "3686 Village Dr Apt. D", "Franklin", "OH", "45005", "858-555-1212", "sally@test.com"],
    ["Harry", "Smith", "P.O. Box 6", "Atlasburg", "PA", "15004", "602-515-1212", "testentry@test.com"],
    ["Mark", "Jackson", "1020 Holland Ave", "Port Huron", "MI", "48060", "310-515-1212", "mjtest@test.com"],
]

EXISTING_MEMBERS = [
    ["Ron", "Jones", "3345 W. Auburn Rd, Apt 207", "Rochester Hills", "MI", "48309", "858-555-1212", "michele@test.com"],
    ["Diane/James", "Williams", "8150 Priestley Dr", "Reynoldsburg", "OH", "43068", "619-555-1212", "DandJ@test.com"],
    ["Harry", "Jones", "876 McDonald Ave", "Brooklyn", "NY", "11218", "619-555-1212", "test@test.com"],
]

INCREASE_SUSTAINING = [
    ["Alison", "DeRudder", "2200 N Hillman Rd", "Stanton", "MI", "48888", "801-555-1212", "TESTENTRY@TEST.COM"],
    ["Sherri", "Testing", "104 Newport Dr", "Boardman", "OH", "44512", "(801) 555-1217", "TESTENTRY@TEST.COM"],
]

DISCORD_TEMPLATES = [
    ["Pass", "**:tada: Congratulations! You passed your test calls! :tada:**\n- 24-48hrs to go live. Watch your inbox.\n- Log out of Call Corp and Simple Script.\n- Complete TLMS courses.\n- Remove extra mock shifts from Gateway.\n**Welcome to ACDD!**"],
    ["Fail", "Unfortunately I can't pass you today. Please reschedule in Gateway within 24 hours."],
    ["Fail Final", "Thank you for your time. Unfortunately you have exceeded the allowed Mock Call attempts. We wish you luck."],
    ["Incomplete", "Our time is up. We'll schedule another session for Supervisor Transfers.\nPlease give me a moment."],
    ["Ncns", "Candidate was a No Call / No Show for mock testing."],
    ["Sup Intro", "I'll help you complete the Supervisor Transfer test call. I'll provide instructions step by step. OK?"],
    ["Sup Instructions", "When you need to transfer:\n1) Ask in chat first\n2) Give CCM time to check\n3) When CCM says ok - let caller know you are transferring"],
    ["Sup Transfer", "1. Click Transfer in CC\n2. Select Queue > ACD Direct Supervisor\n3. Tell caller to hold, click Blind Transfer"],
    ["Sup Dte", "Change DTE to Ready (green)."],
    ["Sup Status", "I show Ready. Calling now."],
    ["Sup Transfer Now", "You may transfer the call now."],
    ["Sup Stars", "WXYZ Supervisor Test Call Being Queued"],
    ["Sup Disposition", "Click cancel (red phone), disposition as Test/Training.\nThen disposition in Call Corp."],
    ["Sup Retry", "Transfer was not successful. Review steps and let me know when ready."],
    ["Ran Out Of Time", "We have run out of time for today's session. I will need to schedule you for a Newbie Shift to complete the Supervisor Transfer portion."],
]

DEFAULT_PAYMENT = {
    "cc_type": "American Express",
    "cc_number": "3782 822463 10005",
    "cc_exp": "07/2027",
    "cc_cvv": "1928",
    "eft_routing": "021000021",
    "eft_account": "1357902468",
}

TECH_ISSUES = [
    "Internet speed issues",
    "Calls would not route",
    "No script pop",
    "Discord issues",
    "Other",
]

AUTO_FAIL_REASONS = [
    "NC/NS",
    "Stopped responding in chat",
    "Not ready for session",
    "Unable to turn off VPN",
    "Wrong headset (not USB)",
    "Wrong headset (not noise cancelling)",
]

TICKER_MESSAGES = [
    "Welcome to Mock Testing Suite v2.5.0",
    "Tip: Use the Discord Post button to quickly copy common messages",
    "Need help? Check the Help tab for step-by-step setup guides",
]

TICKER_DOC_URL = "https://docs.google.com/document/d/1kRJMSd-1qK3qU6jDYr30HeNglrqTiF0tF5fiYEhpP80/export?format=txt"
UPDATE_DOC_URL = "https://docs.google.com/document/d/1_5L1LS6i5bYWxRYUiBrmaVonbQq9nEhY68XrL5G9c1w/export?format=txt"

DEFAULT_FORM_URL = "https://forms.office.com/pages/responsepage.aspx?id=3KFHNUeYz0mR2noZwaJeQnNAxP4sz6FBkEyNHMuYWT1URDZKWk1RWDU2VjRLTEZKNUxCWU1RRFlUVS4u&route=shorturl"

DISCORD_SCREENSHOTS = [
    {"title": "Welcome New Agent", "image_url": "/welcome-new-agent.png"},
    {"title": "Welcome to Stars", "image_url": "/welcome-to-stars.png"},
]

HELP_CONTENT = {
    "howto": [
        {
            "title": "Home Screen",
            "paragraphs": [
                "The Home screen is your dashboard. It shows your stats (Total Sessions, Pass Rate, NC/NS Rate) and recent sessions."
            ],
            "bullets": [
                "<b>Start New Session</b> — Begin a full mock call + supervisor transfer session",
                "<b>Supervisor Transfer Only</b> — Used when a candidate previously ran out of time and only needs supervisor transfers",
                "<b>Session History</b> — View all past sessions with search and detail views",
            ],
        },
        {
            "title": "The Basics Screen",
            "paragraphs": [
                "This is the first step in every session. You'll verify the candidate's setup.",
                "<b>Footer buttons:</b>",
            ],
            "bullets": [
                "<b>Tester Name</b> — Auto-filled from your settings",
                "<b>Candidate Name</b> — Type the candidate's full name (required)",
                "<b>Final Attempt</b> — Mark whether this is the candidate's last allowed mock session",
                "<b>Headset</b> — Must be USB with noise-cancelling microphone. If not, auto-fails",
                "<b>VPN</b> — If they have one, they must turn it off. If they can't, auto-fails",
                "<b>Browser</b> — Must be default, extensions off, pop-ups allowed",
                "<b style=\"color: var(--color-danger)\">NC/NS</b> — No Call / No Show. Instantly fails and goes to Review",
                "<b style=\"color: var(--color-danger)\">Not Ready</b> — Candidate wasn't prepared for the session",
                "<b style=\"color: var(--color-danger)\">Stopped Responding</b> — Candidate went silent in Discord",
                "<b>Tech Issue</b> — Opens the Technical Issues dialog for troubleshooting",
            ],
        },
        {
            "title": "Calls Screen (Up to 3)",
            "paragraphs": [
                "You'll grade up to 3 mock calls. The scenario card shows you exactly who to portray.",
                "<b>Routing logic:</b> 2 passes (1 New Donor + 1 Existing Member) → Sup Transfers. 2 fails → session ends. 1+1 → Call 3.",
            ],
            "bullets": [
                "<b>Call Setup</b> — Select Call Type, Show, Caller, and Donation from the dropdowns",
                "<b>Scenario Card</b> — Shows the caller's info, gift, and randomized variables (Phone Type, SMS, E-Newsletter, Shipping, CC Fee)",
                "<b>Regenerate</b> — Re-rolls the random scenario variables without changing the call data",
                "<b>Payment Simulation</b> — Shows the credit card and EFT info for the test call",
                "<b>Pass/Fail</b> — Click PASS or FAIL after the call",
                "<b>Coaching</b> — Select coaching checkboxes (required — if none selected, you'll be asked to confirm)",
                "<b>Fail Reasons</b> — If FAIL, you must select at least one fail reason",
            ],
        },
        {
            "title": "Supervisor Transfer Screen (Up to 2)",
            "paragraphs": [
                "Tests the candidate's ability to transfer to a supervisor. Same coaching/fail flow as calls."
            ],
            "bullets": [
                "Post \"WXYZ Supervisor Test Call Being Queued\" in Discord Stars channel",
                "Call the WXYZ number: <b>1-828-630-7006</b>",
                "Pass Transfer 1 → done (go to Review). Fail both → Newbie Shift.",
            ],
        },
        {
            "title": "Smart Resume for Supervisor Transfer Only",
            "paragraphs": [
                "The Smart Resume flow helps you continue a candidate into Supervisor Transfer when the mock calls were already completed in an earlier session."
            ],
            "bullets": [
                "<b>When it appears</b> — Click <b>Supervisor Transfer Only</b> from Home, then answer <b>Yes</b> when asked if you previously conducted the mock session for that candidate.",
                "<b>How it finds sessions</b> — The app looks through saved history for prior mock-call sessions tied to the current tester name in Settings. It only shows sessions that already have mock call results and have not already completed supervisor transfers.",
                "<b>What you’ll see</b> — If matching sessions exist, a resume picker opens so you can choose the right candidate. If none exist, the app tells you there are no resumable sessions for that tester.",
                "<b>How to continue</b> — Select the candidate, confirm the prompt, and the app restores the earlier Basics and mock-call data, then opens directly on <b>Supervisor Transfer #1</b>.",
            ],
        },
        {
            "title": "Newbie Shift Screen",
            "paragraphs": [
                "Only appears when the candidate needs a follow-up session. Pick a date, time, and timezone."
            ],
            "bullets": [
                "Enter the date using the date picker or type in MM/DD/YYYY format",
                "Enter time as H:MM (e.g. 10:30)",
                "<b>Add to Google Calendar</b> — Creates an event titled \"Supervisor Test Call - [Candidate Name]\"",
            ],
        },
        {
            "title": "Review Screen",
            "paragraphs": [
                "Final review of the session. The Pass/Fail/Incomplete banner is calculated automatically."
            ],
            "bullets": [
                "<b>Coaching Summary</b> — Generated from your coaching checkboxes (or Gemini AI if enabled)",
                "<b>Fail Summary</b> — Generated from fail reasons (N/A for passing sessions)",
                "<b>Copy</b> — Copies the summary text to your clipboard",
                "<b>Regenerate</b> — Rebuilds the summary from checkbox data",
                "<b>Fill Form</b> — Opens the Cert Form and maps session data to form fields",
                "<b>Save & Finish</b> — Saves to history and clears the session",
            ],
        },
        {
            "title": "Discord Post Panel",
            "paragraphs": [
                "Click \"Discord Post\" in the sidebar to open the panel with two tabs:"
            ],
            "bullets": [
                "<b>Templates</b> — Pre-written messages for Pass, Fail, Sup Intro, etc. Click \"Copy\" to copy to clipboard",
                "<b>Screenshots</b> — Welcome images that can be copied to clipboard for Discord. Click \"Copy Image\" to copy",
                "Both tabs are searchable",
            ],
        },
        {
            "title": "Tech Issue Button",
            "paragraphs": [
                "Available on every session screen. Opens a troubleshooting wizard:"
            ],
            "bullets": [
                "<b>Internet Speed</b> — Asks for speed test results. Below 25 Mbps down / 10 Mbps up = fail",
                "<b>Calls Won't Route</b> — Checks DTE status, then browser troubleshooting",
                "<b>No Script Pop</b> — Browser troubleshooting steps",
                "<b>Discord/Other</b> — Manual notes with resolution tracking",
            ],
        },
    ],
    "flows": [
        {
            "title": "Standard Full Session",
            "paragraphs": [
                "The Basics → Call 1 → Call 2 → (Call 3 if needed) → Sup Transfer 1 → (Sup Transfer 2 if needed) → Review → Save",
                "<b>Pass conditions:</b> 2 passed calls (1 New Donor + 1 Existing) AND 1 passed Sup Transfer.",
            ],
        },
        {
            "title": "Supervisor Transfer Only",
            "paragraphs": [
                "Used when the candidate previously completed mock calls but still needs supervisor transfers."
            ],
            "bullets": [
                "If you answer <b>No</b> to the resume prompt, the app starts a fresh Supervisor Transfer Only flow through Basics and then routes straight to Supervisor Transfer.",
                "If you answer <b>Yes</b>, Smart Resume searches your saved history for prior mock-call sessions completed by the current tester and lets you continue the correct candidate into Supervisor Transfer.",
            ],
        },
        {
            "title": "Newbie Shift (Incomplete)",
            "paragraphs": [
                "If the candidate fails both Sup Transfers or can't complete due to tech issues, a Newbie Shift is scheduled. The session is marked \"Incomplete\" rather than \"Fail\"."
            ],
        },
        {
            "title": "Auto-Fail Scenarios",
            "bullets": [
                "<b>NC/NS</b> — No Call / No Show",
                "<b>Stopped Responding</b> — Candidate went silent in Discord",
                "<b>Not Ready</b> — Incorrect setup, can't log in",
                "<b>Wrong Headset</b> — Not USB or not noise-cancelling",
                "<b>VPN</b> — Using VPN and can't turn it off",
            ],
        },
    ],
    "integrations": [
        {
            "title": "Gemini AI — Smart Summaries",
            "paragraphs": [
                "When enabled, Gemini creates clean coaching and fail summaries from the coaching and fail reason checkboxes you selected during the session."
            ],
            "footer": "Gemini uses the session's coaching and fail selections to write a cleaner summary automatically when Review loads.",
        },
        {
            "title": "Google Calendar",
            "paragraphs": [
                "The \"Add to Google Calendar\" button on the Newbie Shift screen creates a calendar event. No setup needed — it uses a Google Calendar URL template."
            ],
        },
    ],
    "faq": [
        {"q": "What if the candidate stops responding?", "a": "Click the red \"Stopped Responding\" button. This instantly ends the session as a fail."},
        {"q": "What if the candidate has technical issues?", "a": "Click \"Tech Issue\". The app walks you through troubleshooting: check DTE status, clear browsing data, re-login."},
        {"q": "Can I go back and change something?", "a": "Yes — click \"Back\" on any screen. Your data is saved as you go."},
        {"q": "What if I forget to select coaching?", "a": "The app will ask you to confirm if you want to continue without coaching."},
        {"q": "How do I do a Supervisor Transfer ONLY session?", "a": "On the Home screen, click \"Supervisor Transfer Only\". This skips Mock Calls."},
        {"q": "What does \"Final Attempt\" mean?", "a": "Use this on The Basics screen when the candidate is on their last allowed attempt. The app uses it in the session flow and messaging."},
        {"q": "How does Smart Resume find a candidate for Supervisor Transfer Only?", "a": "It searches saved history for prior mock-call sessions that belong to the current tester, already have mock call results, and do not already have completed supervisor transfers."},
        {"q": "What if 2 calls fail?", "a": "The session ends immediately and goes to Review. They should reschedule within 24 hours."},
        {"q": "Where is my data stored?", "a": "In the app's local database."},
        {"q": "How do I customize the Discord templates?", "a": "Go to Settings → Discord tab. You can add, edit, and remove both message templates and screenshot images."},
        {"q": "Can I edit the caller data and shows?", "a": "Yes — go to Settings. The Call Types, Shows, Callers, and Sup Reasons tabs let you fully customize all scenario data."},
    ],
    "support": {
        "intro": "Need help with the app? Reach out using one of these options:",
        "email": "blyshawnp@gmail.com",
        "discord_name": "shawnbly",
        "discord_url": "https://discord.com/users/shawnbly",
        "footer": "Include a description of the issue, what screen you were on, and any error messages you saw.",
    },
}

EXTERNAL_CONTENT = _load_external_content()

if isinstance(EXTERNAL_CONTENT.get("discord_templates"), list) and EXTERNAL_CONTENT["discord_templates"]:
    DISCORD_TEMPLATES = EXTERNAL_CONTENT["discord_templates"]

if isinstance(EXTERNAL_CONTENT.get("discord_screenshots"), list) and EXTERNAL_CONTENT["discord_screenshots"]:
    DISCORD_SCREENSHOTS = EXTERNAL_CONTENT["discord_screenshots"]

if isinstance(EXTERNAL_CONTENT.get("help"), dict) and EXTERNAL_CONTENT["help"]:
    HELP_CONTENT = EXTERNAL_CONTENT["help"]

DEFAULT_SETTINGS = {
    "setup_complete": False,
    "tutorial_completed": False,
    "tester_name": "",
    "display_name": "",
    "form_fill_browser": "auto",
    "form_url": DEFAULT_FORM_URL,
    "cert_sheet_url": DEFAULT_CERT_SHEET_URL,
    "enable_sounds": True,
    "theme": "dark",
    "enable_gemini": True,
    "enable_calendar": False,
    "discord_templates": DISCORD_TEMPLATES,
    "discord_screenshots": DISCORD_SCREENSHOTS,
    "payment": DEFAULT_PAYMENT,
    "shows": SHOWS,
    "call_types": CALL_TYPES,
    "sup_reasons": SUP_REASONS,
    "donors_new": NEW_DONORS,
    "donors_existing": EXISTING_MEMBERS,
    "donors_increase": INCREASE_SUSTAINING,
}

SENSITIVE_SETTINGS_KEYS = set()

ALLOWED_SETTINGS_KEYS = set(DEFAULT_SETTINGS.keys())
PRESERVED_SETTINGS_KEYS_ON_RESTORE = {"setup_complete", "tutorial_completed"}


def sanitize_settings(doc: Optional[dict]) -> dict:
    base = dict(DEFAULT_SETTINGS)
    if doc:
        for key, value in doc.items():
            if key in ALLOWED_SETTINGS_KEYS or key in SENSITIVE_SETTINGS_KEYS:
                base[key] = value
    for key in SENSITIVE_SETTINGS_KEYS:
        base[key] = ""
        base[f"{key}_configured"] = bool(doc and doc.get(key))
    return base


def normalize_settings_payload(payload: dict) -> dict:
    sanitized = {}

    for key, value in payload.items():
        if key not in ALLOWED_SETTINGS_KEYS:
            continue

        if key in SENSITIVE_SETTINGS_KEYS:
            if isinstance(value, str) and not value.strip():
                continue
            sanitized[key] = value
            continue

        sanitized[key] = value

    return sanitized


def empty_session():
    return {
        "candidate_name": "",
        "tester_name": "",
        "pronoun": "",
        "final_attempt": False,
        "supervisor_only": False,
        "status": "In Progress",
        "auto_fail_reason": None,
        "tech_issue": "N/A",
        "headset_usb": None,
        "headset_brand": "",
        "noise_cancel": None,
        "vpn_on": None,
        "vpn_off": None,
        "chrome_default": None,
        "extensions_disabled": None,
        "popups_allowed": None,
        "call_1": None,
        "call_2": None,
        "call_3": None,
        "sup_transfer_1": None,
        "sup_transfer_2": None,
        "time_for_sup": None,
        "newbie_shift_data": None,
        "final_status": None,
        "last_saved": None,
        "tech_issues_log": [],
    }


# ══════════════════════════════════════════════════════════════════
# GEMINI SERVICE (summary generation)
# ══════════════════════════════════════════════════════════════════
def _get_coaching_items(data):
    if not data:
        return []
    items = []
    coaching = data.get("coaching", {})
    for key, checked in coaching.items():
        if checked and "_" not in key and key != "Other":
            items.append(key.lower())
        elif checked and "_" in key:
            items.append(key.split("_", 1)[1].lower())
    notes = data.get("coach_notes", "")
    if notes:
        items.append(notes)
    return items


def _get_fail_items(data):
    if not data or data.get("result") != "Fail":
        return []
    items = []
    fails = data.get("fails", {})
    for key, checked in fails.items():
        if checked and key != "Other":
            items.append(key.lower())
    notes = data.get("fail_notes", "")
    if notes:
        items.append(notes)
    return items


AUTO_FAIL_MESSAGES = {
    "nc/ns": "was a No Call / No Show. Session did not occur.",
    "stopped": "stopped responding in Discord during the session.",
    "vpn": "is using a VPN and was unable to turn it off.",
    "not ready": "was not ready for the session:",
}

AUTO_FAIL_HEADSET_KEYWORDS = ("usb", "noise")


def _resolve_auto_fail_message(name, auto_fail):
    """Map auto-fail reason to a human-readable sentence. Reduces nesting in build_clean_fail."""
    af = auto_fail.lower()
    for keyword, template in AUTO_FAIL_MESSAGES.items():
        if keyword in af:
            suffix = f" {auto_fail}" if template.endswith(":") else ""
            return f"{name} {template}{suffix}"
    if any(kw in af for kw in AUTO_FAIL_HEADSET_KEYWORDS):
        return f"{name} did not have a qualifying headset: {auto_fail}."
    return f"{name} — {auto_fail}."


def _collect_call_coaching_lines(session):
    """Gather coaching lines from call data."""
    lines = []
    for i in range(1, 4):
        call = session.get(f"call_{i}")
        if not call or not call.get("result"):
            continue
        coaching = _get_coaching_items(call)
        coaching_str = ", ".join(coaching) if coaching else "none noted"
        lines.append(f"Call {i} ({call.get('type', 'Unknown type')}): {call['result']}. Coaching: {coaching_str}.")
    return lines


def _collect_sup_coaching_lines(session):
    """Gather coaching lines from supervisor transfer data."""
    lines = []
    for i in range(1, 3):
        sup = session.get(f"sup_transfer_{i}")
        if not sup or not sup.get("result"):
            continue
        coaching = _get_coaching_items(sup)
        coaching_str = ", ".join(coaching) if coaching else "none noted"
        lines.append(f"Supervisor Transfer {i}: {sup['result']}. Coaching: {coaching_str}.")
    return lines


def _collect_fail_lines(session):
    """Gather fail reason lines from calls and supervisor transfers."""
    lines = []
    for i in range(1, 4):
        call = session.get(f"call_{i}")
        if not call or call.get("result") != "Fail":
            continue
        reasons = _get_fail_items(call)
        reasons_str = ", ".join(reasons) if reasons else "unspecified"
        lines.append(f"Call {i} ({call.get('type', 'Unknown type')}) failed: {reasons_str}.")
    for i in range(1, 3):
        sup = session.get(f"sup_transfer_{i}")
        if not sup or sup.get("result") != "Fail":
            continue
        reasons = _get_fail_items(sup)
        reasons_str = ", ".join(reasons) if reasons else "unspecified"
        lines.append(f"Supervisor Transfer {i} failed: {reasons_str}.")
    return lines


def _is_fail_na(session):
    """Determine whether the fail summary should be N/A (passing/incomplete sessions)."""
    if session.get("auto_fail_reason"):
        return False
    sup_only = session.get("supervisor_only", False)
    calls_passed = sum(1 for i in range(1, 4) if (session.get(f"call_{i}") or {}).get("result") == "Pass")
    sups_passed = sum(1 for i in range(1, 3) if (session.get(f"sup_transfer_{i}") or {}).get("result") == "Pass")
    newbie = session.get("newbie_shift_data")
    if sup_only:
        return sups_passed >= 1
    return calls_passed >= 2 and (sups_passed >= 1 or newbie)


def compute_final_status(session):
    auto_fail = session.get("auto_fail_reason")
    sup_only = session.get("supervisor_only", False)
    calls_passed = sum(1 for i in range(1, 4) if (session.get(f"call_{i}") or {}).get("result") == "Pass")
    sups_passed = sum(1 for i in range(1, 3) if (session.get(f"sup_transfer_{i}") or {}).get("result") == "Pass")
    newbie = session.get("newbie_shift_data")

    final_status = "Fail"
    if not auto_fail:
        if sup_only:
            if sups_passed >= 1:
                final_status = "Pass"
            elif newbie is not None:
                final_status = "Incomplete"
        elif calls_passed >= 2:
            if sups_passed >= 1:
                final_status = "Pass"
            elif newbie is not None:
                final_status = "Incomplete"

    return final_status


def normalize_history_status(entry):
    explicit_status = entry.get("status")
    if explicit_status in {"Pass", "Fail", "Incomplete", "NC/NS"}:
        return explicit_status

    explicit_final_status = entry.get("final_status")
    if explicit_final_status in {"Pass", "Fail", "Incomplete"}:
        return explicit_final_status

    computed_status = compute_final_status(entry)
    if computed_status != "Fail":
        return computed_status

    if entry.get("auto_fail_reason"):
        auto_fail = (entry.get("auto_fail_reason") or "").strip().lower()
        if auto_fail.startswith("nc"):
            return "NC/NS"
        return "Fail"

    call_fails = sum(1 for i in range(1, 4) if (entry.get(f"call_{i}") or {}).get("result") == "Fail")
    sup_fails = sum(1 for i in range(1, 3) if (entry.get(f"sup_transfer_{i}") or {}).get("result") == "Fail")
    sup_only = entry.get("supervisor_only", False)

    if call_fails >= 2:
        return "Fail"

    if sup_only and entry.get("final_attempt") and sup_fails >= 2:
        return "Fail"

    return "Incomplete"


def _format_local_history_timestamp(timestamp_dt):
    local_dt = timestamp_dt.astimezone()
    return {
        "timestamp": local_dt.strftime("%Y-%m-%d %I:%M %p"),
        "timestamp_iso": local_dt.isoformat(),
    }


def _normalize_history_timestamp(entry):
    timestamp_iso = (entry.get("timestamp_iso") or "").strip()
    if timestamp_iso:
        try:
            entry.update(_format_local_history_timestamp(datetime.fromisoformat(timestamp_iso)))
            return
        except ValueError:
            pass

    timestamp_text = (entry.get("timestamp") or "").strip()
    if not timestamp_text:
        return

    try:
        legacy_dt = datetime.strptime(timestamp_text, "%Y-%m-%d %I:%M %p").replace(tzinfo=timezone.utc)
        entry.update(_format_local_history_timestamp(legacy_dt))
    except ValueError:
        return


def build_clean_coaching(session):
    name = session.get("candidate_name", "Candidate")
    auto_fail = session.get("auto_fail_reason")
    if auto_fail:
        return f"{name} — Auto-fail: {auto_fail}."
    lines = []
    if not session.get("supervisor_only", False):
        lines.extend(_collect_call_coaching_lines(session))
    lines.extend(_collect_sup_coaching_lines(session))
    return "\n".join(lines) if lines else "No coaching data recorded."


def build_clean_fail(session):
    name = session.get("candidate_name", "Candidate")
    auto_fail = session.get("auto_fail_reason")
    if auto_fail:
        return _resolve_auto_fail_message(name, auto_fail)
    fail_lines = _collect_fail_lines(session)
    return "\n".join(fail_lines) if fail_lines else "N/A"


DEFAULT_GEMINI_COACHING_PROMPT = (
    "You are writing an internal certification test call results summary for management. "
    "Based on the coaching checkboxes selected during the mock certification session, "
    "write a clear, concise, management-facing summary of what occurred during the test. "
    "The summary must be objective, professional, and suitable for internal documentation. "
    "Incorporate the selected coaching checklist items directly into the summary instead of "
    "generalizing vaguely. Reference the specific coached items in plain language. Do not "
    "address the candidate. Do not use second-person language such as 'you' or 'your'. Do "
    "not give advice or instructions such as 'should', 'try to', or 'remember to'. Describe "
    "the observed performance and the coaching provided during the session."
)

DEFAULT_GEMINI_FAIL_PROMPT = (
    "You are writing an internal certification test call failure summary for management. "
    "Based on the fail reasons selected during the mock certification session, write a "
    "clear, concise, management-facing summary of why the candidate did not pass. The "
    "summary must be objective, professional, and suitable for internal documentation. "
    "Incorporate the selected fail checklist items directly into the summary instead of "
    "generalizing vaguely. Reference the specific fail reasons in plain language. Do not "
    "address the candidate. Do not use second-person language such as 'you' or 'your'. Do "
    "not give advice or instructions such as 'should', 'try to', or 'remember to'. State "
    "what occurred during the session and any additional contributing issues."
)

PREFERRED_GEMINI_TEXT_MODELS = (
    "gemini-2.5-flash",
    "gemini-2.5-flash-lite",
    "gemini-2.0-flash",
    "gemini-2.0-flash-lite",
)


def _extract_gemini_text(response):
    text = (getattr(response, "text", "") or "").strip()
    if text:
        return text

    candidates = getattr(response, "candidates", None) or []
    for candidate in candidates:
        content = getattr(candidate, "content", None)
        parts = getattr(content, "parts", None) or []
        for part in parts:
            candidate_text = (getattr(part, "text", "") or "").strip()
            if candidate_text:
                return candidate_text

    return ""


@lru_cache(maxsize=1)
def _get_backend_gemini_api_key() -> str:
    env_key = (os.getenv("GEMINI_API_KEY") or "").strip()
    if env_key:
        logger.info("[GEMINI] API key loaded from environment override")
        return env_key

    config = _load_backend_runtime_config()
    config_key = (config.get("gemini_api_key") or "").strip()
    if config_key:
        logger.info("[GEMINI] API key loaded from backend runtime config")
        return config_key

    logger.warning("[GEMINI] No backend Gemini API key configured")
    return ""


@lru_cache(maxsize=8)
def _select_supported_gemini_model(api_key: str) -> str:
    if not api_key:
        raise RuntimeError("Gemini is enabled, but no API key is saved.")

    import google.generativeai as genai

    genai.configure(api_key=api_key)

    try:
        models = list(genai.list_models())
    except Exception as exc:
        raise RuntimeError(f"Unable to list Gemini models for this API key: {exc}") from exc

    supported = {}
    for model in models:
        name = (getattr(model, "name", "") or "").strip()
        methods = set(getattr(model, "supported_generation_methods", []) or [])
        if not name or "generateContent" not in methods:
            continue
        supported[name.split("/", 1)[-1]] = model

    for preferred_model in PREFERRED_GEMINI_TEXT_MODELS:
        if preferred_model in supported:
            logger.info("[GEMINI] Using supported model %s", preferred_model)
            return preferred_model

    discovered = ", ".join(sorted(supported.keys())) or "none"
    raise RuntimeError(
        "No supported Gemini text model was found for generateContent. "
        f"Available generateContent models for this API key: {discovered}"
    )


def _generate_gemini_summary(source_text, prompt_template, api_key, summary_type):
    if not api_key:
        raise RuntimeError("Gemini is enabled, but no API key is saved.")

    import google.generativeai as genai

    genai.configure(api_key=api_key)
    model = genai.GenerativeModel(_select_supported_gemini_model(api_key))
    prompt = (
        f"{prompt_template}\n\n"
        f"Session notes:\n{source_text}\n\n"
        "Return only the final summary text with no heading, markdown, or extra commentary."
    )
    response = model.generate_content(prompt)
    text = _extract_gemini_text(response)
    if not text:
        raise RuntimeError(f"Gemini returned an empty {summary_type} summary.")
    return text


def generate_summaries(session, api_key="", settings=None):
    coaching = build_clean_coaching(session)
    fail = "N/A" if _is_fail_na(session) else build_clean_fail(session)

    use_gemini = bool(settings and settings.get("enable_gemini"))
    if not use_gemini:
        return {"coaching": coaching, "fail": fail}

    coaching_prompt = (
        (settings or {}).get("gemini_coaching_prompt") or DEFAULT_GEMINI_COACHING_PROMPT
    )
    fail_prompt = (
        (settings or {}).get("gemini_fail_prompt") or DEFAULT_GEMINI_FAIL_PROMPT
    )

    try:
        gemini_coaching = _generate_gemini_summary(
            coaching,
            coaching_prompt,
            api_key,
            "coaching",
        ) if coaching != "No coaching data recorded." else coaching

        gemini_fail = _generate_gemini_summary(
            fail,
            fail_prompt,
            api_key,
            "fail",
        ) if fail != "N/A" else fail

        return {"coaching": gemini_coaching, "fail": gemini_fail}
    except Exception as exc:
        logger.exception("[GEMINI] Summary generation failed: %s", exc)
        return {
            "coaching": coaching,
            "fail": fail,
            "error": f"Gemini summary generation failed: {exc}",
        }


def _count_results(session, prefix, total, target):
    return sum(1 for i in range(1, total + 1) if (session.get(f"{prefix}_{i}") or {}).get("result") == target)


def _format_newbie_shift_for_form(session):
    newbie = session.get("newbie_shift_data")
    if not newbie:
        return "N/A"
    parts = [newbie.get("newbie_date", "").strip(), "at", newbie.get("newbie_time", "").strip(), newbie.get("newbie_tz", "").strip()]
    return " ".join(part for part in parts if part).strip() or "N/A"


def _map_auto_fail_for_form(auto_fail_reason):
    reason = (auto_fail_reason or "").strip().lower()
    if not reason:
        return "N/A"
    if "nc/ns" in reason or "nc / ns" in reason:
        return "NC/NS"
    if "stopped responding" in reason:
        return "Stopped responding in chat"
    if "unable to turn off vpn" in reason or "vpn" in reason:
        return "Unable to turn off VPN"
    if "wrong headset" in reason and "usb" in reason:
        return "Wrong headset (not USB)"
    if "wrong headset" in reason and "noise" in reason:
        return "Wrong headset (not noise cancelling)"
    if "not ready for session" in reason:
        return "Not ready for session (incorrect settings, can't get logged in to programs)"
    return "N/A"


def _map_tech_issue_for_form(session):
    current = session.get("tech_issue")
    logs = [entry.get("issue", "") for entry in session.get("tech_issues_log", []) if isinstance(entry, dict)]
    candidates = [current, *reversed(logs)]

    for candidate in candidates:
        issue = (candidate or "").strip()
        lowered = issue.lower()
        if not issue or issue == "N/A":
            continue
        if lowered.startswith("other:"):
            other_text = issue.split(":", 1)[1].strip() or "Other"
            return {"choice": "Other", "other_text": other_text}
        if "no script pop" in lowered:
            return {"choice": "No script pop", "other_text": ""}
        if "calls would not route" in lowered:
            return {"choice": "Calls would not route", "other_text": ""}
        if "discord issues" in lowered:
            return {"choice": "Discord issues", "other_text": ""}
        if "internet speed" in lowered:
            return {"choice": "Internet speed issues", "other_text": ""}

    return {"choice": "N/A", "other_text": ""}


def _is_form_fail_session(session):
    if session.get("auto_fail_reason"):
        return False
    if session.get("supervisor_only", False):
        return _count_results(session, "sup_transfer", 2, "Fail") >= 2
    return _count_results(session, "call", 3, "Fail") >= 2


def build_form_fill_payload(session, settings, coaching_summary="", fail_summary=""):
    sup_only = session.get("supervisor_only", False)
    newbie = session.get("newbie_shift_data")
    calls_passed = _count_results(session, "call", 3, "Pass")
    calls_failed = _count_results(session, "call", 3, "Fail")
    sups_passed = _count_results(session, "sup_transfer", 2, "Pass")
    sups_failed = _count_results(session, "sup_transfer", 2, "Fail")
    sup_attempts = sups_passed + sups_failed
    final_status = compute_final_status(session)
    tech_issue = _map_tech_issue_for_form(session)
    summaries = generate_summaries(session)

    mock_complete = "No"
    if not sup_only and (calls_passed >= 2 or calls_failed >= 2):
        mock_complete = "Yes"

    sup_complete = "No"
    if not newbie:
        if sup_only and sup_attempts >= 1:
            sup_complete = "Yes"
        elif not sup_only and (sups_passed >= 1 or sups_failed >= 2):
            sup_complete = "Yes"

    all_complete = "Yes" if not newbie and (session.get("auto_fail_reason") or final_status in {"Pass", "Fail"}) else "No"

    fail_reason = "N/A"
    if _is_form_fail_session(session):
        fail_reason = (fail_summary or "").strip() or summaries["fail"]

    return {
        "tester_name": (session.get("tester_name") or settings.get("tester_name") or settings.get("display_name") or "").strip(),
        "candidate_name": (session.get("candidate_name") or "").strip(),
        "skills": ["Supervisor Transfer"] if sup_only else ["Mock Calls", "Supervisor Transfer"],
        "mock_complete": mock_complete,
        "sup_complete": sup_complete,
        "all_complete": all_complete,
        "newbie_shift": _format_newbie_shift_for_form(session),
        "auto_fail": _map_auto_fail_for_form(session.get("auto_fail_reason")),
        "headset": (session.get("headset_brand") or "N/A").strip() or "N/A",
        "tech_issue_choice": tech_issue["choice"],
        "tech_issue_other": tech_issue["other_text"],
        "coaching": (coaching_summary or "").strip() or summaries["coaching"],
        "fail_reason": fail_reason,
    }


# ══════════════════════════════════════════════════════════════════
# APP SETUP
# ══════════════════════════════════════════════════════════════════
@asynccontextmanager
async def lifespan(app: FastAPI):
    # Ensure default settings exist
    existing = await db.settings.find_one({"_id": "app_settings"})
    if not existing:
        await db.settings.insert_one({"_id": "app_settings", **DEFAULT_SETTINGS})
        logger.info("[STARTUP] Created default settings")
    else:
        # Migrate: backfill any missing fields from defaults
        updates = {}
        for key, val in DEFAULT_SETTINGS.items():
            if key not in existing:
                updates[key] = val
        # Migrate old 3-template discord to new 15-template list
        if len(existing.get("discord_templates", [])) < 5:
            updates["discord_templates"] = DISCORD_TEMPLATES
        if updates:
            await db.settings.update_one({"_id": "app_settings"}, {"$set": updates})
            logger.info(f"[STARTUP] Migrated settings: {list(updates.keys())}")
    logger.info(f"[STARTUP] Mock Testing Suite v{APP_VERSION}")
    yield
    client.close()
    logger.info("[SHUTDOWN] Server stopped")


app = FastAPI(title="Mock Testing Suite", version=APP_VERSION, lifespan=lifespan)
api_router = APIRouter(prefix="/api")

app.add_middleware(
    CORSMiddleware,
    allow_credentials=True,
    allow_origins=os.environ.get('CORS_ORIGINS', '*').split(','),
    allow_methods=["*"],
    allow_headers=["*"],
)


# ══════════════════════════════════════════════════════════════════
# SETTINGS ROUTES
# ══════════════════════════════════════════════════════════════════
@api_router.get("/settings")
async def get_settings():
    doc = await db.settings.find_one({"_id": "app_settings"}, {"_id": 0})
    return sanitize_settings(doc)


@api_router.put("/settings")
async def save_settings(payload: dict):
    updates = normalize_settings_payload(payload)
    if not updates:
        return {"ok": True}
    await db.settings.update_one(
        {"_id": "app_settings"},
        {"$set": updates},
        upsert=True
    )
    return {"ok": True}


@api_router.post("/settings/restore-defaults")
async def restore_settings_defaults():
    existing = await db.settings.find_one({"_id": "app_settings"}) or {}
    restored = dict(DEFAULT_SETTINGS)

    for key in PRESERVED_SETTINGS_KEYS_ON_RESTORE:
        if key in existing:
            restored[key] = existing[key]

    await db.settings.replace_one(
        {"_id": "app_settings"},
        {"_id": "app_settings", **restored},
        upsert=True,
    )
    return {"ok": True, "settings": sanitize_settings(restored)}


@api_router.get("/settings/defaults")
async def get_defaults():
    return {
        "call_types": CALL_TYPES,
        "sup_reasons": SUP_REASONS,
        "shows": SHOWS,
        "donors_new": NEW_DONORS,
        "donors_existing": EXISTING_MEMBERS,
        "donors_increase": INCREASE_SUSTAINING,
        "discord_templates": DISCORD_TEMPLATES,
        "payment": DEFAULT_PAYMENT,
        "tech_issues": TECH_ISSUES,
        "auto_fail_reasons": AUTO_FAIL_REASONS,
    }


@api_router.get("/help/content")
async def get_help_content():
    return HELP_CONTENT


@api_router.post("/settings/complete-setup")
async def complete_setup(payload: dict):
    update_data = {
        "setup_complete": True,
        "tester_name": payload.get("tester_name", ""),
        "display_name": payload.get("display_name", ""),
    }
    if "form_url" in payload:
        update_data["form_url"] = payload["form_url"]
    if "cert_sheet_url" in payload:
        update_data["cert_sheet_url"] = payload["cert_sheet_url"]
    await db.settings.update_one({"_id": "app_settings"}, {"$set": update_data}, upsert=True)
    return {"ok": True}


# ══════════════════════════════════════════════════════════════════
# SESSION ROUTES
# ══════════════════════════════════════════════════════════════════
@api_router.get("/session/current")
async def get_current_session():
    doc = await db.sessions.find_one({"_id": "active_session"}, {"_id": 0})
    if doc:
        return {"session": doc, "has_active": bool(doc.get("candidate_name"))}
    return {"session": None, "has_active": False}


@api_router.post("/session/start")
async def start_session(payload: dict):
    session = empty_session()
    session.update(payload)
    session["last_saved"] = datetime.now(timezone.utc).strftime("%I:%M %p")
    await db.sessions.replace_one({"_id": "active_session"}, {"_id": "active_session", **session}, upsert=True)
    return {"ok": True, "session": session}


@api_router.put("/session/update")
async def update_session(payload: dict):
    payload["last_saved"] = datetime.now(timezone.utc).strftime("%I:%M %p")
    await db.sessions.update_one({"_id": "active_session"}, {"$set": payload}, upsert=True)
    doc = await db.sessions.find_one({"_id": "active_session"}, {"_id": 0})
    return {"ok": True, "session": doc}


@api_router.post("/session/call")
async def save_call(payload: dict):
    key = f"call_{payload.get('call_num', 1)}"
    await db.sessions.update_one({"_id": "active_session"}, {"$set": {key: payload}})
    return {"ok": True}


@api_router.post("/session/sup")
async def save_sup(payload: dict):
    key = f"sup_transfer_{payload.get('transfer_num', 1)}"
    await db.sessions.update_one({"_id": "active_session"}, {"$set": {key: payload}})
    return {"ok": True}


@api_router.post("/session/finish")
async def finish_session_simple():
    doc = await db.sessions.find_one({"_id": "active_session"}, {"_id": 0})
    if not doc:
        return {"ok": False, "error": "No active session"}
    final_status = doc.get("final_status") or compute_final_status(doc)
    timestamp_fields = _format_local_history_timestamp(datetime.now(timezone.utc))
    record = {
        **doc,
        **timestamp_fields,
        "candidate": doc.get("candidate_name", "Unknown"),
        "tester_name": doc.get("tester_name", ""),
        "final_status": final_status,
        "status": final_status,
    }
    await db.history.insert_one(record)
    await db.sessions.delete_one({"_id": "active_session"})
    return {"ok": True, "record": {k: v for k, v in record.items() if k != "_id"}}


@api_router.post("/session/discard")
async def discard_session():
    await db.sessions.delete_one({"_id": "active_session"})
    return {"ok": True}


# ══════════════════════════════════════════════════════════════════
# HISTORY ROUTES
# ══════════════════════════════════════════════════════════════════
@api_router.get("/history")
async def get_history():
    docs = await db.history.find({}, {"_id": 0}).sort("timestamp", -1).to_list(500)
    for doc in docs:
        _normalize_history_timestamp(doc)
        normalized_status = normalize_history_status(doc)
        doc["status"] = normalized_status
        if normalized_status != "NC/NS":
            doc["final_status"] = doc.get("final_status") or normalized_status
    return docs


@api_router.get("/history/stats")
async def get_history_stats():
    docs = await db.history.find({}, {"_id": 0}).to_list(5000)
    total = len(docs)
    normalized_statuses = [normalize_history_status(doc) for doc in docs]
    passes = sum(1 for status in normalized_statuses if status == "Pass")
    fails = sum(1 for status in normalized_statuses if status == "Fail")
    ncns = sum(1 for status in normalized_statuses if status == "NC/NS")
    incomplete = sum(1 for status in normalized_statuses if status == "Incomplete")
    pass_rate = round((passes / total * 100) if total > 0 else 0, 1)
    return {"total": total, "passes": passes, "fails": fails, "ncns": ncns, "incomplete": incomplete, "pass_rate": pass_rate}


@api_router.delete("/history")
async def clear_history():
    await db.history.delete_many({})
    return {"ok": True}


import re
import httpx

# ══════════════════════════════════════════════════════════════════
# TICKER (fetches from Google Doc, falls back to defaults)
# ══════════════════════════════════════════════════════════════════
_ticker_cache = {"messages": None, "last_fetch": 0}

async def _fetch_ticker_from_doc():
    """Fetch ticker messages from Google Doc. Each numbered line becomes a message.
    The leading number+period is stripped. Falls back to defaults on error."""
    import time
    now = time.time()
    if _ticker_cache["messages"] and (now - _ticker_cache["last_fetch"]) < 55:
        return _ticker_cache["messages"]
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.get(TICKER_DOC_URL, follow_redirects=True)
            if resp.status_code == 200:
                text = resp.text.strip()
                lines = []
                for line in text.split('\n'):
                    line = line.strip()
                    if not line:
                        continue
                    cleaned = re.sub(r'^\d+[\.\)]\s*', '', line).strip()
                    if cleaned:
                        lines.append(cleaned)
                if lines:
                    _ticker_cache["messages"] = lines
                    _ticker_cache["last_fetch"] = now
                    return lines
    except Exception as e:
        logger.warning(f"[TICKER] Failed to fetch Google Doc: {e}")
    return TICKER_MESSAGES

@api_router.get("/ticker")
async def get_ticker():
    messages = await _fetch_ticker_from_doc()
    return {"messages": messages}


# ══════════════════════════════════════════════════════════════════
# GEMINI / SUMMARIES
# ══════════════════════════════════════════════════════════════════
@api_router.post("/gemini/summaries")
async def gen_summaries():
    doc = await db.sessions.find_one({"_id": "active_session"}, {"_id": 0})
    if not doc:
        return {"coaching": "No active session.", "fail": "No active session."}
    settings = await db.settings.find_one({"_id": "app_settings"}, {"_id": 0})
    api_key = ""
    if settings and settings.get("enable_gemini"):
        api_key = _get_backend_gemini_api_key()
    result = generate_summaries(doc, api_key, settings)
    return result


@api_router.post("/gemini/regenerate")
async def regen_summary(payload: dict):
    summary_type = payload.get("type", "coaching")
    doc = await db.sessions.find_one({"_id": "active_session"}, {"_id": 0})
    if not doc:
        return {"ok": False, "error": "No active session"}
    settings = await db.settings.find_one({"_id": "app_settings"}, {"_id": 0})
    api_key = ""
    if settings and settings.get("enable_gemini"):
        api_key = _get_backend_gemini_api_key()
    result = generate_summaries(doc, api_key, settings)
    if result.get("error"):
        return {"ok": False, "error": result["error"], "text": result.get(summary_type, "")}
    return {"ok": True, "text": result.get(summary_type, "")}


# ══════════════════════════════════════════════════════════════════
# FINISH SESSION (orchestrator)
# ══════════════════════════════════════════════════════════════════
@api_router.post("/finish-session")
async def finish_all(payload: dict):
    doc = await db.sessions.find_one({"_id": "active_session"}, {"_id": 0})
    if not doc:
        return {"ok": False, "error": "No active session"}
    final_status = doc.get("final_status") or compute_final_status(doc)
    timestamp_fields = _format_local_history_timestamp(datetime.now(timezone.utc))
    record = {
        **doc,
        **timestamp_fields,
        "candidate": doc.get("candidate_name", "Unknown"),
        "tester_name": doc.get("tester_name", ""),
        "final_status": final_status,
        "status": final_status,
        "coaching_summary": payload.get("coaching_summary", ""),
        "fail_summary": payload.get("fail_summary", ""),
    }

    await db.history.insert_one(record)
    await db.sessions.delete_one({"_id": "active_session"})
    return {"ok": True, "message": "Session saved successfully!"}


# ══════════════════════════════════════════════════════════════════
# UPDATE / FORM (stubs)
# ══════════════════════════════════════════════════════════════════
@api_router.get("/update")
async def check_update():
    return {"update_available": False, "current_version": APP_VERSION}


@api_router.get("/update/status")
async def update_status():
    return {"update_available": False, "current_version": APP_VERSION}


@api_router.post("/form/fill")
async def fill_form(payload: dict):
    session = await db.sessions.find_one({"_id": "active_session"}, {"_id": 0})
    if not session:
        return {"ok": False, "message": "No active session was found to send to the Cert Form."}

    settings = await db.settings.find_one({"_id": "app_settings"}, {"_id": 0}) or {}
    form_url = (settings.get("form_url") or DEFAULT_FORM_URL or "").strip()
    if not form_url:
        return {"ok": False, "message": "No Cert Form URL is configured in Settings."}

    form_payload = build_form_fill_payload(
        session,
        settings,
        payload.get("coaching", ""),
        payload.get("fail_reason", ""),
    )
    return fill_cert_form(form_url, form_payload, settings.get("form_fill_browser", "auto"))


@api_router.get("/")
async def root():
    return {"message": f"Mock Testing Suite API v{APP_VERSION}"}


app.include_router(api_router)
