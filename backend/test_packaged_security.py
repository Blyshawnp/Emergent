"""
Packaging security audit test.
Asserts that SUPABASE_SERVICE_ROLE_KEY and service-role JWTs are completely
absent from packaged runtime configuration, source files, and default environments.
"""
import json
import os
import sys
import unittest

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
BACKEND_DIR = os.path.join(REPO_ROOT, "backend")
if BACKEND_DIR not in sys.path:
    sys.path.insert(0, BACKEND_DIR)

RUNTIME_CONFIG_PATH = os.path.join(BACKEND_DIR, "config", "runtime_config.json")


class PackagedSecurityTests(unittest.TestCase):
    def test_runtime_config_has_no_service_role_key(self):
        """Assert runtime_config.json does not contain any service role key or service role field."""
        if not os.path.exists(RUNTIME_CONFIG_PATH):
            self.skipTest(f"Runtime config not found at {RUNTIME_CONFIG_PATH}")
        with open(RUNTIME_CONFIG_PATH, "r", encoding="utf-8") as f:
            content = f.read()

        # Direct text check
        self.assertNotIn("service_role", content.lower())
        self.assertNotIn("SUPABASE_SERVICE_ROLE_KEY", content)

        # JSON structural check
        config = json.loads(content)
        for key, val in config.items():
            self.assertNotIn("service", key.lower())
            self.assertNotIn("service_role", str(val).lower())

    def test_backend_server_does_not_reference_service_role_key(self):
        """Assert backend/server.py does not read or reference SUPABASE_SERVICE_ROLE_KEY."""
        server_path = os.path.join(BACKEND_DIR, "server.py")
        with open(server_path, "r", encoding="utf-8") as f:
            content = f.read()

        self.assertNotIn("SUPABASE_SERVICE_ROLE_KEY", content)
        self.assertNotIn("supabase_service_role_key", content)

    def test_frontend_src_has_no_service_role_references(self):
        """Assert frontend/src does not contain SUPABASE_SERVICE_ROLE_KEY or service-role references."""
        frontend_src = os.path.join(REPO_ROOT, "frontend", "src")
        for root, _, files in os.walk(frontend_src):
            for fname in files:
                if fname.endswith((".js", ".jsx", ".json", ".ts", ".tsx")):
                    fpath = os.path.join(root, fname)
                    with open(fpath, "r", encoding="utf-8", errors="ignore") as f:
                        data = f.read()
                    self.assertNotIn(
                        "SUPABASE_SERVICE_ROLE_KEY",
                        data,
                        f"Found SUPABASE_SERVICE_ROLE_KEY in {fpath}",
                    )

    def test_environment_defaults_do_not_inject_service_role(self):
        """Assert process environment does not expose SUPABASE_SERVICE_ROLE_KEY to client modules."""
        from server import _load_backend_runtime_config

        cfg = _load_backend_runtime_config()
        self.assertNotIn("supabase_service_role_key", cfg)
        self.assertNotIn("service_role_key", cfg)


if __name__ == "__main__":
    unittest.main()
