import os
import sys
import logging

import uvicorn

def main():
    logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(name)s - %(levelname)s - %(message)s')
    logger = logging.getLogger("packaged-backend")

    try:
        from server import app
    except Exception as exc:
        logger.error("Backend startup failed before the API could initialize: %s", exc)
        print(f"Backend startup failed before the API could initialize: {exc}", file=sys.stderr)
        raise SystemExit(1) from None

    port = int(os.getenv("BACKEND_PORT", "8600") or "8600")

    try:
        uvicorn.run(app, host="127.0.0.1", port=port, log_level="warning")
    except Exception as exc:
        logger.error("Backend server failed to start: %s", exc)
        print(f"Backend server failed to start: {exc}", file=sys.stderr)
        raise SystemExit(1) from None


if __name__ == "__main__":
    main()
