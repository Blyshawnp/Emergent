import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
BACKEND_DIR = ROOT / "backend"
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from server import (  # noqa: E402
    build_form_fill_payload,
    empty_session,
    generate_summaries,
    normalize_settings_payload,
    sanitize_settings,
)


def _settings():
    return {"tester_name": "Tester"}


def _session(**overrides):
    session = empty_session()
    session.update(
        {
            "candidate_name": "Taylor Example",
            "tester_name": "Tester",
        }
    )
    session.update(overrides)
    return session


def test_gemini_api_key_is_canonicalized_and_masked_on_settings_read():
    update = normalize_settings_payload({"gemini_key": "legacy-real-key", "tester_name": "Tester"})

    assert update["$set"]["gemini_api_key"] == "legacy-real-key"
    assert "gemini_key" not in update["$set"]

    settings = sanitize_settings({"gemini_api_key": "stored-real-key"})

    assert settings["gemini_api_key"] == ""
    assert settings["gemini_api_key_configured"] is True


def test_masked_or_blank_gemini_api_key_save_does_not_overwrite_stored_key():
    blank_update = normalize_settings_payload({"gemini_api_key": ""})
    masked_update = normalize_settings_payload({"gemini_api_key": "********"})

    assert "gemini_api_key" not in blank_update["$set"]
    assert "gemini_api_key" not in masked_update["$set"]


def test_regular_ncns_auto_fail_payload_and_summaries():
    session = _session(auto_fail_reason="NC/NS", final_status="Fail")

    summaries = generate_summaries(session)
    payload = build_form_fill_payload(session, _settings(), summaries["coaching"], summaries["fail"])

    assert payload["mock_complete"] == "No"
    assert payload["sup_complete"] == "No"
    assert payload["all_complete"] == "No"
    assert payload["coaching"] == "N/A"
    assert payload["fail_reason"] == "Taylor Example was a NC/NS."


def test_regular_not_ready_auto_fail_payload_and_summaries():
    session = _session(auto_fail_reason="Not Ready for Session", final_status="Fail")

    summaries = generate_summaries(session)
    payload = build_form_fill_payload(session, _settings(), summaries["coaching"], summaries["fail"])

    assert payload["mock_complete"] == "No"
    assert payload["sup_complete"] == "No"
    assert payload["all_complete"] == "No"
    assert payload["coaching"] == "N/A"
    assert payload["fail_reason"] == "Taylor Example was not ready or prepared for the session."


def test_headset_auto_fail_payload_and_summaries():
    session = _session(auto_fail_reason="Wrong headset (not USB) and Wrong headset (not noise cancelling)", final_status="Fail")

    summaries = generate_summaries(session)
    payload = build_form_fill_payload(session, _settings(), summaries["coaching"], summaries["fail"])

    assert payload["mock_complete"] == "No"
    assert payload["sup_complete"] == "No"
    assert payload["all_complete"] == "No"
    assert payload["coaching"] == "Taylor Example was informed that a USB headset with a noise-cancelling microphone is required to contract with ACD."
    assert payload["fail_reason"] == "Taylor Example was not using an approved USB headset with a noise-cancelling microphone."


def test_vpn_auto_fail_payload_and_summaries():
    session = _session(auto_fail_reason="Unable to turn off VPN", final_status="Fail")

    summaries = generate_summaries(session)
    payload = build_form_fill_payload(session, _settings(), summaries["coaching"], summaries["fail"])

    assert payload["mock_complete"] == "No"
    assert payload["sup_complete"] == "No"
    assert payload["all_complete"] == "No"
    assert payload["coaching"] == "Taylor Example was informed that the use of a VPN is not acceptable when contracting with ACD."
    assert payload["fail_reason"] == "Taylor Example was using a VPN and was unable to turn it off."


def test_supervisor_only_ncns_auto_fail_payload_and_summaries():
    session = _session(supervisor_only=True, auto_fail_reason="NC/NS", final_status="Fail")

    summaries = generate_summaries(session)
    payload = build_form_fill_payload(session, _settings(), summaries["coaching"], summaries["fail"])

    assert payload["mock_complete"] == "Yes"
    assert payload["sup_complete"] == "No"
    assert payload["all_complete"] == "No"
    assert payload["coaching"] == "N/A"
    assert payload["fail_reason"] == "Taylor Example was a NC/NS."


def test_supervisor_only_not_ready_auto_fail_payload_and_summaries():
    session = _session(supervisor_only=True, auto_fail_reason="Not Ready for Session", final_status="Fail")

    summaries = generate_summaries(session)
    payload = build_form_fill_payload(session, _settings(), summaries["coaching"], summaries["fail"])

    assert payload["mock_complete"] == "Yes"
    assert payload["sup_complete"] == "No"
    assert payload["all_complete"] == "No"
    assert payload["coaching"] == "N/A"
    assert payload["fail_reason"] == "Taylor Example was not ready or prepared for the session."


