# SAM Notifications and Live Preview

## Metadata

- Title: SAM Notifications and Live Preview
- VideoKey: `sam-notifications-live-preview`
- Category: Notifications
- HelpTopicKey: `notifications`
- Audience: SAM administrators
- Duration: 6-8 minutes

## Objectives

- Create a notification with an automatically generated ID.
- Edit, duplicate, disable, and delete safely.
- Verify Ticker, Banner, and Popup previews.

## Prerequisites

Synthetic inactive notification and safe schedule.

## Demo data/setup

Create `Training Maintenance Reminder` with generic text and no external action link. Keep it disabled after recording.

## Recording checklist

- [ ] Notification stays synthetic/inactive.
- [ ] No private link or company message.
- [ ] Preview modes ready.

## Scene-by-scene plan

| Time | Scene | Exact narration | Exact on-screen actions | Callout text | Pause/zoom notes |
|---|---|---|---|---|---|
| 0:00-0:30 | Goal | “A safe notification is correct, previewed, scheduled, and reversible. Start with Add Notification.” | Select **Add Notification**. | `Preview before publish` | Hold editor. |
| 0:30-1:45 | Create | “Enter title, message, and type. SAM assigns the internal notification ID automatically and preserves it. There is no ID field to edit. New notifications default to Ticker only.” | Enter synthetic title/message; point to type and Ticker. | `Generated ID - do not edit` | No technical ID shown. |
| 1:45-2:45 | Status/schedule | “Active Status controls whether the row can display. Choose Ticker, Show Popup, Show Banner, and Persistent only as needed. Verify start and expiration. An end date without a time uses midnight.” | Set disabled; toggle preview types; enter safe dates. | `Verify active state and time` | Zoom schedule. |
| 2:45-3:45 | Preview | “Live Preview shows Ticker Preview, Banner Preview, and Popup Preview for the selected draft. Preview checks appearance; it does not prove the notification is currently active.” | Open Live Preview; inspect three panels. | `Preview != active` | Hold each preview. |
| 3:45-4:25 | MTS ticker handoff | “After a valid notification is saved, MTS refreshes ticker content in the background. Cached or built-in guidance can appear first, so MTS startup does not wait for SAM. Ticker speed is chosen in MTS Settings. SAM manages content; it does not disable the MTS ticker.” | Save an isolated synthetic Ticker notification, then show a prepared MTS refresh clip and **Ticker Speed** choices. | `SAM content; MTS speed` | Keep implementation details off screen. |
| 3:45-4:35 | Save/edit | “Return to Edit Notification and select Submit Selected Notification. After saving, Edit preserves the same generated ID.” | Submit in isolated training environment; reopen with **Edit**. | `Same ID on edit` | Show success banner. |
| 4:35-5:15 | Duplicate | “Duplicate creates a new row with a new generated ID and adds Copy to the title. Review every field before saving the duplicate.” | Select **Duplicate**, show title Copy, close/delete training draft if required. | `Duplicate gets a new ID` | Pause on title. |
| 5:15-6:05 | Disable/delete | “Disable retires a row without deleting it. Use Delete only when permanent removal is intended and read the confirmation first.” | Show **Disable** confirmation, cancel or complete safely; show **Delete** confirmation and cancel. | `Disable is safer when temporary` | Freeze destructive confirmation. |

## Mistakes to emphasize

- Looking for or manually supplying an ID.
- Saving without reviewing Live Preview and schedule.
- Confusing preview with active delivery.
- Deleting when Disable is sufficient.

## Closing summary

“Create the content, verify status and schedule, inspect all enabled previews, save, and use Disable for temporary retirement.”

## Related Help topics

`notifications`, `live-preview`, `import-export-csv`, `refresh-data`, `troubleshooting`

## Thumbnail/title suggestion

Title: `SAM Notifications: Create, Preview, and Retire Safely`
Thumbnail: Ticker/Banner/Popup previews.

## Editing notes

Mask any unexpected action URL. Keep success and confirmation copy readable.

## Caption review checklist

- [ ] Submit Selected Notification exact.
- [ ] Ticker/Show Popup/Show Banner/Persistent exact.
- [ ] Generated ID behavior accurate.
- [ ] Disable versus Delete clear.
- [ ] Synthetic content only.
