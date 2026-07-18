# MTS/SAM v1.0.1 Release Checklist

Last audited: 2026-07-16
Branch: `feature/newbie-shift-request-workflows`
Current conclusion: **NOT READY — BLOCKERS REMAIN**

This checklist separates automated/static evidence from live acceptance evidence. Use only these result values: `PASS`, `FIXED`, `REQUIRES MANUAL VERIFICATION`, or `BLOCKER`.

## Automated and static evidence

| Gate | Result | Evidence |
|---|---|---|
| Frontend tests | PASS | `npm test -- --watchAll=false`: 23 suites and 178 tests passed. |
| Frontend production build | PASS | `npm run build` compiled successfully. |
| Backend compile | PASS | `.venv\Scripts\python.exe -m py_compile backend\server.py`. |
| Backend release workflows | PASS | Full discovery passed: 124 tests, including direct-Sheets compatibility, candidate/pending reconciliation, headset transport, security packaging, and exact Discord-source synchronization. |
| Pending request reconciliation | PASS | 14 tests passed. |
| Candidate IP decision support | PASS | 17 tests passed. |
| Tutorial content contract | PASS | Header, category, URL, active/fallback, and uniqueness tests passed. |
| Headset review transport | PASS | 6 tests passed, covering Apps Script creation, direct-Sheets creation, stable review IDs, sanitized failure, Apps Script decision, and direct-Sheets decision by `review_id`. |
| Shared candidate archive | PASS | 3 tests passed. |
| Release blocker regression suite | PASS | 11 tests passed, including package-manifest/build-script credential exclusion. |
| Coaching defaults | PASS | 2 tests passed. |
| Apps Script adapter contract | PASS | 21 adapter/config tests plus 11 executable Apps Script authorization/compatibility tests passed. MTS admin calls are forbidden, SAM admin calls are authorized, optional reads are safe, legacy headset decisions work, and errors do not expose credentials or deployment details. |
| Desktop process ownership | PASS | Main/SAM entry syntax checks and ownership classification tests passed. Owner metadata is mode-specific, and a healthy listener tied to a stale same-app heartbeat is stopped by exact PID instead of being reused indefinitely. |
| Package config fail-closed hook | FIXED | MTS and SAM packaging now stop before creating an incomplete installer when the corresponding ignored role config is missing, malformed, placeholder-filled, disabled, or wrong-role. |
| Apps Script static validation | PASS | `node --check` passed against a temporary `.js` copy of `docs/apps-script-api-web-app.gs`; the temporary file was removed. |
| SAM package build | BLOCKER | Packaging correctly stopped because the ignored `apps-script-api-sam.json` release input has not been provisioned. No credential was invented, copied, or rotated during this stabilization pass. |
| MTS package build | BLOCKER | Packaging correctly stopped because the ignored `apps-script-api-mts.json` release input has not been provisioned. A pre-hook now prevents the prior silent omission behavior. |
| Service-account package exclusion | FIXED | Both package manifests and production-ready sync scripts exclude the credential; rebuilt unpacked paths are absent and both installer filename inventories returned zero hits. Credential contents were not inspected. |
| Apps Script log redaction | FIXED | Config diagnostics now log only `script.google.com`; the deployment path and token are absent, with a focused regression test. |
| Role/action-scoped Apps Script authorization | FIXED | Repository source uses distinct MTS/SAM current and previous credentials. MTS retains ordinary reads and workflow synchronization but cannot perform SAM decisions, notification administration, generic sheet writes, or candidate-admin operations. |

Generated build output is validation evidence only. Do not stage `frontend/build/`, `backend/dist/`, `desktop/dist/`, `desktop/dist-notification-manager/`, installers, blockmaps, or packaged application files.

## Audit status matrix

