import os
import sys
import logging
import time

import uvicorn

def main():
    started_at = time.perf_counter()
    logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(name)s - %(levelname)s - %(message)s')
    logger = logging.getLogger("packaged-backend")

    try:
        logger.info("[STARTUP] packaged backend import start")
        from server import app
        logger.info("[STARTUP] packaged backend import finish duration_ms=%d", int((time.perf_counter() - started_at) * 1000))
    except Exception as exc:
        logger.error("Backend startup failed before the API could initialize: %s", exc)
        print(f"Backend startup failed before the API could initialize: {exc}", file=sys.stderr)
        raise SystemExit(1) from None

    port = int(os.getenv("BACKEND_PORT", "8600") or "8600")

    try:
        logger.info("[STARTUP] packaged backend uvicorn start port=%s", port)
        uvicorn.run(app, host="127.0.0.1", port=port, log_level="warning", log_config=None, access_log=False)
    except Exception as exc:
        logger.error("Backend server failed to start: %s", exc)
        print(f"Backend server failed to start: {exc}", file=sys.stderr)
        raise SystemExit(1) from None


if __name__ == "__main__":
    main()
