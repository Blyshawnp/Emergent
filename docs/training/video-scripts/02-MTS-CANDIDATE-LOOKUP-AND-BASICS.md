# MTS Candidate Lookup and Basics

## Metadata

- Title: MTS Candidate Lookup and Basics: Verify Before You Score
- VideoKey: `mts-candidate-lookup-basics`
- Category: Candidate Lookup
- HelpTopicKey: `basics`
- Audience: MTS trainers
- Duration: 6-8 minutes
- Recording impact: partial scene replacement for VPN.

## Objectives

- Choose the correct candidate or typed-name path.
- Interpret eligibility, final-attempt, headset, VPN, and Browser Checklist states.
- Recognize when prior data should lead to Smart Resume.

## Prerequisites

MTS setup complete; synthetic lookup rows for new, prior failure, final-attempt-used, withdrawn, and extra-attempt-granted cases.

## Demo data/setup

Use obvious synthetic labels such as `Taylor Training - Final Used`. Do not expose internal IDs or real histories.

## Recording checklist

- [ ] All eligibility examples are synthetic.
- [ ] Approved and unlisted headset examples ready.
- [ ] VPN section shows Has VPN, Can turn off, and exactly three manual Copy Link rows; no automatic result is visible.

## Scene-by-scene plan

| Time | Scene | Exact narration | Exact on-screen actions | Callout text | Pause/zoom notes |
|---|---|---|---|---|---|
| 0:00-0:30 | Safety goal | “The most expensive Basics mistake is scoring the wrong person or continuing a candidate who is blocked. Verify the match and eligibility before entering readiness answers.” | Show Basics title and Candidate Name. | `Verify before scoring` | Hold candidate field. |
| 0:30-1:35 | Lookup | “Enter a strong search, normally first name plus part of the last name. Use Review Previous Session to inspect the prior record. Choose Correct Candidate only after the name and history match.” | Type synthetic name, open/close prior-session details, confirm synthetic match. | `Review Previous Session` | Zoom on match controls. |
| 1:35-2:05 | Typed name | “When no shared row is the correct person, choose Use typed name. This continues without linking a shared candidate record; it is not a way to bypass a known block.” | Return to lookup, select **Use typed name: [name]**. | `Not an eligibility bypass` | Pause on helper text. |
| 2:05-3:05 | Eligibility | “MTS blocks a passed candidate, a failed final attempt, or a withdrawn candidate unless the authorized state allows another attempt. Extra Attempt Granted permits continuation. If prior failures make this the final attempt, MTS sets Final Attempt and warns you.” | Cycle synthetic examples without saving. Show Final Attempt warning and blocked message. | `Stop on a block` | Freeze block; show canonical support email if visible. |
| 3:05-4:25 | Headset | “Select an approved Brand and Model, or type an unlisted headset. For an unlisted model, select Research Headset and verify whether it has both a wired USB connection and a noise-cancelling microphone. When you return, select Yes only if the research supports both requirements. MTS returns the headset to Basics already selected, so do not select Use This Headset again. Research does not approve the model; it may later appear in SAM Headset Review.” | Search an approved model; clear; enter an unlisted model; select **Research Headset**; return to **Research Complete**; select **Yes** in the synthetic example; show the headset selected and focus returned to verification. | `Research selects; SAM decides approval` | Pause on the confirmation and selected value. |
| 4:25-4:55 | Required headset answers | “USB and Noise Cancelling Mic still require an explicit Yes or No. The session cannot continue until both are answered. Selecting No or cancelling research does not approve or select the headset.” | Select **Yes** or **No** for both fields in a safe example; show Continue blocked while either answer is blank. | `Answer both fields` | Freeze the blocked state. |
| 4:55-5:50 | VPN | “Answer Has VPN. If Yes, answer whether it can be turned off. For a manual IP check, expand VPN / Proxy Lookup Sites. MTS provides IP2Location, IPinfo, and ip.teoh.io. Copy Link copies the selected website address. Open that site separately and enter the candidate IP there. The sites are reference tools only. They do not fill the VPN answers or determine pass or fail, and MTS does not automatically verify VPN or proxy status.” | Answer Has VPN Yes, show Can turn off enabled, then answer Has VPN No and show the conditional state. Expand **VPN / Proxy Lookup Sites** and select one **Copy Link** to show **Copied**. Do not open a browser or enter an IP. | `Three manual links; no automatic check` | Replace the complete prior VPN scene. Keep all three rows visible. |
| 5:50-6:35 | Browser Checklist | “Answer Default browser, Extensions disabled, and Pop-ups allowed. Continue stays blocked until required answers are complete. If an item cannot be corrected, follow the confirmation path rather than forcing the workflow.” | Answer the three questions in a synthetic safe state. | `Complete all three` | Zoom on checklist. |
| 6:35-7:20 | Smart Resume recognition | “Prior records with saved calls and unfinished Supervisor Transfer work belong in Smart Resume. Confirm the candidate and use the resume path so calls, coaching, and attempt context are preserved.” | Return Home to show active/resume prompt or prepared Smart Resume card. | `Preserve prior call data` | Hold resume prompt. |

## Mistakes to emphasize

- Selecting a similar name without opening the prior record.
- Using typed name to evade a verified block.
- Manually toggling Final Attempt without evidence.
- Treating Research Headset or an external VPN lookup site as automatic approval/failure.
- Selecting Use This Headset after a successful Research Complete confirmation.
- Assuming research answered USB or Noise Cancelling Mic instead of answering both explicitly.
- Starting fresh when Smart Resume is available.

## Closing summary

“Before Continue, confirm four things: the correct candidate, eligibility and attempt state, headset readiness, and the complete VPN and Browser Checklist review.”

## Related Help topics

`basics`, `headset-lookup`, `smart-resume`, `autofails-ncns-notready`, `tech-issue`

## Thumbnail/title suggestion

Title: `MTS Basics: Verify Candidate and Readiness`
Thumbnail: Candidate Lookup plus `Correct Candidate?` callout.

## Editing notes

Use separate synthetic rows for each eligibility state. Never composite a block and an approval onto the same candidate without a visible reset.

## Caption review checklist

- [ ] Use typed name and Correct Candidate labels exact.
- [ ] USB and Noise Cancelling Mic wording exact.
- [ ] Research Complete Yes returns the unlisted headset selected without a second Use This Headset click.
- [ ] USB and Noise Cancelling Mic still require explicit answers.
- [ ] Has VPN and Can turn off behavior is shown accurately.
- [ ] Three manual lookup sites and Copy Link behavior are shown.
- [ ] Narration states that MTS does not automatically verify VPN/proxy status or determine pass/fail.
- [ ] Canonical email correct if shown.
- [ ] No internal IDs.
