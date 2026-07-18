# Scenario Maintenance Guide

## Overview

MTS automatically generates scenario text from the selected caller, show/station, Call type or Supervisor Transfer reason, and randomized demographic details. The React pages render the sentence; the backend supplies configured or packaged content. Google Sheets may supply editable labels and caller/show rows, but it does not construct either scenario sentence.

## Supervisor Transfer Scenario Sources

- `frontend/src/pages/SupTransferPage.jsx` is the authoritative rendering source. `DEFAULT_SUP_REASONS` is the frontend emergency fallback, `getSupervisorReasonScenarioText()` owns reason-specific sentences, `formatScenarioNote()` formats optional show notes, and `regenSupFlags()` rerolls demographic flags. Editing this file requires a frontend build and new installers for distribution; it does not require a backend or Apps Script deployment.
- `backend/defaults/sup-reasons.csv` is the packaged backend fallback for reason labels. `backend/server.py` maps it through `DEFAULTS_FILE_MAP`, `_normalize_text_list()`, and the `sup_reasons` defaults loader. The desktop builders package the entire `backend/defaults` directory. Editing it requires a backend build and new installers for distribution.
- `backend/server.py` also contains the in-code `SUP_REASONS` last-resort list. Keep it aligned with the CSV fallback. Editing it requires a backend build and new installers.
- `docs/admin-content-package/csv-tabs/sup-reasons.csv` and the `Sup Reasons` worksheet in `docs/admin-content-package/mock-testing-suite-admin-content.xml` are administrator-package templates. They are documentation/import sources, not application runtime sentence templates. Keep their labels aligned when distributing a revised admin package.
- `backend/defaults/callers.csv` and `backend/defaults/shows.csv` supply packaged caller and show/station rows. Their administrator-package mirrors are `docs/admin-content-package/csv-tabs/callers-new.csv`, `callers-existing.csv`, `callers-increase.csv`, and `shows.csv`.

At runtime, nonempty configured `settings.sup_reasons` wins, then loaded `defaults.sup_reasons`, then `DEFAULT_SUP_REASONS`. A remotely managed `sup-reasons` tab can therefore change dropdown labels. The actual reason-to-sentence mapping remains in `getSupervisorReasonScenarioText()` and must safely handle configured labels.

## Regular Call Scenario Sources

- `frontend/src/pages/CallsPage.jsx` contains the shared generator for Call 1, Call 2, and Call 3. `classifyCallType()` selects the caller category, `getCallersForType()` selects the appropriate caller list, `getDonationsForShow()` selects the donation amount, `ScenarioCard` builds the sentence, `buildScenarioNotes()` formats show notes, and `generateRandomFlags()` supplies demographic flags.
- `backend/defaults/call-types.csv`, `callers.csv`, and `shows.csv` are the packaged backend fallbacks. `backend/server.py` loads them through `DEFAULTS_FILE_MAP`, `_normalize_text_list()`, `_normalize_callers()`, and `_normalize_shows()` before exposing defaults/settings to the frontend.
- `docs/admin-content-package/csv-tabs/call-types.csv`, the three `callers-*.csv` files, and `shows.csv` are administrator-package mirrors.

All three regular Calls use the same `CallsPage` and `ScenarioCard`; `callNum` changes the saved attempt, not the sentence generator. Regular Calls do not share the Supervisor Transfer reason-text helper.

## How Scenario Text Is Built

For Supervisor Transfers, the selected caller row supplies the full name and its first column supplies the first name. The selected show/station row supplies optional scenario notes. The selected reason is passed to `getSupervisorReasonScenarioText()`, which returns one complete grammatical sentence. The card then renders the opening, the reason sentence, optional show notes, and the demographic flags.

For regular Calls, the Call type chooses new, existing, or sustaining-increase caller data. The selected caller supplies full and first names, the selected show supplies station, donation amounts, gift, and optional notes, and `ScenarioCard` chooses the established donation action phrase.

```text
Selected reason
→ reason-specific scenario text
→ caller name inserted
→ scenario card rendered
```

On either page, Regenerate rerolls only allowed demographic values such as phone type, SMS, newsletter, shipping, and processing-fee choices. It does not choose a different Supervisor Transfer reason, caller, show, Call type, or donation sentence.

## How to Change a Supervisor Transfer Reason

