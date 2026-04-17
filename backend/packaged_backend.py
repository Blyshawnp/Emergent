import os

import uvicorn

from server import app


def main():
    port = int(os.environ.get("BACKEND_PORT", "8600"))
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="warning")


if __name__ == "__main__":
    main()