| Area | Result | Evidence or remaining proof |
|---|---|---|
| Database/backward compatibility | PASS | JSON document storage preserves unknown legacy fields; release-blocker tests prove a locked database is not deleted; local History encode/decode and reconciliation tests pass. |
| Candidate Lookup/eligibility | PASS | Frontend lookup/typed-name/final-attempt tests and backend shared-candidate visibility/archive tests pass. Live shared-data recovery remains covered below as acceptance evidence. |
| Calls/fail reasons/technical issues | PASS | Calls and Tech Issue suites pass; `Other` is last and `Did not search for member` is merged/deduplicated. |
| Supervisor Transfers/Smart Resume/Sup-only NCNS | PASS | Sup Transfer, Home, Review, and backend payload tests pass. |
| Newbie Shift/rescheduling/24-hour rules | PASS | Boundary tests prove candidate-requested `<24 hours` counts as an attempt, exactly `24 hours` does not, and tester-requested changes do not penalize. |
| Form Fill/History/partial success/status persistence | REQUIRES MANUAL VERIFICATION | Review/History and backend tests cover filled, failed, skipped, partial metadata failure, recovery marker, and refill confirmation; the safe live Form dry run remains outstanding. |
| Pending Requests/Apps Script/backend/reconciliation/reminders | REQUIRES MANUAL VERIFICATION | Contract, idempotency, denial-reason, action-required deletion, shared snapshot coordinator, workflow 30-minute reminders, headset 2-hour grouped reminders, and reconciliation tests pass; deployed Apps Script round trip is not proven in this audit. |
| Discord/Help/tutorial framework | FIXED | All 28 active Discord rows are synchronized across packaged JSON/CSV, admin CSV/XML, and source-map docs. Live managed rows and video playback still require acceptance. |
| SAM dashboard/notifications/Candidate Tracking/headsets/updates | REQUIRES MANUAL VERIFICATION | Automated SAM release-polish, coordinator, headset display/decision, and reminder tests pass; installed rendering, live data, and updater behavior require hands-on evidence. |
| Apps Script/Google Sheets tabs/headers/source priority/redeployment | REQUIRES MANUAL VERIFICATION | Local adapter/header/source-priority tests pass; deployed version and live tab placement are external state. |
| Process lifecycle and ports | REQUIRES MANUAL VERIFICATION | The stale-owner trust gap and cross-product owner-file collision are fixed locally with mode-specific metadata, heartbeat/PID classification, and exact-PID restart. Packaged apps refuse a healthy but unmanaged fixed-port listener; development can still reuse an intentionally direct-started backend. Simultaneous installed lifecycle testing remains outstanding. |
| Accessibility/responsiveness at 100/125/150/200% | REQUIRES MANUAL VERIFICATION | Responsive CSS, History/Home chip regression tests, and layout structure tests pass; Browser runtime failed in this session with `missing field sandboxPolicy`, so no current hands-on four-scale packaged evidence was produced. |
| Security/cleanliness/no secrets/no arbitrary iframe | BLOCKER | Service-account packaging, deployment-path logging, and repository role/action authorization are fixed. Release remains blocked on controlled MTS/SAM role-config provisioning, live deployment update, credential rotation/revocation where required, and approved artifact/content scanning. |
| Docs/training completeness | PASS | MTS/SAM guides, master guide, map, standards, screenshot plan, two video plans, and all 11 scripts exist; recording status remains `Script ready`. |

## Final content synchronization

Local fallback/admin package rows are synchronized for these stable titles:

- `Sup Instructions #1`: first line is `We are now going to proceed with the instructions for the Supervisor transfer.`
- `Sup Request Instructions`: message is exactly:

  ```text
  When you need to transfer, you will….

  1) Ask in chat first before transferring - include the station, caller's name, and issue ex.: WXYZ, sup request, member's name, and member issue

  2) Give the CCM time to check to see if a Supervisor is available

  We never put our caller on hold so try to minimize dead air.

  3) When the CCM says ok to transfer...

  — Let your caller know you are transferring
  ```
- `Disposition`: message is the approved Script/Call Corp DTE procedure.
- `Passed All`: message includes the canonical mailbox and approved image link.

The application keeps valid remote/admin rows ahead of packaged fallbacks. Runtime normalization changes only the obsolete certification mailbox and does not rewrite unrelated `@acddirect.com` addresses.

### Manual live Discord-row update

No authenticated, write-safe content editor was available during this audit. An authorized content owner must:

1. Open the managed `discord-posts` tab without sharing its address or identifier.
2. Locate each title above. Update its existing `Message` cell in place; do not append a duplicate row.
3. Preserve its approved Category and screenshot field.
4. If an exact-title duplicate already exists, retain one reviewed row and remove/deactivate the duplicate according to department retention practice.
5. Refresh MTS and verify the content source reports Google/admin content.
6. Search Discord Posts by each exact title, copy the message, and compare it character-for-character with `backend/defaults/discord-posts.csv`.
7. Confirm the old certification mailbox is absent from the managed Help/FAQ/Discord/tutorial text.

