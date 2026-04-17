# Mock Testing Suite v3.0 — Project Structure

## Architecture

```
Electron (shell)  →  loads http://127.0.0.1:8600
                         ↓
                   FastAPI (Python backend)
                     ├── serves frontend static files
                     ├── /api/session/*     session CRUD
                     ├── /api/settings/*    QSettings replacement (JSON file)
                     ├── /api/history/*     session history
                     ├── /api/gemini/*      AI summary generation
                     ├── /api/sheets/*      Google Sheets integration
                     ├── /api/calendar/*    Google Calendar integration
                     └── /api/form/*        Selenium form-filler
```

## Folder Structure

```
mock-testing-suite/
│
├── backend/                        # Python FastAPI server
│   ├── server.py                   # FastAPI entry point + static file mount
│   ├── config.py                   # Constants, file paths, defaults
│   ├── models/
│   │   ├── __init__.py
│   │   ├── session.py              # Session data model (Pydantic)
│   │   └── settings.py             # Settings data model (Pydantic)
│   ├── services/
│   │   ├── __init__.py
│   │   ├── session_manager.py      # Session state, auto-save, draft
│   │   ├── settings_manager.py     # Read/write settings JSON (replaces QSettings)
│   │   ├── history_manager.py      # Session history read/write/clear
│   │   ├── gemini_service.py       # Gemini AI summary generation
│   │   ├── sheets_service.py       # Google Sheets backup
│   │   ├── calendar_service.py     # Google Calendar events
│   │   └── form_filler.py          # Selenium browser automation
│   ├── routes/
│   │   ├── __init__.py
│   │   ├── session_routes.py       # /api/session/*
│   │   ├── settings_routes.py      # /api/settings/*
│   │   ├── history_routes.py       # /api/history/*
│   │   ├── gemini_routes.py        # /api/gemini/*
│   │   └── integration_routes.py   # /api/sheets/*, /api/calendar/*, /api/form/*
│   └── requirements.txt
│
├── frontend/                       # Vanilla HTML/CSS/JS SPA
│   ├── index.html                  # App shell — sidebar + content container
│   ├── css/
│   │   ├── variables.css           # CSS custom properties (colors, fonts, spacing)
│   │   ├── base.css                # Resets, body, typography, scrollbar
│   │   ├── layout.css              # Sidebar, content area, footer
│   │   ├── components.css          # Cards, buttons, checkboxes, inputs, badges
│   │   └── pages.css               # Screen-specific overrides
│   ├── js/
│   │   ├── app.js                  # SPA router, init, theme toggle
│   │   ├── api.js                  # Fetch wrapper for all backend calls
│   │   ├── state.js                # Client-side session state cache
│   │   ├── router.js               # Hash-based SPA navigation
│   │   └── pages/
│   │       ├── home.js             # Home screen renderer
│   │       ├── basics.js           # The Basics screen
│   │       ├── calls.js            # Mock Calls screen
│   │       ├── supTransfer.js      # Supervisor Transfer screen
│   │       ├── newbieShift.js      # Newbie Shift scheduling
│   │       ├── review.js           # Review & Summary screen
│   │       ├── history.js          # Session History screen
│   │       ├── settings.js         # Settings screen (tabbed)
│   │       └── help.js             # Help & Documentation
│   ├── components/
│   │   ├── sidebar.js              # Sidebar builder
│   │   ├── footer.js               # Reusable footer bar
│   │   ├── modal.js                # Modal/dialog system
│   │   ├── toast.js                # Toast notifications
│   │   └── checkboxGroup.js        # Coaching/fail checkbox builder
│   ├── pages/                      # HTML partials (loaded by router)
│   │   ├── home.html
│   │   ├── basics.html
│   │   ├── calls.html
│   │   ├── supTransfer.html
│   │   ├── newbieShift.html
│   │   ├── review.html
│   │   ├── history.html
│   │   ├── settings.html
│   │   └── help.html
│   └── assets/
│       ├── favicon.ico
│       └── logo.png
│
├── electron/
│   ├── main.js                     # Electron main process
│   ├── preload.js                  # Context bridge (optional)
│   └── package.json                # Electron dependencies
│
├── data/                           # Runtime data (git-ignored)
│   ├── settings.json               # User settings
│   ├── history.json                # Session history
│   └── current_draft.json          # Auto-save draft
│
├── start.py                        # Launch script: starts FastAPI → opens Electron
├── package.json                    # Root package.json (scripts: dev, build)
└── README.md
```

## Communication Pattern

```
Frontend (JS)                          Backend (Python)
─────────────                          ────────────────
api.getSettings()        ──GET──→      /api/settings
api.saveSettings(data)   ──PUT──→      /api/settings
api.startSession(data)   ──POST──→     /api/session/start
api.saveCallData(data)   ──POST──→     /api/session/call
api.getSessionState()    ──GET──→      /api/session/current
api.generateSummary()    ──POST──→     /api/gemini/coaching
api.fillForm(data)       ──POST──→     /api/form/fill
```

All communication is standard HTTP via `fetch()`. No WebSocket needed.
The backend is the single source of truth for all state.
