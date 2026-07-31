# MTS/SAM Training Package

This directory is the production source for user guides, department training, tutorial-video planning, recording scripts, and screenshot callouts for Mock Testing Suite (MTS) and Smart Alert Manager (SAM).

## Audience

- Trainers and testers use the [MTS User Guide](MTS-USER-GUIDE.md).
- SAM administrators use the [SAM User Guide](SAM-USER-GUIDE.md).
- Certification leadership and cross-trained staff use the [Certification Department Master Guide](CERTIFICATION-DEPARTMENT-MASTER-GUIDE.md).
- Writers, presenters, editors, and release owners use the content map, video plans, scripts, standards, and screenshot plan.

## Package index

- [MTS User Guide](MTS-USER-GUIDE.md)
- [SAM User Guide](SAM-USER-GUIDE.md)
- [Certification Department Master Guide](CERTIFICATION-DEPARTMENT-MASTER-GUIDE.md)
- [Training Content Map](TRAINING-CONTENT-MAP.md)
- [Video Recording Standards](VIDEO-RECORDING-STANDARDS.md)
- [Screenshot and Callout Plan](SCREENSHOT-AND-CALLOUT-PLAN.md)
- [MTS Video Plan](video-plans/MTS-VIDEO-PLAN.md)
- [SAM Video Plan](video-plans/SAM-VIDEO-PLAN.md)
- [Video scripts](video-scripts/)

## Source-of-truth rules

1. Repository source and validated runtime behavior are final for labels and workflow.
2. `PROJECT_CONTEXT.md` is the current release handoff and workflow summary.
3. Department policy must not be inferred from a button or status. Unverified policy is marked **Department confirmation required.**
4. Use only synthetic demo names and data. Never record candidate data, private company data, secrets, private content locations, or private deployment information.
5. `Form Filled` means MTS completed filling the Microsoft Form. It does not mean the trainer selected Submit.
6. VPN/proxy lookup is manual-only: copy one of the three Basics website links, open it separately, and enter the candidate IP there. The sites are reference tools; MTS does not fill answers or decide pass/fail.

## Publishing workflow

1. Confirm the matching `VideoKey`, approved `Category`, and `HelpTopicKey` in the content map.
2. Recheck visible labels in the current release candidate before recording.
3. Prepare synthetic demo records and disable unrelated notifications.
4. Record and edit under the standards in this package.
5. Complete caption and privacy review.
6. Upload as Unlisted with embedding enabled.
7. Replace the URL placeholder in the managed tutorial-video row, keep its key stable, and activate it only after approval.
8. Verify the video under Help > Tutorial Videos and beside its matching Help article.

## Release-control note

The P0 minimum launch set is identified in `TRAINING-CONTENT-MAP.md`. A script being complete does not mean its video has been recorded, approved, uploaded, or activated.
# Data-provider note for developers

The Supabase foundation is not a production cutover. Current MTS/SAM training continues to describe Google Sheets and Apps Script behavior. Developer-only migration, reconciliation, shadow-read, backup, and rollback guidance is maintained in `docs/supabase-mts-sam-data-foundation.md`; user-facing tutorial scripts must not claim Supabase authority until a separately approved cutover.
