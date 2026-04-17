"""Settings API routes — read and write user settings."""
import json
from fastapi import APIRouter, HTTPException
import config

router = APIRouter()


def _read_settings() -> dict:
    try:
        with open(config.SETTINGS_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return dict(config.DEFAULT_SETTINGS)


def _write_settings(data: dict):
    with open(config.SETTINGS_FILE, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)


@router.get("")
async def get_settings():
    """Return the full settings object."""
    return _read_settings()


@router.put("")
async def save_settings(payload: dict):
    """Merge incoming settings into the stored settings and save."""
    current = _read_settings()
    current.update(payload)
    _write_settings(current)
    return {"ok": True}


@router.get("/defaults")
async def get_defaults():
    """Return default data for populating dropdowns, callers, shows, etc."""
    return {
        "call_types": config.CALL_TYPES,
        "sup_reasons": config.SUP_REASONS,
        "shows": config.SHOWS,
        "donors_new": config.NEW_DONORS,
        "donors_existing": config.EXISTING_MEMBERS,
        "donors_increase": config.INCREASE_SUSTAINING,
        "discord_templates": config.DISCORD_TEMPLATES,
        "payment": config.DEFAULT_PAYMENT,
        "tech_issues": config.TECH_ISSUES,
        "auto_fail_reasons": config.AUTO_FAIL_REASONS,
    }


@router.post("/complete-setup")
async def complete_setup(payload: dict):
    """Mark setup wizard as complete and save initial profile data."""
    current = _read_settings()
    current["setup_complete"] = True
    current["tester_name"] = payload.get("tester_name", current.get("tester_name", ""))
    current["display_name"] = payload.get("display_name", current.get("display_name", ""))
    if "form_url" in payload:
        current["form_url"] = payload["form_url"]
    _write_settings(current)
    return {"ok": True}