1. Find the reason label in `DEFAULT_SUP_REASONS`, the backend fallback CSV/list, and any administrator-package mirror.
2. Keep the stable label or normalized matching phrase unchanged unless a label correction is part of the requirement. Existing saved drafts and configured rows store the label, not a separate ID.
3. Edit only the relevant branch in `getSupervisorReasonScenarioText()` or the label source that actually needs changing.
4. Return a complete grammatical sentence, including final punctuation.
5. Do not add a generic phrase to every scenario.
6. Update `frontend/src/pages/SupTransferPage.test.jsx`, including aliases that configured content may use.
7. Rebuild the frontend and, when backend defaults changed, rebuild the backend and installers.

Good: “The caller received a damaged gift.”

Bad: “The caller received a damaged gift during a previous call.”

## How to Add a New Supervisor Transfer Reason

1. Choose a stable, readable display label. Because the current data model stores labels, treat the normalized label as the stable key.
2. Add the label to `backend/defaults/sup-reasons.csv`, the in-code `SUP_REASONS` fallback in `backend/server.py`, `DEFAULT_SUP_REASONS`, and both administrator-package representations.
3. Add an explicit matching branch and complete scenario sentence to `getSupervisorReasonScenarioText()`; include reasonable legacy or configured-label aliases without changing other meanings.
4. Confirm the reason appears in the dropdown and survives draft save/restore. Review and History store the selected label as part of the transfer record, so avoid renaming an established label without a migration decision.
5. Add exact helper tests, a dropdown-rendering test, a Regenerate semantic-preservation test, and fallback-parity coverage.
6. Run the validation commands below and rebuild all affected artifacts.

## Use Own/Other Behavior

`Use Own/Other` is a dropdown choice. The current Supervisor Transfer page has no separate custom-reason input and does not store a custom reason field. Therefore the rendered fallback is:

> Tester’s chosen reason.

`getSupervisorReasonScenarioText()` accepts optional custom text so a future existing workflow value can be passed safely without changing the fallback. Until such a value is actually wired into the page, do not invent, persist, or display one and never use the raw label as a verb.

## How to Change Regular Call Scenarios

Make regular Call copy changes in `ScenarioCard` or its focused helpers in `frontend/src/pages/CallsPage.jsx`. Preserve the shared Call 1–3 behavior, the call-type classification, caller-category selection, donation rules, show data, and randomization unless the requirement explicitly changes them. If a data label changes, update the appropriate backend fallback and administrator-package mirror. Add focused coverage in `frontend/src/pages/CallsPage.test.jsx` and avoid routing regular Call text through the Supervisor Transfer helper.

## Packaging and Deployment

- A change only to React sentence logic or React tests requires `cd frontend` followed by `yarn build`. Installed users receive it only after the MTS and, where applicable, SAM/Notification Manager installers are rebuilt.
- A change to `backend/server.py` or `backend/defaults` requires the backend executable to be rebuilt before installers are rebuilt. The desktop package copies `backend/defaults` into the installed resources.
- A change only to administrator-package documentation requires redistributing that package; it does not change an already installed application.
- Configured reason labels, callers, call types, and shows can be managed through the existing remote content path. Remote content changes labels/data, not the frontend sentence algorithm.
- These scenario changes do not require Apps Script code changes or an Apps Script deployment.

Use the repository's normal sequential release order: frontend build, backend build if needed, then MTS installer and Notification Manager installer packaging. Do not run the two frontend-dependent package builds in parallel because they share the same frontend build output.

## Validation Checklist

- Select every Supervisor Transfer reason once and verify its grammar and meaning.
- Confirm only Hung Up On contains “during a previous call.”
- Confirm Use Own/Other displays “Tester’s chosen reason.” when no custom value exists.
- Verify the full caller name and caller first name.
- Click Regenerate and confirm demographic flags may change while the selected reason sentence does not.
- Verify the page at restored and maximized desktop window sizes without clipping or horizontal scrolling.
- Verify both the development renderer and a packaged build before release.
- Run the targeted test: `cd frontend && yarn test SupTransferPage.test.jsx --watchAll=false`.
- Run the normal frontend suite: `cd frontend && yarn test --watchAll=false`.
- Run the frontend build: `cd frontend && yarn build`.
- Run `git diff --check` from the repository root.
