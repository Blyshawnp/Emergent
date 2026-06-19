# SAM Admin Training Video Script

Target length: 8 to 15 minutes

Tone: relaxed, clear, and practical. This is a screen recording for admins using Smart Alert Manager.

## Before Recording

- Use a safe test build and test rows.
- Do not show private keys, tokens, real Sheet IDs, service-account emails, or private candidate data.
- Use a test CSV for import.
- Keep SAM sounds on Medium if demonstrating sounds.

## Opening

Say:

"Hi everyone. This video is a practical walkthrough of SAM, or Smart Alert Manager. SAM is where admins manage alert notifications and candidate tracking records that MTS uses."

Show:

- SAM launch
- Status chips
- Main sections

## Notifications

Say:

"The Notifications section reads and writes the alert rows used by MTS. You can add, edit, enable, disable, duplicate, delete, import, export, and refresh notification rows."

Show:

- Notification table
- Add Notification
- Required fields
- Save notification
- Success status banner

Say:

"Success and error feedback appears in the status banner. Success banners can dismiss automatically based on the local setting, and every banner has a dismiss button."

Show:

- Manual dismiss
- Success banner
- Safe validation error

## Live Preview

Say:

"Live Preview is a quick way to check how the selected notification will look before saving or pushing changes."

Show:

- Ticker preview
- Banner preview
- Popup preview
- Type changes from info to warning or urgent

## Candidate Tracking

Say:

"Candidate Tracking is where admins can review pending supervisor transfers, incomplete candidates, failed final attempts, withdrawn candidates, passed certifications, archived candidates, and all active candidates."

Show:

- Candidate Tracking
- View tabs or filters
- Row layout
- View Details

Say:

"Archive is separate from Delete. Archive keeps the record but removes it from active views. Delete should only be used when a shared row truly needs to be removed."

Show:

- Manual archive on a safe test candidate
- Archived Candidates view
- Archived badge

## Candidate Search

Say:

"Candidate Search defaults to active records. If you need to find archived candidates, turn on Include archived candidates."

Show:

- Candidate Search
- Search active candidate
- Toggle Include archived candidates
- Archived label

## Pending Sup Transfers

Say:

"Pending Sup Transfers are candidates whose mock calls were completed but whose supervisor transfer still needs to be completed or corrected."

Show:

- Pending Sup Transfers view
- Candidate, tester, date, call results
- Safe move or remove action only if using test data

## Candidate Actions

Say:

"Candidate status actions update the shared candidate tracking data. Use confirmation prompts carefully, especially for withdrawn, passed, failed, incomplete, archive, or pending transfer actions."

Show:

- Mark passed
- Mark withdrawn
- Grant or restore where safe
- Error handling if a write fails

## Import and Export CSV

Say:

"Export is useful as a backup before larger edits. Import lets you bring in a CSV and validate it before working with those rows."

Show:

- Export Backup CSV
- Import CSV
- Validation error with bad CSV if practical
- Success feedback with safe CSV

## Refresh From Sheet

Say:

"Refresh from Sheet reloads the live rows and candidate tracking state without restarting SAM."

Show:

- Refresh from Sheet
- Loading or status feedback

## Settings and Help

Say:

"SAM Help includes the local settings that are safe to change from this screen: sounds, banner duration, default candidate filter, archived search default, and tutorial video behavior."

Show:

- Help
- Clickable section titles
- SAM sounds
- Banner duration
- Default candidate filter
- Include archived default
- Tutorial video mode
- Replay Tutorial

## Sounds

Say:

"SAM uses a success sound for successful actions and an error sound for problems. If sound is off, those actions still work silently."

Show:

- Sound setting
- Success action
- Safe error action

## Updates

Say:

"Check for Updates looks for the current SAM release metadata. If a manual download is needed, SAM should explain that clearly."

Show:

- Check for Updates
- Status result

## Exit and Single Instance

Say:

"SAM should only open one SAM window at a time, but MTS and SAM can be open together. Exit App closes SAM after confirmation."

Show:

- Exit App
- Cancel
- Exit
- Explain single-instance behavior

## Close

Say:

"That’s the SAM admin workflow. The main habits are: use safe test rows for training, archive instead of delete unless deletion is intentional, export before bulk edits, and use Refresh from Sheet to confirm shared state."

