"""
gemini_service.py — Generates professional coaching and fail summaries.
Uses google-generativeai SDK with gemini-2.5-flash model.
Falls back to clean checkbox-based summaries when Gemini is disabled.
"""
import json
from typing import Optional


def _get_coaching_items(data: Optional[dict]) -> list[str]:
    """Extract checked coaching items from a call/sup data dict."""
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


def _get_fail_items(data: Optional[dict]) -> list[str]:
    """Extract checked fail reasons from a call/sup data dict."""
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


def build_clean_coaching(session: dict) -> str:
    """Build a clean coaching summary from checkbox data (no Gemini)."""
    name = session.get("candidate_name", "Candidate")
    auto_fail = session.get("auto_fail_reason")
    sup_only = session.get("supervisor_only", False)
    lines = []

    if auto_fail:
        lines.append(f"{name} — Auto-fail: {auto_fail}.")
        return "\n".join(lines)

    if not sup_only:
        for i in range(1, 4):
            call = session.get(f"call_{i}")
            if call and call.get("result"):
                result = call["result"]
                ctype = call.get("type", "Unknown type")
                coaching = _get_coaching_items(call)
                coaching_str = ", ".join(coaching) if coaching else "none noted"
                lines.append(f"Call {i} ({ctype}): {result}. Coaching: {coaching_str}.")

    for i in range(1, 3):
        sup = session.get(f"sup_transfer_{i}")
        if sup and sup.get("result"):
            result = sup["result"]
            coaching = _get_coaching_items(sup)
            coaching_str = ", ".join(coaching) if coaching else "none noted"
            lines.append(f"Supervisor Transfer {i}: {result}. Coaching: {coaching_str}.")

    return "\n".join(lines) if lines else "No coaching data recorded."


def build_clean_fail(session: dict) -> str:
    """Build a clean fail summary from checkbox data (no Gemini)."""
    name = session.get("candidate_name", "Candidate")
    auto_fail = session.get("auto_fail_reason")

    if auto_fail:
        af = auto_fail.lower()
        if "nc/ns" in af:
            return f"{name} was a No Call / No Show. Session did not occur."
        elif "stopped" in af:
            return f"{name} stopped responding in Discord during the session."
        elif "vpn" in af:
            return f"{name} is using a VPN and was unable to turn it off."
        elif "usb" in af or "noise" in af:
            return f"{name} did not have a qualifying headset: {auto_fail}."
        elif "not ready" in af:
            return f"{name} was not ready for the session: {auto_fail}."
        return f"{name} — {auto_fail}."

    fail_lines = []
    for i in range(1, 4):
        call = session.get(f"call_{i}")
        if call and call.get("result") == "Fail":
            ctype = call.get("type", "Unknown type")
            reasons = _get_fail_items(call)
            reasons_str = ", ".join(reasons) if reasons else "unspecified"
            fail_lines.append(f"Call {i} ({ctype}) failed: {reasons_str}.")

    for i in range(1, 3):
        sup = session.get(f"sup_transfer_{i}")
        if sup and sup.get("result") == "Fail":
            reasons = _get_fail_items(sup)
            reasons_str = ", ".join(reasons) if reasons else "unspecified"
            fail_lines.append(f"Supervisor Transfer {i} failed: {reasons_str}.")

    return "\n".join(fail_lines) if fail_lines else "N/A"


# ── Gemini Prompt Builders ──────────────────────────────────────

COACHING_EXAMPLES = """EXAMPLE 1:
Ryan completed a New Donor - One Time Donation call successfully. He received coaching on verification using phonetics for sound alike letters. His Existing Member - Monthly Donation call failed because he skipped the thank you gift question on the gift screen. He was coached to read the script as written and not skip anything. His subsequent Existing Member - Monthly Donation call was completed successfully, and he received coaching to show appreciation to existing members. He also completed a supervisor transfer successfully, receiving coaching on transfer instructions and screenshots in Discord.

EXAMPLE 2:
Krista completed her mock call session. Her first call, a New Donor - One Time Donation, was completed successfully. She was coached to show appreciation when given the donation amount and to use verification with phonetics for sound alike letters. Her second call, an Existing Member - Monthly Donation, failed because she adlibbed the script and skipped two parts on the payment screen. She was coached to read the script verbatim without adlibbing and not to skip any script parts. Her third call, an Existing Member - Monthly Donation, was completed successfully. Coaching included verification using phonetics for sound alike letters; she was provided with a table of letters needing phonetic verification. Her Supervisor Transfer 1 was completed successfully. Coaching consisted solely of screenshots and chat in Discord.

EXAMPLE 3 (Sup Transfer Only):
Barbara Howard passed the supervisor transfer. The first call was failed due to placing caller on hold. She was coached with standard instructions and screenshots in Discord chat as well as to minimize dead air and maintain communication with the caller."""

