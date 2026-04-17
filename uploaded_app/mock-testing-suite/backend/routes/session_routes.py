"""Session API routes — backed by the SessionManager singleton."""
from fastapi import APIRouter
from services.session_manager import session_mgr

router = APIRouter()


@router.get("/current")
async def get_current():
    """Return the active session, trying to load draft if nothing in memory."""
    if not session_mgr.current:
        session_mgr.load_draft()
    return {"session": session_mgr.current, "has_active": session_mgr.has_active}


@router.post("/start")
async def start(payload: dict):
    session = session_mgr.start(payload)
    return {"ok": True, "session": session}


@router.put("/update")
async def update(payload: dict):
    session = session_mgr.update(payload)
    return {"ok": True, "session": session}


@router.post("/call")
async def save_call(payload: dict):
    session_mgr.save_call(payload)
    return {"ok": True}


@router.post("/sup")
async def save_sup(payload: dict):
    session_mgr.save_sup(payload)
    return {"ok": True}


@router.post("/finish")
async def finish():
    record = session_mgr.finish()
    return {"ok": True, "record": record}


@router.post("/discard")
async def discard():
    session_mgr.discard()
    return {"ok": True}
