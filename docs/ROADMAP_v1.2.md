# MTS/SAM v1.2 Roadmap

This file holds deferred ideas only. It does not change v1.0.1 policy, acceptance criteria, or application behavior. Items need product/department confirmation before implementation.

## Release boundary

- v1.0.1 remains feature-frozen for targeted blocker, regression, content, and documentation fixes.
- A deferred idea must not be used to hide a current release blocker.
- Security, privacy, data-retention, and department-policy decisions require an owner before design work begins.

## Candidate themes

### Secure integration architecture

- Complete the move to admin-provided OAuth or a least-privilege backend proxy; do not reintroduce packaged service-account credentials.
- Add deployment-contract health reporting that proves the active Apps Script version without exposing its address, token, or private Sheet identifiers.
- Add structured audit receipts for shared admin decisions with an approved retention model.

### Managed content operations

- Provide an authenticated content editor or import validator for Discord, Help/FAQ, tutorial, grading, and screenshot rows.
- Add preview/diff/duplicate detection before publishing remote content.
- Add versioned content rollback without changing stable VideoKeys or HelpTopicKeys.

### Training lifecycle

- Add recording, caption-review, approval, upload, activation, and replacement state to the tutorial production workflow.
- Add automated broken-link/embed checks for active Unlisted videos.
- Add release-version visibility and stale-video review reminders.

### Workflow observability

- Add privacy-safe reconciliation health summaries for Pending Requests and shared candidate status.
- Add operator-visible retry state without exposing backend routes or provider internals.
- Add exportable acceptance-test receipts that contain synthetic identifiers only.

### Accessibility and UI verification

- Establish a repeatable 100/125/150/200% screenshot-diff suite for critical MTS/SAM pages.
- Expand keyboard, focus-order, reduced-motion, and screen-reader testing.
- Evaluate automated contrast checks alongside hands-on review.

### Form workflow resilience

- Add a metadata-only recovery action for partial Form Fill success that can never relaunch Form automation accidentally.
- Add an approved test-Form harness for the full payload matrix.
- Add clearer reconciliation history for local/shared Form Filled metadata.

## Department confirmation required

- Attempt limits, override authority, and final-attempt exception policy.
- Approval/denial roles, response targets, and appeal handling.
- Candidate deletion authorization, retention, and legal-hold rules.
- Form submission ownership and second-person review requirements.
- Headset research standards and decision authority.
- Training-video approval, replacement, and retention ownership.