FAIL_EXAMPLES = """EXAMPLE 1:
Candidate was NC/NS. Session did not occur.

EXAMPLE 2:
Jessica was using a headset with a 3.5 mm connection. Her headset was not USB.

EXAMPLE 3:
Barbara failed 2 of 3 mock calls. The first call for a New Donor - One-time donation was failed due to paraphrasing the script on the review screen. The second call was for an Existing Donor calling to start a new monthly sustaining donation. This call was failed because Barbara did not add the correct gift and did not ask for assistance in chat. She also clicked override on the error that no gift was selected. Because 2 of 3 calls were failed we did not move on to the Supervisor Transfer Call.

EXAMPLE 4:
Mark stopped responding in Discord during his second call. I reached out to him and there was no response.

EXAMPLE 5:
Jane is using a VPN and she cannot turn it off.

EXAMPLE 6 (Sup Transfer Only):
John failed his newbie session (supervisor transfer calls). He failed the first supervisor for transferring the call without asking for permission in chat. The second call was failed because the caller was placed on hold while he asked for permission in chat."""


def _strip_preamble(text: str) -> str:
    """Remove common AI preambles like 'Here is...' or 'Sure,...'."""
    for prefix in ["Here is", "Here's", "Sure,", "Certainly,", "Of course,"]:
        if text.lower().startswith(prefix.lower()):
            text = text.split("\n", 1)[-1].strip()
    return text


def generate_with_gemini(api_key: str, session: dict, summary_type: str) -> str:
    """
    Call Gemini API to generate a professional summary.
    summary_type: 'coaching' or 'fail'
    Returns the generated text, or raises on error.
    """
    import google.generativeai as genai

    genai.configure(api_key=api_key)
    model = genai.GenerativeModel("gemini-2.5-flash")

    if summary_type == "coaching":
        clean = build_clean_coaching(session)
        prompt = (
            "Write a concise, professional Coaching Summary for this mock session. "
            "Use the following examples EXACTLY to shape your output style and structure. "
            "Do NOT include any preamble like 'Here is...' — start directly with the summary.\n\n"
            f"{COACHING_EXAMPLES}\n\n"
            f"SESSION DATA TO SUMMARIZE:\n{clean}"
        )
    else:
        clean = build_clean_fail(session)
        prompt = (
            "Write a concise, professional Fail Reason Summary for this mock session. "
            "Do NOT include any preamble like 'Here is...' — start directly with the summary.\n\n"
            f"{FAIL_EXAMPLES}\n\n"
            f"SESSION DATA TO SUMMARIZE:\n{clean}"
        )

    response = model.generate_content(prompt)
    return _strip_preamble(response.text.strip())


def generate_summaries(session: dict, api_key: str = "") -> dict:
    """
    Generate both summaries. Uses Gemini if api_key is provided, else clean fallback.
    Returns {"coaching": "...", "fail": "..."}.
    """
    # Determine if fail summary should be N/A
    sup_only = session.get("supervisor_only", False)
    auto_fail = session.get("auto_fail_reason")

    calls_passed = sum(
        1 for i in range(1, 4)
        if (session.get(f"call_{i}") or {}).get("result") == "Pass"
    )
    sups_passed = sum(
        1 for i in range(1, 3)
        if (session.get(f"sup_transfer_{i}") or {}).get("result") == "Pass"
    )
    newbie = session.get("newbie_shift_data")

    fail_is_na = False
    if not auto_fail:
        if sup_only and sups_passed >= 1:
            fail_is_na = True
        elif not sup_only and calls_passed >= 2 and (sups_passed >= 1 or newbie):
            fail_is_na = True

    # Generate coaching (always)
    if api_key:
        try:
            coaching = generate_with_gemini(api_key, session, "coaching")
        except Exception as e:
            coaching = build_clean_coaching(session) + f"\n\n[Gemini error: {e}]"
    else:
        coaching = build_clean_coaching(session)

    # Generate fail
    if fail_is_na:
        fail = "N/A"
    elif api_key:
        try:
            fail = generate_with_gemini(api_key, session, "fail")
        except Exception as e:
            fail = build_clean_fail(session) + f"\n\n[Gemini error: {e}]"
    else:
        fail = build_clean_fail(session)

    return {"coaching": coaching, "fail": fail}
