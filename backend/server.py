"""
Mock Testing Suite v3.0 — FastAPI Backend
All routes in a single file for simplicity. Uses MongoDB for persistence.
"""
import os
import json
import logging
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional
from contextlib import asynccontextmanager

from fastapi import FastAPI, APIRouter
from fastapi.middleware.cors import CORSMiddleware
from dotenv import load_dotenv
from motor.motor_asyncio import AsyncIOMotorClient
from pydantic import BaseModel

ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / '.env')

mongo_url = os.environ['MONGO_URL']
client = AsyncIOMotorClient(mongo_url)
db = client[os.environ['DB_NAME']]

logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(name)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

# ══════════════════════════════════════════════════════════════════
# CONSTANTS / DEFAULTS
# ══════════════════════════════════════════════════════════════════
APP_VERSION = "2.5.0"

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
    "Reminder: Log out of Call Corp and Simple Script after each session",
    "Tip: Use the Discord Post button to quickly copy common messages",
    "Need help? Check the Help tab for step-by-step setup guides",
]

TICKER_DOC_URL = "https://docs.google.com/document/d/1kRJMSd-1qK3qU6jDYr30HeNglrqTiF0tF5fiYEhpP80/export?format=txt"
UPDATE_DOC_URL = "https://docs.google.com/document/d/1_5L1LS6i5bYWxRYUiBrmaVonbQq9nEhY68XrL5G9c1w/export?format=txt"

DEFAULT_FORM_URL = "https://forms.office.com/pages/responsepage.aspx?id=3KFHNUeYz0mR2noZwaJeQnNAxP4sz6FBkEyNHMuYWT1URDZKWk1RWDU2VjRLTEZKNUxCWU1RRFlUVS4u&route=shorturl"
DEFAULT_CERT_SHEET_URL = "https://acddirect-my.sharepoint.com/:x:/p/becky_sowles/IQDxXC0z-rUHS6oowjotk0e6AZeldAj2eFiqT8oNiOEAWjA?rtime=5Q1giSl33kg"

DISCORD_SCREENSHOTS = [
    {"title": "Welcome New Agent", "image_url": "/welcome-new-agent.png"},
    {"title": "Welcome to Stars", "image_url": "/welcome-to-stars.png"},
]

DEFAULT_SETTINGS = {
    "setup_complete": False,
    "tutorial_completed": False,
    "tester_name": "",
    "display_name": "",
    "form_url": DEFAULT_FORM_URL,
    "cert_sheet_url": DEFAULT_CERT_SHEET_URL,
    "theme": "dark",
    "enable_gemini": False,
    "gemini_key": "",
    "enable_sheets": False,
    "sheet_id": "",
    "worksheet": "Sheet1",
    "service_account_path": "service_account.json",
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

SENSITIVE_SETTINGS_KEYS = {
    "gemini_key",
}

ALLOWED_SETTINGS_KEYS = set(DEFAULT_SETTINGS.keys())


def sanitize_settings(doc: Optional[dict]) -> dict:
    base = dict(DEFAULT_SETTINGS)
    if doc:
        base.update(doc)
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


def generate_summaries(session, api_key=""):
    coaching = build_clean_coaching(session)
    fail = "N/A" if _is_fail_na(session) else build_clean_fail(session)
    return {"coaching": coaching, "fail": fail}


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
    record = {
        "timestamp": datetime.now(timezone.utc).strftime("%Y-%m-%d %I:%M %p"),
        "candidate": doc.get("candidate_name", "Unknown"),
        "tester_name": doc.get("tester_name", ""),
        "status": doc.get("final_status", "Fail"),
        **doc,
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
    return docs


@api_router.get("/history/stats")
async def get_history_stats():
    docs = await db.history.find({}, {"_id": 0, "status": 1}).to_list(5000)
    total = len(docs)
    passes = sum(1 for d in docs if d.get("status") == "Pass")
    fails = sum(1 for d in docs if d.get("status") == "Fail")
    ncns = sum(1 for d in docs if d.get("status") == "NC/NS" or (d.get("auto_fail_reason") or "").lower().startswith("nc"))
    incomplete = sum(1 for d in docs if d.get("status") == "Incomplete")
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
    if _ticker_cache["messages"] and (now - _ticker_cache["last_fetch"]) < 300:
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
        api_key = settings.get("gemini_key", "")
    result = generate_summaries(doc, api_key)
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
        api_key = settings.get("gemini_key", "")
    result = generate_summaries(doc, api_key)
    return {"ok": True, "text": result.get(summary_type, "")}


# ══════════════════════════════════════════════════════════════════
# FINISH SESSION (orchestrator)
# ══════════════════════════════════════════════════════════════════
@api_router.post("/finish-session")
async def finish_all(payload: dict):
    doc = await db.sessions.find_one({"_id": "active_session"}, {"_id": 0})
    if not doc:
        return {"ok": False, "error": "No active session"}
    record = {
        "timestamp": datetime.now(timezone.utc).strftime("%Y-%m-%d %I:%M %p"),
        "candidate": doc.get("candidate_name", "Unknown"),
        "tester_name": doc.get("tester_name", ""),
        "status": doc.get("final_status", "Fail"),
        "coaching_summary": payload.get("coaching_summary", ""),
        "fail_summary": payload.get("fail_summary", ""),
        **doc,
    }
    await db.history.insert_one(record)
    await db.sessions.delete_one({"_id": "active_session"})
    return {"ok": True}


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
    return {"ok": True, "message": "Form filling is available in the desktop version. In the web version, use the Copy buttons to copy summaries."}


@api_router.get("/")
async def root():
    return {"message": f"Mock Testing Suite API v{APP_VERSION}"}


app.include_router(api_router)
