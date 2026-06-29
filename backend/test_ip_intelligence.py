import asyncio
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))

import server  # noqa: E402


class MockIpProvider:
    reputation_capable = True
    capability = "vpn_proxy_detector"

    def __init__(self, name, result=None, enabled=True, reason="", fails=False, reputation_capable=True, capability=None):
        self.name = name
        self.result = result or {}
        self._enabled = enabled
        self.reason = reason
        self.fails = fails
        self.reputation_capable = reputation_capable
        self.capability = capability or ("vpn_proxy_detector" if reputation_capable else "metadata_only")

    def enabled(self):
        return self._enabled, self.reason

    async def lookup(self, ip_value):
        if self.fails:
            raise RuntimeError("provider unavailable")
        return server._normalize_ip_provider_result({
            "provider": self.name,
            "status": "ok" if self.reputation_capable else "metadata",
            "reputationCapable": self.reputation_capable,
            "capability": self.capability,
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
        "confidence": "Medium",
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
        self.assertEqual(result["detectorProviderCount"], 2)
        self.assertEqual(result["metadataProviderCount"], 0)
        self.assertEqual(result["confidence"], "High")
        self.assertFalse(result["autoFail"])

    def test_ipv6_clear_result(self):
        result = run_lookup("2001:4860:4860::8888", [clear_provider("provider-a")])
        self.assertTrue(result["ok"])
        self.assertEqual(result["ip"], "2001:4860:4860::8888")
        self.assertEqual(result["verdict"], "CLEAR")
        self.assertEqual(
            result["warning"],
            "Only one VPN/proxy detector is currently available. Verify manually if this result is important.",
        )
        self.assertEqual(result["detectorProviderCount"], 1)
        self.assertEqual(result["metadataProviderCount"], 0)
        self.assertEqual(result["confidence"], "Medium")

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
        self.assertEqual(result["summary"], "No VPN/proxy reputation provider available. Manual verification required.")
        self.assertEqual(result["detectorProviderCount"], 0)
        self.assertEqual(result["metadataProviderCount"], 0)
        self.assertEqual(result["confidence"], "Unknown")

    def test_metadata_only_provider_is_unable_to_verify(self):
        result = run_lookup("8.8.8.8", [
            MockIpProvider("metadata-provider", {
                "vpnProxy": "Unknown",
                "flags": {"hosting": True},
                "notes": "Metadata only.",
            }, reputation_capable=False, capability="metadata_only"),
        ])
        self.assertTrue(result["ok"])
        self.assertEqual(result["verdict"], "UNABLE TO VERIFY")
        self.assertEqual(result["level"], "gray")
        self.assertEqual(result["detectorProviderCount"], 0)
        self.assertEqual(result["metadataProviderCount"], 1)
        self.assertEqual(result["confidence"], "Unknown")

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
        self.assertEqual(result["lastSeen"], "2026-06-20T00:00:00+00:00")

    def test_stale_last_seen_is_review_not_vpn_likely(self):
        result = run_lookup("8.8.8.8", [
            MockIpProvider("stale-detector", {
                "vpnProxy": "Yes",
                "lastSeen": "2026-06-20T00:00:00+00:00",
                "usageType": "VPN",
                "flags": {
                    "vpn": True,
                    "active": True,
                },
            }),
        ])
        self.assertEqual(result["verdict"], "REVIEW")
        self.assertEqual(result["level"], "yellow")
        self.assertIn("stale or historical", result["summary"])

    def test_metadata_only_provider_cannot_produce_red(self):
        result = run_lookup("8.8.8.8", [
            MockIpProvider("metadata-provider", {
                "vpnProxy": "Yes",
                "usageType": "Datacenter Hosting",
                "flags": {"hosting": True, "datacenter": True, "active": True},
            }, reputation_capable=False, capability="metadata_only"),
        ])
        self.assertEqual(result["verdict"], "UNABLE TO VERIFY")
        self.assertEqual(result["providerResults"][0]["capability"], "metadata_only")

    def test_single_active_hosting_vpn_signal_is_likely(self):
        result = run_lookup("8.8.8.8", [
            risk_provider("vpn-hosting-provider", vpn=True, hosting=True, datacenter=True, active=True),
        ])
        self.assertEqual(result["verdict"], "VPN / PROXY LIKELY")

    def test_single_strong_current_vpn_signal_is_likely(self):
        result = run_lookup("8.8.8.8", [
            MockIpProvider("strong-vpn-provider", {
                "vpnProxy": "Yes",
                "usageType": "VPN",
                "confidence": "High",
                "flags": {"vpn": True, "active": True},
            }),
        ])
        self.assertEqual(result["verdict"], "VPN / PROXY LIKELY")

    def test_ipinfo_without_privacy_fields_is_metadata_only(self):
        provider = server.IPinfoProvider()
        with mock.patch.object(provider, "api_key", return_value="token"):
            with mock.patch("server.httpx.AsyncClient") as client_cls:
                response = mock.Mock()
                response.json.return_value = {
                    "org": "AS123 Example Datacenter",
                    "company": {"type": "hosting", "name": "Example Hosting"},
                    "asn": {"asn": "AS123", "type": "hosting", "name": "Example Hosting"},
                }
                response.raise_for_status.return_value = None
                client_cls.return_value.__aenter__.return_value.get = mock.AsyncMock(return_value=response)
                result = asyncio.run(provider.lookup("8.8.8.8"))
        self.assertEqual(result["status"], "metadata")
        self.assertEqual(result["capability"], "metadata_only")
        self.assertFalse(result["reputationCapable"])
        self.assertEqual(result["vpnProxy"], "Unknown")
        self.assertFalse(server._ip_result_has_risk(result))

    def test_optional_detector_providers_are_registered_and_key_gated(self):
        providers = server._configured_ip_intelligence_providers()
        names = {provider.name for provider in providers}
        self.assertIn("IPHub", names)
        self.assertIn("Scamalytics", names)
        iphub = next(provider for provider in providers if provider.name == "IPHub")
        scamalytics = next(provider for provider in providers if provider.name == "Scamalytics")
        with mock.patch.dict(server.os.environ, {
            "IPHUB_API_KEY": "",
            "SCAMALYTICS_USERNAME": "",
            "SCAMALYTICS_API_KEY": "",
        }, clear=False):
            self.assertEqual(iphub.enabled(), (False, "missing_api_key"))
            self.assertEqual(scamalytics.enabled(), (False, "missing_api_key"))

    def test_iphub_provider_normalizes_detector_result(self):
        provider = server.IPHubProvider()
        with mock.patch.object(provider, "api_key", return_value="key"):
            with mock.patch("server.httpx.AsyncClient") as client_cls:
                response = mock.Mock()
                response.json.return_value = {
                    "block": 1,
                    "isp": "Example Hosting",
                    "asn": 12345,
                    "countryName": "United States",
                }
                response.raise_for_status.return_value = None
                client_cls.return_value.__aenter__.return_value.get = mock.AsyncMock(return_value=response)
                result = asyncio.run(provider.lookup("8.8.8.8"))
        self.assertEqual(result["provider"], "IPHub")
        self.assertEqual(result["capability"], "vpn_proxy_detector")
        self.assertEqual(result["vpnProxy"], "Yes")
        self.assertTrue(server._ip_result_has_risk(result))

    def test_settings_normalize_vpn_proxy_check_mode(self):
        self.assertEqual(server.sanitize_settings({"vpnProxyCheckMode": "links"})["vpnProxyCheckMode"], "links")
        self.assertEqual(server.sanitize_settings({"vpnProxyCheckMode": "disabled"})["vpnProxyCheckMode"], "disabled")
        self.assertEqual(server.sanitize_settings({"vpnProxyCheckMode": "bad"})["vpnProxyCheckMode"], "checker")


if __name__ == "__main__":
    unittest.main()
