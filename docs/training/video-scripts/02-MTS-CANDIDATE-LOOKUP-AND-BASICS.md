# MTS Candidate Lookup and Basics

## Metadata

- Title: MTS Candidate Lookup and Basics: Verify Before You Score
- VideoKey: `mts-candidate-lookup-basics`
- Category: Candidate Lookup
- HelpTopicKey: `basics`
- Audience: MTS trainers
- Duration: 6-8 minutes

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
- [ ] VPN panel shows trainer-safe output only.

## Scene-by-scene plan

| Time | Scene | Exact narration | Exact on-screen actions | Callout text | Pause/zoom notes |
|---|---|---|---|---|---|
| 0:00-0:30 | Safety goal | “The most expensive Basics mistake is scoring the wrong person or continuing a candidate who is blocked. Verify the match and eligibility before entering readiness answers.” | Show Basics title and Candidate Name. | `Verify before scoring` | Hold candidate field. |
| 0:30-1:35 | Lookup | “Enter a strong search, normally first name plus part of the last name. Use Review Previous Session to inspect the prior record. Choose Correct Candidate only after the name and history match.” | Type synthetic name, open/close prior-session details, confirm synthetic match. | `Review Previous Session` | Zoom on match controls. |
| 1:35-2:05 | Typed name | “When no shared row is the correct person, choose Use typed name. This continues without linking a shared candidate record; it is not a way to bypass a known block.” | Return to lookup, select **Use typed name: [name]**. | `Not an eligibility bypass` | Pause on helper text. |
| 2:05-3:05 | Eligibility | “MTS blocks a passed candidate, a failed final attempt, or a withdrawn candidate unless the authorized state allows another attempt. Extra Attempt Granted permits continuation. If prior failures make this the final attempt, MTS sets Final Attempt and warns you.” | Cycle synthetic examples without saving. Show Final Attempt warning and blocked message. | `Stop on a block` | Freeze block; show canonical support email if visible. |
| 3:05-4:10 | Headset | “Select Brand / Model first. An approved headset marks USB and Noise Cancelling Mic Yes automatically. If it is unlisted, Research Headset can support trainer judgment, but it does not approve the model. Use This Headset only when the session should continue; admin review is still required.” | Search approved model; clear; enter unlisted model; show Research Headset and Use This Headset. | `Research is not approval` | Pause on helper copy. |
| 4:10-5:05 | VPN | “Use VPN / Proxy Check as decision support. The tester makes the final decision. If coverage is limited or the result is unclear, manually verify. Do not turn a single provider signal into an automatic verdict.” | Run safe demo check or show prepared trainer-safe state. Point to manual-verification warning. | `Manual verification required` | Crop out any technical metadata. |
| 5:05-5:50 | Browser Checklist | “Answer Default browser, Extensions disabled, and Pop-ups allowed. Continue stays blocked until required answers are complete. If an item cannot be corrected, follow the confirmation path rather than forcing the workflow.” | Answer the three questions in a synthetic safe state. | `Complete all three` | Zoom on checklist. |
| 5:50-6:35 | Smart Resume recognition | “Prior records with saved calls and unfinished Supervisor Transfer work belong in Smart Resume. Confirm the candidate and use the resume path so calls, coaching, and attempt context are preserved.” | Return Home to show active/resume prompt or prepared Smart Resume card. | `Preserve prior call data` | Hold resume prompt. |

## Mistakes to emphasize

- Selecting a similar name without opening the prior record.
- Using typed name to evade a verified block.
- Manually toggling Final Attempt without evidence.
- Treating Research Headset or VPN signals as automatic approval/failure.
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
- [ ] Tester makes the final VPN/proxy decision.
- [ ] Canonical email correct if shown.
- [ ] No internal IDs.
