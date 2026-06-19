# Google Forms Feedback and Support Plan

This plan defines two Google Forms for Mock Testing Suite (MTS) and Smart Alert Manager (SAM):

- Feedback, Bug Report, or Suggestion
- App Help / Support Request

The goal is to give testers and admins a simple way to report issues, request help, and flag urgent blockers without embedding credentials or private destinations in the app or repository.

## Goals

- Keep feedback and support intake separate but consistent.
- Route urgent reports quickly to a support owner.
- Store every response in Google Sheets for tracking, filtering, and follow-up.
- Allow optional email, SMS, and Discord alerting without committing secrets.
- Avoid hardcoded private emails, phone numbers, API keys, webhook URLs, or tokens.

## Forms

### Form 1: Feedback, Bug Report, or Suggestion

Use this for product feedback, bugs, UI issues, sounds, tutorials, settings, form filling, notifications, candidate tracking, payment simulation, update/install issues, and general suggestions.

Recommended form title:

`MTS / SAM Feedback, Bug Report, or Suggestion`

Recommended response Sheet tab:

`feedback_bug_suggestion_responses`

Full field specification:

`docs/google-form-fields-feedback.md`

### Form 2: App Help / Support Request

Use this when a tester or admin needs direct help with installation, setup, app behavior, MTS sessions, SAM notifications, Candidate Tracking, import/export, archive/search, or an app that will not open.

Recommended form title:

`MTS / SAM App Help and Support Request`

Recommended response Sheet tab:

`support_request_responses`

Full field specification:

`docs/google-form-fields-support-request.md`

## Response Sheet Setup

For each form:

1. Open the Google Form.
2. Go to Responses.
3. Click Link to Sheets.
4. Create a new spreadsheet or select an existing support spreadsheet.
5. Rename the response tab to the recommended tab name.
6. Freeze the header row.
7. Add filtered views for:
   - Urgent
   - High severity
   - MTS
   - SAM
   - Unreviewed
   - Needs follow-up
   - Closed

Optional tracking columns can be added to the response Sheet after the form-generated columns:

- Status
- Assigned to
- Date reviewed
- Follow-up needed
- Follow-up date
- Resolution notes
- Release blocker
- Fixed in version

Do not edit the form-generated timestamp or answer columns manually unless recovery is required.

## Urgent Alert Behavior

Urgent handling applies when:

- Feedback form `Severity` is `Urgent`
- Support form `Urgency` is `Urgent`

When urgent:

1. Send email alert immediately.
2. Optionally send SMS/text alert if configured.
3. Optionally send Discord webhook alert if configured.

Use the Apps Script template in:

`docs/google-forms-urgent-alerts-apps-script.md`

## Alert Options

### Google Apps Script Email Alert

Recommended first option. It is built into Google Workspace and can run directly from the response Sheet or Form.

Required placeholder:

- `SUPPORT_ALERT_EMAIL`

### Twilio SMS

Good for direct SMS when a paid SMS provider is acceptable.

Required placeholders:

- `TWILIO_ACCOUNT_SID`
- `TWILIO_AUTH_TOKEN`
- `TWILIO_FROM_NUMBER`
- `SUPPORT_PHONE_NUMBER`

Store these in Apps Script project properties, not in source files.

### Pushover

Good for personal or team push notifications. Configure only in private Apps Script properties or an automation service. Do not commit tokens.

### Zapier

Good for no-code routing to email, SMS, Slack, Discord, task boards, or ticket systems. Use the Google Forms or Google Sheets trigger and filter for urgent responses.

### Make

Good for more complex no-code workflows. Use a Google Sheets watch-row module and filter on urgent responses.

### IFTTT

Good for simple notification routing. Use only if it meets privacy and reliability needs.

### Carrier Email-to-Text

Can be used only if the recipient explicitly provides their carrier gateway address. Keep that value private and out of the repo.

### Discord Webhook

Good for sending urgent reports to a private support channel.

Required placeholder:

- `DISCORD_WEBHOOK_URL`

Store it in Apps Script project properties, not in source files.

## Apps Script Trigger Setup

Recommended setup:

1. Open the linked response Sheet.
2. Go to Extensions > Apps Script.
3. Create or paste the urgent alert script from `docs/google-forms-urgent-alerts-apps-script.md`.
4. Open Project Settings.
5. Add Script Properties for configured placeholders.
6. Go to Triggers.
7. Add trigger:
   - Function: `handleFormSubmit`
   - Deployment: Head
   - Event source: From spreadsheet
   - Event type: On form submit
8. Save and authorize the script.

Use one script project per response Sheet, or one shared script if both forms write to tabs in the same spreadsheet.

## Testing Urgent Alerts

Use test data only.

1. Confirm `SUPPORT_ALERT_EMAIL` is configured in Apps Script properties.
2. Submit a non-urgent response.
3. Confirm no urgent alert is sent.
4. Submit an urgent feedback response with:
   - App: MTS
   - Severity: Urgent
   - What happened: Test urgent feedback alert
5. Confirm email alert arrives.
6. If SMS is enabled, confirm SMS arrives.
7. If Discord is enabled, confirm Discord message appears in the private test channel.
8. Submit an urgent support response with:
   - App: SAM
   - Urgency: Urgent
   - Description: Test urgent support alert
9. Confirm alert content includes app, category, urgency, name, contact method, and short summary.
10. Delete or mark test responses as test data after verification.

## Turning SMS or Discord On and Off

Use Apps Script properties:

- Set `ENABLE_SMS_ALERTS` to `true` or `false`.
- Set `ENABLE_DISCORD_ALERTS` to `true` or `false`.

If SMS is off, Twilio properties may be omitted.

If Discord is off, `DISCORD_WEBHOOK_URL` may be omitted.

Email alerts should remain enabled for urgent responses unless the support owner intentionally disables the trigger.

## Organizing Responses

Recommended Sheet workflow:

1. Keep all raw responses.
2. Add tracking columns to the right of form fields.
3. Use filtered views instead of moving rows.
4. Assign each urgent row immediately.
5. Mark duplicate reports in the tracking columns.
6. Link related rows to an issue, release note, or fix branch if needed.
7. Keep a `Closed` status only after the reporter or support owner confirms the issue is resolved.

Recommended statuses:

- New
- Reviewing
- Need more info
- In progress
- Waiting on release
- Resolved
- Closed
- Duplicate
- Not reproducible

## Privacy and Safety

- Do not collect passwords, PINs, API keys, private keys, or service-account files through these forms.
- File uploads should be optional and should instruct users not to upload credentials.
- If a user accidentally submits a secret, restrict access to the response, rotate the exposed secret if needed, and remove the file from shared storage.
- Keep form response Sheets access-limited to approved support owners.
- Do not post urgent alerts to public Discord channels.

## Manual Steps Needed

1. Create the two Google Forms.
2. Add the fields exactly as documented.
3. Link each form to a response Sheet.
4. Add optional tracking columns.
5. Add Apps Script urgent alert handling.
6. Add private Apps Script properties.
7. Create the form-submit trigger.
8. Submit non-urgent and urgent test responses.
9. Confirm alert routing.
10. Share final form links with testers/admins through the approved channel.

