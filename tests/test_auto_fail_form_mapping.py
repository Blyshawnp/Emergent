import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
BACKEND_DIR = ROOT / "backend"
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from server import build_form_fill_payload, empty_session, generate_summaries  # noqa: E402


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
