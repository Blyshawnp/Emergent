# Release Checklist

Use this checklist before shipping a new MTS / SAM desktop app build.

## Pre-flight
- [ ] Tests pass (`npm test` / relevant suite green)
- [ ] Build completes (`npm run build`)
- [ ] No `google-service-account.json` or other secrets are added to git
- [ ] `docs/vpn-proxy-check.md` documents any known provider limitations and HTTP/HTTPS risks
- [ ] `docs/help` or Help/FAQ covers: limited-check mode, manual VPN lookup, headset-not-listed guidance, shared-data outage fallback

## Backend hardening
- [ ] CORS origin list does not include bare `null`
- [ ] Config-status and diagnostics endpoints do not leak filesystem paths
- [ ] Localhost diagnostic auth cannot bypass production restrictions
- [ ] Chromium/form-selenium inputs are validated before use
- [ ] Managed settings writes handle empty/$unset safely (no default bounce)
- [ ] VPN/proxy external providers use HTTPS or explicitly document HTTP risk/retention
- [ ] Gemini / external API keys are provided as env-managed config, not baked into the build
- [ ] SQLite recovery path does not delete a valid DB on transient connect errors

## Frontend polish
- [ ] Modal dialogs expose an accessible close button
- [ ] Diagnostics panels scroll or expand without clipping overflow
- [ ] Candidate lookup dropdowns use CSS classes instead of inline styles
- [ ] Sticky footers have sufficient bottom clearance on small viewports
- [ ] Help / FAQ covers the four added limited-check / manual fallback topics

## Packaging
- [ ] Installer maps `frontend/build` (not source) for Electron loadURL
- [ ] Auto-update metadata parses multiline notes
- [ ] Uninstallers remove per-user data only (unless admin-confirmed wipe is selected)

## Communication
- [ ] Release notes mention: new VPN/manual-check behavior, headset approvals, and shared-sheet resilience
- [ ] Tester-room / Discord posts posted for feature changes that affect workflow steps
