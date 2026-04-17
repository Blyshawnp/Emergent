# Mock Testing Suite v3.0 — PRD

## Original Problem Statement
User uploaded an Electron-based Mock Testing Suite app (FastAPI + vanilla HTML/CSS/JS) that needed to be adapted to work on the Emergent web platform. Requirements:
- All screens working (Setup, Home, Basics, Calls, Sup Transfer, Newbie Shift, Review, History, Settings, Help)
- Tech Issues button with full workflow
- Fix Review screen, Settings screen, Setup wizard

## Architecture
- **Backend**: FastAPI (Python) on port 8001 with MongoDB storage
- **Frontend**: React SPA on port 3000
- **Database**: MongoDB (settings, sessions, history collections)
- **Routing**: React state-based routing (no hash), sidebar navigation

## User Personas
- **Mock Testers**: Staff who conduct mock call testing sessions with candidates
- **Candidates**: People being tested on their call center skills

## Core Requirements (Static)
1. Setup wizard on first run (name, URLs, power-ups info)
2. Session flow: Basics → Calls (up to 3) → Sup Transfers (up to 2) → Review
3. Tech Issues button available on every session screen with branching workflows
4. Settings with tabs: General, Gemini AI, Google Sheets, Calendar, Discord, Payment
5. Session history with stats, search, and detail view
6. Help with Instructions, FAQ, Integrations, Troubleshooting
7. Auto-fail scenarios (NC/NS, Stopped Responding, headset/VPN issues)
8. Summary generation (coaching + fail) from checkbox data

## What's Been Implemented (April 2026)
- Full FastAPI backend with MongoDB (settings, session, history, ticker, summaries, finish-session)
- React frontend with all 10 pages (Setup, Home, Basics, Calls, SupTransfer, NewbieShift, Review, History, Settings, Help)
- Tech Issues dialog with full workflow:
  - Internet speed test (25 Mbps down / 10 Mbps up threshold)
  - Calls won't route → DTE status check → Browser troubleshooting
  - No script pop → Browser troubleshooting
  - Discord/Other issues with resolution tracking
- Setup wizard (3-step: Name → URLs → Power-ups)
- Review screen with coaching/fail summaries, Copy, Regenerate, Fill Form, Save & Finish
- Settings with all 6 tabs, Discord template management, theme toggle
- History with stats, search, table, detail modal
- Sidebar navigation, ticker bar, Discord post popup
- Dark/Light theme support

### Settings Page Complete Rebuild (April 2026)
- 10 tabs: General, Shows, Call Types, Callers, Sup Reasons, Discord, Payment, Gemini AI, Google Sheets, Calendar
- Shows: Editable table with Name, One-Time, Monthly, Gift + Add/Remove/Reset
- Call Types: Editable list with "Use Own/Custom" always appended
- Callers: Advanced table with 3 category sub-tabs (New Donors, Existing Members, Increase Sustaining) + state dropdowns
- Sup Reasons: Editable list with "Use Own/Other" always appended
- Discord: 15 trigger/message pairs with add/remove
- General: Ticker Doc URL, Auto-Updater Doc URL placeholders
- All data persisted to MongoDB via Save Settings

### UX Improvements (April 2026)
- Buzz sound on auto-fail buttons (NC/NS, Stopped Responding, Not Ready) via Web Audio API
- Tooltips on all interactive buttons with descriptive hover text
- Sidebar: Sheets link conditionally hidden when Google Sheets disabled
- Newbie Shift: Time input auto-formats with colon (H:MM), helper text
- Google Calendar events titled "Supervisor Test Call - [First Name Last Initial]"
- Right-click copy/paste enabled on all form fields
- Real data from default_data.py (shows, callers, call types, discord templates)

