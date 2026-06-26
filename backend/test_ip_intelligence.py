import asyncio
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))

import server  # noqa: E402


class MockIpProvider:
    reputation_capable = True

    def __init__(self, name, result=None, enabled=True, reason="", fails=False, reputation_capable=True):
        self.name = name
        self.result = result or {}
        self._enabled = enabled
        self.reason = reason
        self.fails = fails
        self.reputation_capable = reputation_capable

    def enabled(self):
        return self._enabled, self.reason

    async def lookup(self, ip_value):
        if self.fails:
            raise RuntimeError("provider unavailable")
        return server._normalize_ip_provider_result({
            "provider": self.name,
            "status": "ok" if self.reputation_capable else "metadata",
            "reputationCapable": self.reputation_capable,
            **self.result,
        })


def run_lookup(ip_value, providers):
    with mock.patch.object(server, "_configured_ip_intelligence_providers", return_value=providers):
        return asyncio.run(server._run_ip_intelligence_lookup(ip_value))


def clear_provider(name="clear-provider"):
    return MockIpProvider(name, {
        "vpnProxy": "No",
        "isp": "Residential ISP",
        "usageType": "Fixed Line ISP",
        "flags": {"residential": True},
    })


def risk_provider(name="risk-provider", **flags):
    resolved_flags = {"vpn": True, "active": True}
    resolved_flags.update(flags)
    return MockIpProvider(name, {
        "vpnProxy": "Yes",
        "isp": "Risk Network",
        "usageType": "VPN",
        "flags": resolved_flags,
    })


class IpIntelligenceTests(unittest.TestCase):
    def test_invalid_ip_rejected(self):
        result = run_lookup("not an ip", [clear_provider()])
        self.assertFalse(result["ok"])
        self.assertIn("valid IPv4 or IPv6", result["error"])

    def test_ipv4_clear_result(self):
        result = run_lookup("8.8.8.8", [clear_provider("provider-a"), clear_provider("provider-b")])
        self.assertTrue(result["ok"])
        self.assertEqual(result["verdict"], "CLEAR")
        self.assertEqual(result["level"], "green")
        self.assertFalse(result["autoFail"])

    def test_ipv6_clear_result(self):
        result = run_lookup("2001:4860:4860::8888", [clear_provider("provider-a")])
        self.assertTrue(result["ok"])
        self.assertEqual(result["ip"], "2001:4860:4860::8888")
        self.assertEqual(result["verdict"], "CLEAR")

    def test_one_provider_failure_does_not_stop_lookup(self):
        result = run_lookup("8.8.4.4", [
            MockIpProvider("down-provider", fails=True),
            clear_provider("clear-provider"),
        ])
        self.assertTrue(result["ok"])
        self.assertEqual(result["verdict"], "CLEAR")
        self.assertEqual(result["providerResults"][0]["status"], "failed")

    def test_no_reputation_provider_available_is_unable_to_verify(self):
        result = run_lookup("8.8.8.8", [
            MockIpProvider("skipped-provider", enabled=False, reason="missing API key"),
            MockIpProvider("down-provider", fails=True),
        ])
        self.assertTrue(result["ok"])
        self.assertEqual(result["verdict"], "UNABLE TO VERIFY")
        self.assertEqual(result["level"], "gray")
        self.assertEqual(result["summary"], "No IP reputation provider is currently available. Manual verification required.")

    def test_metadata_only_provider_is_unable_to_verify(self):
        result = run_lookup("8.8.8.8", [
            MockIpProvider("metadata-provider", {
                "vpnProxy": "Unknown",
                "flags": {"hosting": True},
                "notes": "Metadata only.",
            }, reputation_capable=False),
        ])
        self.assertTrue(result["ok"])
        self.assertEqual(result["verdict"], "UNABLE TO VERIFY")
        self.assertEqual(result["level"], "gray")

    def test_one_risk_provider_is_review(self):
        result = run_lookup("8.8.8.8", [risk_provider("risk-provider"), clear_provider("clear-provider")])
        self.assertEqual(result["verdict"], "REVIEW")
        self.assertEqual(result["level"], "yellow")

    def test_two_independent_risks_are_red(self):
        result = run_lookup("8.8.8.8", [
            risk_provider("vpn-provider", vpn=True),
            risk_provider("hosting-provider", vpn=False, hosting=True, datacenter=True, active=True),
        ])
        self.assertEqual(result["verdict"], "VPN / PROXY LIKELY")
        self.assertEqual(result["level"], "red")

    def test_historical_residential_proxy_is_review_not_vpn_likely(self):
        result = run_lookup("8.8.8.8", [
            MockIpProvider("ip2proxy", {
                "vpnProxy": "Yes",
                "lastSeen": "2026-06-20T00:00:00+00:00",
                "usageType": "Fixed Line ISP",
                "flags": {
                    "proxy": True,
                    "historical": True,
                    "residential": True,
                },
            }),
        ])
        self.assertEqual(result["verdict"], "REVIEW")
        self.assertEqual(result["level"], "yellow")
        self.assertIn("historical proxy activity", result["summary"])


if __name__ == "__main__":
    unittest.main()
