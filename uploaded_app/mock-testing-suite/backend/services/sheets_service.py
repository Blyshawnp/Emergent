"""
sheets_service.py — Saves session data to a Google Spreadsheet.
Uses gspread + google-auth with a service_account.json file.
"""
import os
from datetime import datetime
from typing import Optional


HEADERS = [
    "Timestamp", "Tester Name", "Candidate Name", "Skills Tested", "Headset Used",
    "Tech Issues", "Call1 Type", "Call1 Result", "Call1 Coaching", "Call1 Fail Reason",
    "Call2 Type", "Call2 Result", "Call2 Coaching", "Call2 Fail Reason", "Call3 Used",
    "Call3 Type", "Call3 Result", "Call3 Coaching", "Call3 Fail Reason", "Sup1 Result",
    "Sup1 Coaching", "Sup2 Needed", "Sup2 Result", "Sup2 Coaching", "Mock Complete",
    "Sup Transfer Complete", "All Complete", "Newbie Shift", "Auto Fail", "Coaching Summary",
    "Final Fail Reason", "Gemini Summary", "Gemini Failed", "Session Status", "Form Status",
]


def _get_coach_str(data: Optional[dict]) -> str:
    if not data:
        return "N/A"
    items = [k for k, v in data.get("coaching", {}).items() if v and k != "Other"]
    if data.get("coach_notes"):
        items.append(data["coach_notes"])
    return ", ".join(items) if items else "N/A"


def _get_fail_str(data: Optional[dict]) -> str:
    if not data or data.get("result") != "Fail":
        return "N/A"
    items = [k for k, v in data.get("fails", {}).items() if v and k != "Other"]
    if data.get("fail_notes"):
        items.append(data["fail_notes"])
    return ", ".join(items) if items else "N/A"


def save_to_sheet(
    session: dict,
    sheet_id: str,
    service_account_path: str,
    worksheet_name: str = "Sheet1",
    coaching_summary: str = "",
    fail_summary: str = "",
) -> dict:
    """
    Append a row of session data to the specified Google Sheet.
    Returns {"ok": True} or {"ok": False, "error": "..."}.
    """
    try:
        import gspread
        from google.oauth2.service_account import Credentials
    except ImportError:
        return {"ok": False, "error": "Missing packages: pip install gspread google-auth"}

    if not os.path.exists(service_account_path):
        return {"ok": False, "error": f"Service account file not found: {service_account_path}"}

    try:
        scopes = [
            "https://www.googleapis.com/auth/spreadsheets",
            "https://www.googleapis.com/auth/drive",
        ]
        creds = Credentials.from_service_account_file(service_account_path, scopes=scopes)
        client = gspread.authorize(creds)

        spreadsheet = client.open_by_key(sheet_id)
        try:
            sheet = spreadsheet.worksheet(worksheet_name)
        except gspread.exceptions.WorksheetNotFound:
            sheet = spreadsheet.sheet1

        # Create headers if sheet is empty
        if len(sheet.get_all_values()) == 0:
            sheet.append_row(HEADERS)
            sheet.freeze(rows=1)
            sheet.format("A1:AI1", {"textFormat": {"bold": True}})

        # Build row
        tester = session.get("tester_name", "N/A")
        name = session.get("candidate_name", "Unknown")
        sup_only = session.get("supervisor_only", False)
        skills = "Supervisor Transfer" if sup_only else "Mock Calls, Supervisor Transfer"
        headset = session.get("headset_brand", "N/A")
        tech = session.get("tech_issue", "N/A")
        status = session.get("final_status", "Fail")
        auto_fail = session.get("auto_fail_reason", "N/A")

        c1 = session.get("call_1") or {}
        c2 = session.get("call_2") or {}
        c3 = session.get("call_3") or {}
        s1 = session.get("sup_transfer_1") or {}
        s2 = session.get("sup_transfer_2") or {}

        call3_used = "Yes" if c3.get("result") else "No"
        sup2_needed = "Yes" if s2.get("result") else "No"
        mock_comp = "Yes" if c1.get("result") and c2.get("result") else "No"
        sup_comp = "Yes" if s1.get("result") else "No"
        all_comp = "Yes" if status == "Pass" else "No"

        newbie = session.get("newbie_shift_data")
        newbie_str = (
            f"{newbie.get('newbie_date')} {newbie.get('newbie_time')} {newbie.get('newbie_tz')}"
            if newbie else "N/A"
        )

        final_fail = auto_fail if auto_fail != "N/A" else (
            "Failed live calls" if status == "Fail" else "N/A"
        )

        row_data = [
            datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            tester, name, skills, headset, tech,
            c1.get("type", "N/A"), c1.get("result", "N/A"), _get_coach_str(c1), _get_fail_str(c1),
            c2.get("type", "N/A"), c2.get("result", "N/A"), _get_coach_str(c2), _get_fail_str(c2),
            call3_used, c3.get("type", "N/A"), c3.get("result", "N/A"), _get_coach_str(c3), _get_fail_str(c3),
            s1.get("result", "N/A"), _get_coach_str(s1),
            sup2_needed, s2.get("result", "N/A"), _get_coach_str(s2),
            mock_comp, sup_comp, all_comp, newbie_str, auto_fail,
            coaching_summary, final_fail, "N/A", fail_summary, status, "Pending",
        ]

        sheet.append_row(row_data)
        return {"ok": True}

    except Exception as e:
        return {"ok": False, "error": str(e)}