### Scenario & UI Improvements (April 2026 - Iteration 3)
- Sidebar: Colorful emoji icons for all nav items, styled action buttons (Discord Post purple, Cert Spreadsheet gray, Sheets green conditional)
- Call Scenario Card: Dynamic with caller demographics, randomized Phone Type (Mobile/Landline), SMS Opt-In (Mobile only), E-Newsletter, $6 Shipping, CC Processing Fee (non-one-time only), Regenerate button
- Sup Transfer Scenario: Fixed grammar ("was hung up on" not "was wants to cancel"), added randomized variables
- Pronouns: "Optional — for accurate summaries" helper text
- Discord Post popup: Searchable with filter input
- Sound effects: Error tone on auto-fail buttons, tada on form fill
- Settings: Removed Google Docs Integration fields, added Gemini AI prompt editors (coaching + fail prompts) when enabled
- Google Docs ticker/updater URLs kept as code-only placeholders in backend

- **XSS**: All `dangerouslySetInnerHTML` uses sanitized via DOMPurify; `innerHTML` replaced with safe DOM methods
- **Hook Dependencies**: All `useEffect`/`useCallback`/`useMemo` hooks have complete dependency arrays; cancellation tokens for async effects
- **Component Complexity**: TechIssueDialog split into 13 focused sub-components; CallsPage business logic extracted into helper functions; App routing extracted into PageRouter component
- **Backend Complexity**: `build_clean_fail` / `build_clean_coaching` / `generate_summaries` refactored into small helpers with early returns and guard clauses
- **Silent Error Handling**: All empty `catch {}` blocks replaced with descriptive comments explaining why silence is intentional
- **Console Statements**: All `console.error` in production paths removed or replaced with silent handling

### Iteration 4 Fixes (April 2026)
- ACD logo: Integrated in sidebar (replaces MTS text) and home page center
- Home page: Styled action buttons (blue Start, green Sup Transfer, gray History) with emoji icons
- Basics: Headset section vertically stacked (matches screenshot reference)
- Calls: Coaching validation popup ("No coaching selected. Continue anyway?"), scroll-to-top on next call, fail reason required for Fail result
- Sup Transfer: Same coaching validation + scroll-to-top on next transfer
- Settings: Tabs reordered — config tabs first (General, Gemini, Sheets, Calendar, Payment), data tabs last (Call Types, Shows, Callers, Sup Reasons, Discord)
- App responsive at 1280x800 (non-fullscreen friendly)
- Favicon and logo assets integrated

### Iteration 5 - v2.5.0 Release (April 2026)
- Version updated to 2.5.0 throughout the app
- Home page compact layout — no scrolling needed, all buttons/stats/recent sessions fit
- Ticker: Live content fetched from Google Doc (https://docs.google.com/document/d/1kRJMSd-...), numbered lines stripped, falls back to defaults if unreachable
- Discord Post popup: Templates + Screenshots tabs with search, copy-to-clipboard for images
- Discord Screenshots: Welcome New Agent + Welcome to Stars images, fully editable in Settings
- Scenario Card: Bullet-format with Thank You Gift description from show data
- Help page: 5 comprehensive tabs (How to Use, Session Flows, Integration Setup, FAQ, Support)
- Support tab: Send Email (blyshawnp@gmail.com) and Discord (shawnbly) buttons
- Integration Setup: Step-by-step Gemini AI and Google Sheets setup guides
- Default URLs: Cert form + cert sheet pre-filled from production values
- Backend auto-updater Google Doc URL configured in code (developer-only)

## Integrations Status
- **Gemini AI**: Placeholder ready (enable in Settings → Gemini, requires API key)
- **Google Sheets**: Placeholder ready (enable in Settings → Google Sheet)
- **Google Calendar**: Working via URL template (no API needed)
- **Form Filler**: Web version shows copy guidance (desktop-only feature)

## Prioritized Backlog
### P0 (Critical)
- None — all core features working

### P1 (Important)
- Gemini AI actual API integration for professional summary rewriting
- Google Sheets backup integration with header row locking
- Sup Transfer Only flow (search history, autofill basics)
- Form field mapping for Cert Test Call Results Form (12 fields mapped)

### P2 (Nice to Have)
- Visual tutorial with screenshots overlay
- Session draft auto-recovery
- Export session history as CSV

## Next Tasks
1. User testing of full session flow
2. Gemini AI integration (if user provides API key)
3. Google Sheets integration (if user provides service account)
4. Polish UI animations and transitions
