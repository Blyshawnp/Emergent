# GUI QA Findings

No GUI defects discovered during testing.

## Summary of Tested Areas

### Mock Testing Suite (MTS)
All tested workflows are fully functional, stable, and correctly synchronized with state.

* **First launch wizard & setup**: Successfully prompts for tester settings, welcome voice, sounds, and saves correctly on first run.
* **Tutorial & Tutorial replay**: Guided tour steps and skip/complete flows render properly.
* **Settings & Help**: Identity, defaults, payment configuration, Gemini toggle, and troubleshooting/replay quick actions persist correctly. Help search returns expected content.
* **Discord Posts & Screenshots**: Discord category tabs, category filtering, search, and screenshot preview/copy options render without overlap or text clipping.
* **Candidate search & Headset search**: Dynamic lookup/filter for candidate and headset databases behaves as expected.
* **Scoring & Routing**: Validated full 3-call pass paths, 2-fail paths, and newbie shift routing when no time remains for supervisor transfers.
* **Auto-fails**: Checked wrong headset auto-fails (USB / noise cancelling) and VPN auto-fails, prompting correct Discord template copies and failing the session database record.
* **Technical Issues (TechIssueDialog)**: Validated Calls Would Not Route, No Script Pop, Internet Speed Issues (with speedtest link), and Discord troubleshooting checklist. Verified that the "Other" category requires notes before allowing resolution.
* **Final Readiness Override**: Evaluator overrides for calculated results apply correctly to review and final database states.
* **Gemini summaries**: Handled loading of custom prompt defaults and generation of coaching/fail summaries via Gemini with robust fallback to CSV defaults when disabled.
* **Finish & Fill Form**: Maps final session fields and sends expected payload parameters for both passed, failed, and newbie certifications.
* **Sounds, Discards, and History**: Audio signals play on correct events, discards clean session draft files, and history provides read-only tracking of completed certifications.

### Smart Alert Manager (SAM)
All manager alerts, updates, logs, and candidate tracking workflows perform correctly.

* **Dashboard & Statuses**: Display correct active sheet source, user permissions, and connection states.
* **Candidate Tracking & Search**: Checked tracking tabs (pending, incomplete, failed, withdrawn, passed, archived, all) and row actions. Include archived checkbox displays archived history with appropriate badge.
* **Auto-Archive**: Verifies that closed records older than 60 days are correctly filtered.
* **Notifications (Alerts)**: Creating, editing, saving, and previewing (ticker, banner, popup alerts) function normally.
* **Headset Review Workflow**: Review panel successfully partitions pending, approved, and denied tabs. Lookups open search engines, approval/denials write to the master sheet log, and "Other" denials require note entry. Re-decision (changing approved to denied, and vice versa) is fully stable.
* **Support & Settings**: Pin codes, backup exports, CSV imports, update check, and alert sound volume controls are fully functional.
* **Single Instance Protection**: Ensures only a single instance of SAM can run at one time, safely reusing the assigned localhost port.
