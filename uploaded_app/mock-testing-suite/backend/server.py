"""
Mock Testing Suite — FastAPI Backend Server
Serves the REST API, starts the session auto-save timer,
and serves frontend static files from a single process.
"""
import os
import json
import uvicorn
from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from fastapi.middleware.cors import CORSMiddleware

import config
from services.session_manager import session_mgr
from services.ticker_service import ticker_svc
from services.update_checker import update_checker


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Startup and shutdown hooks."""
    # Ensure data files exist
    if not os.path.exists(config.SETTINGS_FILE):
        with open(config.SETTINGS_FILE, "w", encoding="utf-8") as f:
            json.dump(config.DEFAULT_SETTINGS, f, indent=2)
        print("[STARTUP] Created default settings.json")

    if not os.path.exists(config.HISTORY_FILE):
        with open(config.HISTORY_FILE, "w", encoding="utf-8") as f:
            json.dump([], f)
        print("[STARTUP] Created empty history.json")

    # Load settings for ticker + update URLs
    settings = {}
    try:
        with open(config.SETTINGS_FILE, "r", encoding="utf-8") as f:
            settings = json.load(f)
    except Exception:
        pass

    # Start session auto-save (60s)
    session_mgr.start_autosave()
    print("[STARTUP] Session auto-save started (60s)")

    # Start ticker polling from Google Doc (60s)
    ticker_svc.start_polling(doc_url=config.TICKER_DOC_URL, interval=60)
    print(f"[STARTUP] Ticker polling started (60s) — URL: {'configured' if config.TICKER_DOC_URL else 'none (using defaults)'}")

    # Check for updates on startup
    update_url = config.UPDATE_DOC_URL or settings.get("update_doc_url", "")
    if update_url:
        result = update_checker.check(update_url)
        if result.get("update_available"):
            print(f"[STARTUP] UPDATE AVAILABLE: {result.get('latest_version')} (current: {config.APP_VERSION})")
        else:
            print(f"[STARTUP] App is up to date (v{config.APP_VERSION})")
    else:
        print("[STARTUP] No update URL configured, skipping update check")

    print(f"[STARTUP] Mock Testing Suite v{config.APP_VERSION}")
    print(f"[STARTUP] Server ready at http://127.0.0.1:{config.API_PORT}")

    yield

    # Shutdown
    session_mgr.stop_autosave()
    session_mgr.save_draft()
    ticker_svc.stop_polling()
    print("[SHUTDOWN] Server stopped.")


# ── App ─────────────────────────────────────────────────────────
app = FastAPI(title=config.APP_TITLE, version=config.APP_VERSION, lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── Routes ──────────────────────────────────────────────────────
from routes.settings_routes import router as settings_router
from routes.session_routes import router as session_router
from routes.history_routes import router as history_router
from routes.ticker_routes import router as ticker_router
from routes.integration_routes import router as integration_router
from routes.update_routes import router as update_router

app.include_router(settings_router, prefix="/api/settings", tags=["Settings"])
app.include_router(session_router,  prefix="/api/session",  tags=["Session"])
app.include_router(history_router,  prefix="/api/history",  tags=["History"])
app.include_router(ticker_router,   prefix="/api/ticker",   tags=["Ticker"])
app.include_router(integration_router, prefix="/api", tags=["Integrations"])
app.include_router(update_router,   prefix="/api/update",   tags=["Update"])

# ── Static Files ────────────────────────────────────────────────
app.mount("/static", StaticFiles(directory=config.FRONTEND_DIR), name="static")


@app.get("/{full_path:path}")
async def serve_spa(full_path: str):
    file_path = os.path.join(config.FRONTEND_DIR, full_path)
    if os.path.isfile(file_path):
        return FileResponse(file_path)
    return FileResponse(os.path.join(config.FRONTEND_DIR, "index.html"))


if __name__ == "__main__":
    uvicorn.run("server:app", host="127.0.0.1", port=config.API_PORT, reload=True, log_level="info")
