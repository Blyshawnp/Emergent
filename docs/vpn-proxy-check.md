# VPN / Proxy Check mode

The VPN / Proxy Check feature is controlled by the app setting:

```json
{
  "vpnProxyCheckMode": "checker"
}
```

Default location:

```text
backend/server.py
DEFAULT_SETTINGS["vpnProxyCheckMode"]
```

The setting is also returned by `/api/settings`, so a saved app setting can override the default without deleting any code. If runtime settings are available, update the saved setting through the normal settings API or settings storage. Otherwise, change the default above and restart the app.

Runtime settings payload:

```json
{
  "vpnProxyCheckMode": "links"
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

Detector providers are used only when available or configured. Providers that need keys are optional and are skipped when the key is missing. Do not store API keys in source control.

Metadata-only providers, such as `ipapi.co` or IPinfo responses without privacy fields, can show ISP, ASN, and location details, but they do not determine VPN/proxy verdicts.

### links

Restores manual lookup behavior.

The Basics screen shows external lookup buttons for:

```text
IP2Location
IPinfo
ip.teoh.io
```

This mode does not call the built-in provider API and does not create automated CLEAR, REVIEW, or VPN / PROXY LIKELY verdicts.

To switch to manual links mode, save this setting or change the default:

```json
{
  "vpnProxyCheckMode": "links"
}
```

Copy/paste default-code change:

```python
DEFAULT_SETTINGS["vpnProxyCheckMode"] = "links"
```

### disabled

Hides built-in provider lookup UI and shows:

```text
Built-in VPN / Proxy Check is disabled. Use manual verification if needed.
```

To fully hide provider lookups, save this setting or change the default:

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