## Manual acceptance matrix

For every row, record tester, date, app/package version, environment, synthetic record IDs, screenshots or logs, and the final result. Never place candidate data, credentials, private content locations, or deployment addresses in this document.

| ID | Acceptance flow | Exact actions and expected evidence | Result |
|---|---|---|---|
| MA-01 | Live Apps Script redeployment | Through the authorized owner account, update the existing stable deployment to the reviewed role/action-scoped repository source. Configure separate current MTS and SAM Script Properties, using the matching `_PREVIOUS` properties only for a bounded rotation window. Restart MTS/SAM and verify MTS receives `Forbidden` for SAM-only actions while authorized reads, synchronization, and SAM decisions succeed. | BLOCKER |
| MA-02 | MTS -> SAM -> MTS approve | In MTS create a synthetic Newbie Shift request; confirm Pending in History; in SAM confirm bell/category count, View details, and Approve; refresh MTS; expect Approved in Home/History/Smart Resume with one decision timestamp and no duplicate row. | REQUIRES MANUAL VERIFICATION |
| MA-03 | MTS -> SAM -> MTS deny | Create a second synthetic request; deny in SAM with a readable reason; refresh MTS; expect Denied and the same reason; confirm the request no longer contributes to pending counts. | REQUIRES MANUAL VERIFICATION |
| MA-04 | Deletion request limitation | Submit a synthetic candidate-list deletion request; approve in SAM; expect `deletion_action_required` behavior and no automatic shared-history deletion. Perform no destructive follow-up during smoke testing. | REQUIRES MANUAL VERIFICATION |
| MA-05 | Tutorial Sheet row placement | For each approved Unlisted video, update the existing stable VideoKey row under the exact 11-column header; set exact Category, HelpTopicKey, SortOrder, Active, Audience, and URL; confirm no duplicate VideoKey and verify Help article placement plus Other Tutorials fallback for an invalid category test row. | REQUIRES MANUAL VERIFICATION |
| MA-06 | Form dry-run matrix | Use a non-production Form/test account and synthetic sessions. Exercise every row in the payload matrix below. Confirm fields fill but the app never submits automatically. Close without submitting unless the test owner explicitly authorizes the test Form submission. | REQUIRES MANUAL VERIFICATION |
| MA-07 | Calendar | From Newbie Shift, open Add to Google Calendar; expect title `Supervisor Test Call - [Synthetic Candidate]`, correct date/time/timezone, and no automatic event save. Cancel the draft. | REQUIRES MANUAL VERIFICATION |
| MA-08 | Clipboard | Copy Out of Time from only the Supervisor Transfer Time Check popup; copy a reschedule Discord post and a standard Discord template; verify exact clipboard text, temporary edits, and no default-template mutation. | REQUIRES MANUAL VERIFICATION |
| MA-09 | YouTube embed/browser fallback | Use an approved active YouTube row; verify embedded playback. Block/embed-fail once and confirm Retry and Open in Browser use the same validated YouTube ID. Verify a non-YouTube URL is rejected and never placed in an iframe. | REQUIRES MANUAL VERIFICATION |
| MA-10 | High DPI | At Windows 100%, 125%, 150%, and 200%, inspect MTS Basics, Calls, Sup Transfer time check, Newbie reschedule, Review, History, Help videos, SAM Pending Requests, Candidate Tracking, and confirmation dialogs. Expect no clipped actions or required horizontal scroll and visible keyboard focus. | REQUIRES MANUAL VERIFICATION |
| MA-11 | Process lifecycle | Launch installed MTS and SAM together; confirm listeners on 8600/8601 belong to separate app-owned backends. Close MTS and verify 8600 releases while SAM/8601 remains healthy; repeat inversely; repeat two restart cycles and confirm no stale owned PID/lock metadata or orphaned helpers. | REQUIRES MANUAL VERIFICATION |
| MA-12 | Installer smoke | Install both 1.0.1 packages on a clean supported Windows profile; confirm version, first-run setup, launch, navigation, bundled backend, restart persistence, uninstall entry, and no unexpected source/config exposure. | REQUIRES MANUAL VERIFICATION |
| MA-13 | Live source priority | With valid managed rows, confirm Google/admin content replaces packaged content. Make the remote test source unavailable and confirm packaged fallback appears without duplicates; restore it and confirm recovery on a later refresh. | REQUIRES MANUAL VERIFICATION |
| MA-14 | SAM updater | In installed SAM, run Search for updates and verify app-specific metadata, safe manual/unsigned messaging, and no MTS package crossover. Do not publish or install an unapproved release. | REQUIRES MANUAL VERIFICATION |
| MA-15 | Unknown headset creation and decision | After redeploying the current Apps Script, use a unique fake unapproved headset in MTS, continue beyond Basics, confirm exactly one `headset-review-log` row with stable review ID/session/candidate/tester/brand/model/status/timestamps, restart MTS with no duplicate, approve in SAM, confirm count decrement and MTS recognition, then repeat with denial. | BLOCKER |
| MA-16 | SAM request-volume soak | Leave installed SAM dashboard open for 5 minutes after backend readiness. Confirm one shared initial snapshot, no overlapping Google-backed request loops, normal 60-second refresh cadence or bounded backoff, and no quota warning. Use only sanitized network/log counts. | REQUIRES MANUAL VERIFICATION |
| MA-17 | Newbie Shift temporary Discord post | In installed MTS, verify initial scheduling and reschedule both show Temporary Discord Post by default, contain no automatic tags, preserve edits while hidden, copy exact edited text, and Reset restores generated text. | REQUIRES MANUAL VERIFICATION |