def test_stopped_responding_uses_prior_coaching_when_available():
    session = _session(
        auto_fail_reason="Stopped Responding in Chat",
        final_status="Fail",
        call_1={
            "result": "Pass",
            "coaching": {"Show appreciation": True},
            "coach_notes": "",
        },
    )

    summaries = generate_summaries(session)
    payload = build_form_fill_payload(session, _settings(), summaries["coaching"], summaries["fail"])

    assert "Call 1 - PASS" in payload["coaching"]
    assert "Show appreciation" in payload["coaching"]
    assert payload["fail_reason"] == "Taylor Example stopped responding."


def test_stopped_responding_uses_na_when_no_prior_coaching():
    session = _session(auto_fail_reason="Stopped Responding in Chat", final_status="Fail")

    summaries = generate_summaries(session)
    payload = build_form_fill_payload(session, _settings(), summaries["coaching"], summaries["fail"])

    assert payload["coaching"] == "N/A"
    assert payload["fail_reason"] == "Taylor Example stopped responding."


def test_coaching_summary_uses_selected_items_and_other_notes_only():
    session = _session(
        call_1={
            "result": "Pass",
            "type": "New Donor",
            "coaching": {
                "Show appreciation": True,
                "Verification": True,
                "Verification_Email": True,
                "Other": True,
            },
            "coach_notes": "Reviewed donation confirmation wording.",
        },
        call_2={
            "result": "Pass",
            "type": "Existing Member",
            "coaching": {"Read script verbatim": True},
            "coach_notes": "This unselected note should not appear.",
        },
        sup_transfer_1={
            "result": "Pass",
            "coaching": {"Screenshots/Discord Chat": True},
            "coach_notes": "",
        },
    )

    summaries = generate_summaries(session)

    assert "Show appreciation" in summaries["coaching"]
    assert "Verification (Email)" in summaries["coaching"]
    assert "Reviewed donation confirmation wording" in summaries["coaching"]
    assert "Read script verbatim" in summaries["coaching"]
    assert "This unselected note should not appear" not in summaries["coaching"]
    assert "Provided coaching using the standard screenshots and instructions in Discord chat." in summaries["coaching"]
    assert "Logitech" not in summaries["coaching"]
    assert summaries["fail"] == "N/A"


def test_fail_summary_uses_failed_mock_calls_only():
    session = _session(
        call_1={
            "result": "Fail",
            "type": "New Donor",
            "fails": {"Skipped parts of script": True, "Other": True},
            "fail_notes": "Missed required closing language.",
        },
        call_2={
            "result": "Fail",
            "type": "Existing Member",
            "fails": {"Wrong donation": True},
            "fail_notes": "This unselected fail note should not appear.",
        },
        sup_transfer_1={
            "result": "Fail",
            "coaching": {"Discord permission": True},
            "fails": {"Transferred to wrong queue": True},
            "fail_notes": "Supervisor transfer fail note.",
        },
        final_status="Fail",
    )

    summaries = generate_summaries(session)

    assert "Call 1 - FAIL" in summaries["fail"]
    assert "Skipped parts of script" in summaries["fail"]
    assert "Missed required closing language" in summaries["fail"]
    assert "Call 2 - FAIL" in summaries["fail"]
    assert "Wrong donation" in summaries["fail"]
    assert "This unselected fail note should not appear" not in summaries["fail"]
    assert "Supervisor Transfer" not in summaries["fail"]
    assert "Transferred to wrong queue" not in summaries["fail"]


def test_supervisor_transfer_fail_after_mock_pass_has_na_fail_summary():
    session = _session(
        call_1={"result": "Pass", "coaching": {"Show appreciation": True}},
        call_2={"result": "Pass", "coaching": {"Verification": True}},
        sup_transfer_1={
            "result": "Fail",
            "coaching": {"Discord permission": True},
            "fails": {"Transferred to wrong queue": True},
            "fail_notes": "Queue was not changed.",
        },
        newbie_shift_data={"newbie_date": "2026-05-07", "newbie_time": "9:00 AM", "newbie_tz": "ET"},
        final_status="Incomplete",
    )

    summaries = generate_summaries(session)

    assert summaries["fail"] == "N/A"
    assert "Supervisor Transfer 1 - FAIL" in summaries["coaching"]
    assert "Discord permission" in summaries["coaching"]
    assert "Transferred to wrong queue" not in summaries["fail"]


def test_headset_like_selection_data_is_rejected_from_summaries():
    session = _session(
        call_1={
            "result": "Pass",
            "coaching": {"Logitech H390": True, "Jabra Evolve": True},
            "coach_notes": "",
        },
        call_2={
            "result": "Fail",
            "fails": {"Plantronics Blackwire": True, "Poly EncorePro": True},
            "fail_notes": "",
        },
        call_3={
            "result": "Fail",
            "fails": {"Skipped parts of script": True},
            "fail_notes": "",
        },
        final_status="Fail",
    )

    summaries = generate_summaries(session)

    assert "Logitech" not in summaries["coaching"]
    assert "Jabra" not in summaries["coaching"]
    assert "Plantronics" not in summaries["fail"]
    assert "Poly" not in summaries["fail"]
    assert "Skipped parts of script" in summaries["fail"]
