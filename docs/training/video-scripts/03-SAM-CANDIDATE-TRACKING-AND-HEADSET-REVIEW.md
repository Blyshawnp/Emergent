# SAM Candidate Tracking and Headset Review

## Metadata

- Title: SAM Candidate Tracking and Headset Review
- VideoKey: `sam-candidate-tracking-headset-review`
- Category: Candidate Tracking
- HelpTopicKey: `candidate-tracking`
- Audience: SAM administrators
- Duration: 8-10 minutes

## Objectives

- Search and review the full candidate record.
- Distinguish Update Status from More Actions.
- Make evidence-based headset decisions.
- Correct a pending headset before approval without creating a duplicate catalog identity.

## Prerequisites

Synthetic candidates across status views and one unknown headset ticket.

## Demo data/setup

Include Incomplete, Pending Sup Transfer, Withdrawn, Archived, and Extra Attempt Granted examples. Use fictional headset `Training USB 100`.

## Recording checklist

- [ ] All records synthetic.
- [ ] View Details has no private notes.
- [ ] Headset evidence is staged and non-production.

## Scene-by-scene plan

| Time | Scene | Exact narration | Exact on-screen actions | Callout text | Pause/zoom notes |
|---|---|---|---|---|---|
| 0:00-0:35 | Principle | “Candidate administration starts with the correct record and the full history. Search, open View Details, then choose the authorized action.” | Open Candidate Tracking. | `Full record before action` | Hold header. |
| 0:35-1:35 | Search/views | “Use Candidate Search for a name, include archived candidates only when needed, and choose View in Tracking. Candidate Tracking views separate pending, incomplete, failures, withdrawn, extra attempts, passed, archived, and active candidates.” | Search synthetic name; View in Tracking; click several view tabs. | `Confirm the view and candidate` | Keep names clearly synthetic. |
| 1:35-2:35 | Show More vs details | “Show More expands only the row’s Results or Notes preview. View Details opens the authoritative record, including attempts, Basics, results, summaries, and follow-up state.” | Use **Show More**, **Show Less**, then **View Details**. | `Preview != full record` | Freeze both controls. |
| 2:35-4:00 | Update Status | “For every active record, Update Status includes Mark Passed, Mark Failed, and Grant Extra Attempt. Pending Supervisor Transfer appears where that workflow applies. Archived records must be restored before these actions return. The displayed status follows the overall certification result, so passed mock calls do not override a failed required Supervisor Transfer.” | Open menus on synthetic active, failed-final, and archived rows; show note confirmation; cancel. | `Overall result; exact record` | Do not complete unauthorized changes. |
| 4:00-5:20 | More Actions | “More Actions contains Cancel Transfer, Archive, Withdraw or Restore, and Delete. Archive keeps history but hides it from active views. Withdraw blocks continuation. Restore removes withdrawn status. Delete permanently removes shared candidate history and should be rare.” | Open menus on synthetic rows; show Archive and Delete confirmations; cancel. | `Archive != Withdraw != Delete` | Pause on each definition. |
| 5:20-5:55 | Extra attempt | “Grant Extra Attempt increases the allowed maximum by exactly one. After attempts one through three, the next certification attempt is four of four. It changes eligibility, not the prior failed result, and a Supervisor Transfer continuation stays within the same attempt.” | Show **Grant Extra Attempt** confirmation and a prepared **Attempt 4 of 4** record; cancel. | `Adds one; preserves history` | Hold confirmation. |
| 5:55-7:15 | Headset research | “In Headset Review, open a pending ticket and use Look Up or Research Headset. Confirm both USB connection and a noise-cancelling microphone. Search results support the decision; they do not make it.” | Open Headset Review; select **Look Up**; return to decision dialog. | `Both requirements must pass` | Hide browser history. |
| 7:15-8:05 | Correct pending headset | “Before approval, select Edit Headset to correct spelling, spacing, capitalization, or the Brand and Model split. Select Save Headset. The same review stays Pending, and the saved current values become the values used by approval.” | On a synthetic Pending ticket select **Edit Headset**; correct Brand and Model; select **Save Headset**; show the same ticket still Pending. | `Correct the existing review` | Hold the pending status and corrected display. |
| 8:05-9:15 | Decision and catalog | “Approve only with evidence. Approved active catalog rows appear in MTS; denied, archived, and deleted rows do not. Brand and Model remain separate catalog fields even when the app shows one combined label. Compatibility decisions are separate from spelling corrections. Deny requires the matching reason, and Other requires a note.” | Show separate approved, denied, and archived synthetic rows plus the MTS selector; do not complete a destructive action. | `Status controls visibility` | Verify there is no name-specific rule. |

## Mistakes to emphasize

- Acting on the row preview only.
- Confusing status actions with lifecycle/destructive actions.
- Treating Extra Attempt as history removal.
- Approving a headset from an unverified search snippet.
- Denying and recreating a review just to correct its spelling.
- Approving before saving the corrected Brand and Model.
- Leaving both old and corrected spellings active.
- Using Delete instead of Archive.

## Closing summary

“Use the correct view, open View Details, choose the authorized candidate action, and require evidence for every headset decision.”

## Related Help topics

`candidate-search`, `candidate-tracking`, `candidate-admin-actions`, `pending-sup-transfers`, `headset-review`, `reports`

## Thumbnail/title suggestion

Title: `SAM Candidate Tracking: Safe Admin Actions`
Thumbnail: View Details plus Archive/Withdraw/Delete distinctions.

## Editing notes

Label every synthetic candidate status. Do not show a destructive action completing.

## Caption review checklist

- [ ] View Details and Show More distinct.
- [ ] Update Status / More Actions exact.
- [ ] Archive, Withdraw, Restore, Extra Attempt, Delete accurate.
- [ ] Headset requirements exact.
- [ ] Edit Headset and Save Headset labels exact; review remains Pending.
- [ ] Approval uses corrected current values and does not duplicate an existing approved match.
- [ ] No real candidate/headset data.
