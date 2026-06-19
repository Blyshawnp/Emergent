# Google Form Fields: Feedback, Bug Report, or Suggestion

Recommended form title:

`MTS / SAM Feedback, Bug Report, or Suggestion`

Recommended description:

Use this form to report a bug, suggestion, visual issue, sound issue, settings problem, tutorial/help problem, form filling issue, notification issue, Candidate Tracking issue, payment simulation issue, update/install issue, or other MTS/SAM feedback. Do not submit passwords, private keys, API keys, tokens, or service-account files.

## Field List

### 1. Name

Question type:

Short answer

Required:

Yes

Help text:

Enter the name support should use when following up.

### 2. Email

Question type:

Short answer

Required:

Yes

Validation:

Email address

Help text:

Use the best email for follow-up unless no contact is needed.

### 3. Preferred contact method

Question type:

Multiple choice

Required:

Yes

Options:

- Email
- Discord
- Phone
- No contact needed

### 4. Discord username

Question type:

Short answer

Required:

No

Help text:

Required only if Discord is the preferred contact method.

### 5. Phone number

Question type:

Short answer

Required:

No

Help text:

Required only if Phone is the preferred contact method. Do not include this if no phone follow-up is needed.

### 6. App

Question type:

Multiple choice

Required:

Yes

Options:

- MTS
- SAM
- Both

### 7. Report type

Question type:

Multiple choice

Required:

Yes

Options:

- Bug
- Suggestion
- Visual/UI issue
- Sound issue
- Settings issue
- Tutorial/Help issue
- Form filling issue
- Notification issue
- Candidate Tracking issue
- Payment simulation issue
- Update/install issue
- Other

### 8. Screen/area

Question type:

Short answer

Required:

No

Examples:

- Setup Wizard
- Help
- Discord Posts
- Basics
- Calls
- Payment simulation
- Review
- History
- SAM Notifications
- SAM Candidate Tracking

### 9. Severity

Question type:

Multiple choice

Required:

Yes

Options:

- Low
- Medium
- High
- Urgent

Help text:

Choose Urgent only when the issue blocks work, prevents the app from opening, risks data loss, or prevents completion of required testing/admin work.

### 10. Is this blocking your work?

Question type:

Multiple choice

Required:

Yes

Options:

- Yes
- No
- Not sure

### 11. What happened?

Question type:

Paragraph

Required:

Yes

Help text:

Describe what you saw. Include exact wording from any error message if possible. Do not include credentials or private keys.

### 12. Expected behavior

Question type:

Paragraph

Required:

No

Help text:

Describe what you expected the app to do.

### 13. Steps to reproduce

Question type:

Paragraph

Required:

No

Prompt:

List the steps that caused the issue.

Suggested answer format:

1. Opened:
2. Clicked:
3. Entered:
4. Expected:
5. Actual:

### 14. Screenshot/file upload instructions

Question type:

Paragraph or Section text

Required:

No

Recommended text:

If you have a screenshot, screen recording, or sample file, attach it using the upload field if one is enabled for this form. Do not upload passwords, private keys, API keys, tokens, service-account files, or files containing private candidate data unless support has specifically asked for a redacted copy.

Optional upload field:

File upload

Upload limits:

- Allow images and video if needed.
- Keep file size modest.
- Require sign-in only if that is acceptable for the tester/admin group.

### 15. App version

Question type:

Short answer

Required:

No

Help text:

Use the version shown in the app, installer, or About/Help screen.

### 16. Windows version

Question type:

Short answer

Required:

No

Examples:

- Windows 10
- Windows 11

### 17. Other details

Question type:

Paragraph

Required:

No

Help text:

Add anything else that may help support reproduce or understand the report.

## Recommended Response Sheet Columns

Google Forms creates answer columns automatically. Add these support tracking columns to the right:

- Status
- Assigned to
- Reviewed date
- Follow-up needed
- Release blocker
- Duplicate of
- Fixed in version
- Resolution notes

## Urgent Detection

This form should be treated as urgent when:

- `Severity` equals `Urgent`

Urgent alert summary should include:

- App
- Report type
- Severity
- Name
- Preferred contact method
- Screen/area
- What happened

