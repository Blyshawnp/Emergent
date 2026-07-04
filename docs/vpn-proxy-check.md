# VPN / Proxy Check mode

The VPN / Proxy Check feature is controlled by the app setting:

```json
{
  "vpnProxyCheckMode": "links"
}
```

Default location:

```text
backend/server.py
DEFAULT_SETTINGS["vpnProxyCheckMode"]
```

The setting is also returned by `/api/settings`, and the desktop Settings screen exposes it under:

```text
Settings -> General -> VPN / Proxy Check
```

A saved app setting can override the default without deleting any code. Older hidden `checker` values are treated as manual links unless the administrator re-saves Integrated provider check from Settings. This prevents stale development settings from silently forcing the integrated checker.

Runtime settings payload:

```json
{
  "vpnProxyCheckMode": "checker"
}
```

## Modes

Use one of these values:

```text
checker
links
disabled
```

### checker

Runs the built-in VPN / Proxy Check panel and backend provider lookup.

This is an **optional administrator-enabled behavior**.

Detector providers are used only when available or configured. Providers that need keys are optional and are skipped when the key is missing. Do not store API keys in source control.

#### Supported Providers

**Free/No-Key Providers (Run automatically without setup):**
- **GetIPIntel** if enabled by the backend provider list
- **ipapi.co** (Metadata only, no proxy reputation)
- **ipwho.is** (Metadata only, no proxy reputation)

**Optional Key-Required Providers (Require API key in env or runtime_config.json):**
- **vpnapi.io** (Requires `VPNAPI_IO_KEY`)
- **IPinfo privacy fields** (Requires `IPINFO_TOKEN`)
- **IP2Location/IP2Proxy** (Requires `IP2PROXY_API_KEY`)
- **IPQualityScore** (Requires `IPQUALITYSCORE_KEY`)
- **AbuseIPDB** (Requires `ABUSEIPDB_API_KEY`)
- **ProxyCheck** (Optional `PROXYCHECK_IO_KEY`; can run without a key subject to provider limits)
- **IPHub** (Requires `IPHUB_API_KEY`)
- **Scamalytics** (Requires `SCAMALYTICS_USERNAME` and `SCAMALYTICS_API_KEY`)

Do not use or add `ip-api.com` for candidate IP verification. Its free endpoint is HTTP-only.

#### Verdict Language

The system computes a consensus verdict based on all successful responses:

- **CLEAR**: No providers detected VPN, proxy, hosting, or datacenter usage. (Requires at least 2 successful detector responses).
- **CLEAR — LIMITED CHECK**: No providers detected risk, but only 1 detector provider responded. Verifying manually is recommended. Displays in amber/yellow styling.
- **REVIEW**: Exactly 1 provider detected risk, OR a provider detected historical proxy activity on a residential ISP.
- **MIXED SIGNAL — VERIFY MANUALLY**: Providers disagreed (at least one detected risk and at least one did not). Manual verification is required.
- **VPN / PROXY LIKELY**: 2 or more providers detected active risk.

### links

Restores legacy manual IP lookup behavior. This is the **default release-safe mode**.

The Basics screen shows external lookup buttons for:

```text
GetIPIntel
IPQualityScore
proxycheck.io
IP2Location
```

This mode does not call the built-in provider API and does not create automated CLEAR, REVIEW, or VPN / PROXY LIKELY verdicts.

**Why is this the default?**
Integrated automated VPN checks require configured provider keys. To ensure security, **API keys should not be embedded in the installer or source code**. Provider keys should be configured externally only if administrators explicitly choose to enable integrated mode. Until then, manual lookup links are the safest and most reliable default.

To switch back to integrated automated checks, an administrator can use Settings:

```text
Settings -> General -> VPN / Proxy Check -> Integrated provider check -> Save Settings
```

Or save this runtime setting:

```json
{
  "vpnProxyCheckMode": "checker"
}
```

Copy/paste default-code change to explicitly enforce manual mode (the current default):

```python
DEFAULT_SETTINGS["vpnProxyCheckMode"] = "links"
```

Use this mode when administrators want to avoid integrated VPN lookups without removing the VPN questions or the manual VPN autofail flow.

### disabled

Hides built-in provider lookup UI and shows:

```text
Built-in VPN / Proxy Check is disabled. Use manual verification if needed.
```

To fully hide provider lookups, use Settings:

```text
Settings -> General -> VPN / Proxy Check -> Disabled message only -> Save Settings
```

Or save this setting or change the default:

```json
{
  "vpnProxyCheckMode": "disabled"
}
```

Copy/paste default-code change:

```python
DEFAULT_SETTINGS["vpnProxyCheckMode"] = "disabled"
```

## VPN autofail behavior

The mode setting does not change the original VPN questions or autofail flow.

The tester can still answer:

```text
Has VPN?
Can turn off?
```

If the candidate cannot disable VPN/proxy, the existing VPN autofail flow is still used, including the existing Review summary, Gemini/fallback summary behavior, and Microsoft form/Selenium autofail mapping.

## What not to touch

Do not change these systems when switching VPN modes:

```text
Selenium form fill mapping
Microsoft Forms field names
VPN autofail reason mapping
Google Sheets credentials or service-account files
Provider API keys
```