## Form payload matrix

The automated tests validate payload construction. MA-06 must prove browser/Form mapping without production submission.

| Scenario | Expected result | Mock Complete | Sup Complete | All Complete | Auto Fail | Fail Reason |
|---|---|---:|---:|---:|---|---|
| Calls and Sup Transfer pass | Pass | Yes | Yes | Yes | N/A | N/A |
| Certification call failure | Fail | No | No unless separately completed | No | mapped reason or N/A | actual fail summary |
| Final-attempt failure | FAIL - Final Attempt | No | No unless separately completed | No | mapped reason or N/A | actual fail summary with final-attempt context |
| NC/NS | NC/NS | No for normal session | No | No | NC/NS | NC/NS summary |
| Same Day Drop | NC/NS form mapping | No | No | No | NC/NS | distinct same-day-drop wording |
| Mock calls pass; no time for Sup | Incomplete | Yes | No | No | N/A | N/A |
| Non-final double Sup failure | Incomplete | Yes | No | No | N/A | N/A; detail remains in coaching/incomplete context |
| Final double Sup failure | FAIL - Final Attempt | Yes | No | No | N/A | Supervisor Transfer failure summary |
| Supervisor Transfer Only incomplete | Incomplete | Yes | No | No | N/A | N/A |
| Supervisor Transfer Only NC/NS | NC/NS | Yes | No | No | NC/NS | Sup-only NC/NS summary |
| Session-ending technical issue | Incomplete | based on saved calls | No unless complete | No | N/A | N/A; technical issue maps to its own Form field |
| Candidate reschedule under 24 hours | NC/NS | based on completed work | based on completed work | No | NC/NS | attempt-impact wording |
| Candidate reschedule at/over 24 hours | Incomplete | based on completed work | based on completed work | No | N/A | N/A |
| Tester-requested reschedule | Incomplete | based on completed work | based on completed work | No | N/A | N/A |

## Release decision gate

### Open release blockers

- The controlled live Apps Script deployment is older than repository source and does not yet expose required pending-request/tutorial routes or the reviewed role/action authorization boundary.
- Controlled build-local MTS and SAM role configs are intentionally absent. Packaging now fails closed until an authorized release owner provisions separate credentials without committing or printing them.
- Unknown headset creation and SAM approve/deny are locally implemented for direct Sheets and Apps Script source, but the controlled live Apps Script deployment and live `headset-review-log` row round trip are not verified. This remains a release blocker until MA-15 passes.
- Service-account packaging is removed locally and current unpacked/installer filename inventories are clean. An authorized owner must still rotate/revoke any previously distributed credential and run an approved content scan across installers, updater artifacts, and retained release folders without exposing secret values.

Advance to **READY FOR FINAL COMMIT REVIEW** only when:

- every applicable MA row has evidence and no `BLOCKER`;
- live managed Discord content is synchronized without duplicates;
- live approval and denial round trips reconcile in MTS;
- the safe Form dry-run matrix is complete;
- four-scale UI, process lifecycle, and installer smoke tests pass;
- generated artifacts and sensitive files remain unstaged;
- final diff and Git status are reviewed by the release owner.
