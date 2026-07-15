# Video Recording Standards

## Output format

- Record at 1920 x 1080, 16:9, 30 fps.
- Use 100% Windows display scaling for the reference capture when practical. If the app must be demonstrated at higher scaling, disclose it in the slate and keep the entire target control visible.
- Keep the app window at a stable 1600 x 900 or larger working area inside the 1080p frame. Do not resize during a take unless the script teaches responsive behavior.
- Export H.264 MP4 with clear text at normal playback speed.

## Window, cursor, and zoom

- Capture one app only; hide desktop icons, taskbar previews, unrelated browsers, and file paths.
- Use a normal-size high-contrast cursor with click highlight. Do not use novelty cursors.
- Move deliberately and park the cursor away from text while narrating.
- Use editor zooms/callouts, not operating-system magnification. Default zoom: 115-130% crop for one control group, no more than 150% unless text remains sharp.
- Hold each callout at least 1.5 seconds. Keep callouts outside button hit areas and captions.

## Audio

- Record in a quiet room with a consistent microphone position.
- Target clear, conversational delivery around -16 LUFS integrated and peaks below -1 dBFS.
- Remove long silences, mouth noise, keyboard noise, and notification sounds without making speech unnatural.
- Pronounce MTS, SAM, NC/NS, Supervisor Transfer, and Form Filled consistently.

## Captions

- Provide reviewed English captions; auto-captions alone are not final.
- Match visible labels exactly, including capitalization and slashes.
- Caption meaningful UI confirmation text; do not caption private demo values beyond what is intentionally narrated.
- Keep captions to two lines where possible and away from bottom action bars.
- Review names such as Smart Resume, Newbie Shift, Form Filled, Same Day Drop, and `certification@acdsupport.com` character by character.

## Safe demo data and privacy

- Use synthetic names, dates, phone numbers, email addresses, call notes, and notification content.
- Never show real candidate data, tester PINs, secrets, private company content, private content locations, private deployment information, browser history, bookmarks, or clipboard history.
- Use a dedicated training profile with no saved passwords or personal accounts.
- Crop or blur any unexpected private value; retake when a blur would obscure the workflow.
- Do not display technical internals in user training.

## Recording environment

- Turn off Windows, browser, email, chat, calendar, and phone notifications.
- Close unrelated apps and tabs.
- Clear recent files, downloads, browser suggestions, and clipboard history.
- Seed only the synthetic records required by the script.
- Confirm MTS/SAM status is healthy before recording; do not teach around an unexplained error.
- Set a stable clock/date when the 24-hour rule is demonstrated and show both timestamps clearly.

## Intro, chapter cards, and outro

- Intro: 3-5 seconds with product name, video title, and version/date.
- State the audience and one safety-critical goal in the first 20 seconds.
- Use brief chapter cards only for meaningful workflow transitions.
- Outro: recap 2-3 costly-error preventions and point to the related Help topic.
- Do not add long branded animations, music beds under critical narration, or repeated legal text.

## Recording checklist

- [ ] Script and content map match current source.
- [ ] VideoKey, Category, and HelpTopicKey are correct.
- [ ] Synthetic data is loaded and labeled.
- [ ] Notifications and personal accounts are off/closed.
- [ ] App window, resolution, scaling, and cursor meet standard.
- [ ] Microphone level and one-sentence test recording pass.
- [ ] Form Fill demo cannot create a real candidate submission.
- [ ] Calendar/Discord/browser demonstrations use safe demo content.

## Retake checklist

Retake a scene when:

- A label is misnamed or the wrong action is selected.
- Private or real data appears.
- A confirmation is skipped, covered, or unreadable.
- The cursor obscures the target.
- Audio clips, drops, or contradicts the screen.
- The presenter calls Form Filled submitted.
- The 24-hour example is mathematically ambiguous.
- A Pending Request alert action is described as a decision.
- A status or generated ID is manually edited when the product does not allow it.

## Editing and review

- Remove loading waits but preserve enough context to show refresh/transition.
- Do not splice actions so the visible result appears to come from a different control.
- Use freeze frames for warning copy and destructive confirmations.
- Add a privacy pass, label-accuracy pass, audio pass, and caption pass by different reviewers when staffing allows.
- Keep an edit decision list for retakes and approved wording changes.

## Upload and Help placement

1. Export the approved file using the naming convention below.
2. Upload to YouTube as **Unlisted**.
3. Enable embedding and confirm playback in a private/incognito test.
4. In the authorized tutorial-video Google Sheet, update that row's `YouTubeURL` and exact `Category`, and verify its VideoKey, HelpTopicKey, duration, audience, sort order, and Active value. Do not record or publish the sheet address.
5. Verify Help > Tutorial Videos placement, matching Help-article attachment, **Watch Tutorial Video**, and **Open in Browser**.
6. Verify inactive rows disappear and the written Help remains complete.

## Naming and version convention

Use `APP-VideoKey-vMAJOR.MINOR-YYYYMMDD.mp4`.

Examples:

- `MTS-mts-mock-calls-v1.0-20260715.mp4`
- `SAM-sam-pending-requests-v1.0-20260715.mp4`

The YouTube title should be human readable; keep the stable VideoKey in production metadata, not necessarily the public title.

## Replacement and deactivation

- Minor caption/description correction: update metadata without changing VideoKey.
- Content replacement: upload the new Unlisted video, review it, then replace the URL on the existing VideoKey row.
- Workflow retirement: set Active to FALSE before removing references. Keep the row/key for traceability unless department retention policy says otherwise.
- Never reuse a VideoKey for a different topic.
- Verify the old video is no longer linked before deactivating or deleting it on YouTube.

## Caption review checklist

- [ ] Exact UI labels and terminology.
- [ ] No obsolete email or private data.
- [ ] Punctuation and speaker changes are clear.
- [ ] Captions align with the action within roughly one second.
- [ ] Warning/confirmation narration is complete.
- [ ] Acronyms and status names are consistent.
- [ ] Final captions have been watched end-to-end at normal speed.
