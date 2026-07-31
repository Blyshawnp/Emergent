# VPN / Proxy Lookup release behavior

## Current packaged release

MTS uses a manual-only VPN/proxy lookup workflow on Basics.

- The trainer answers **Has VPN?** and, when applicable, **Can turn off?**.
- **VPN / Proxy Lookup Sites** provides exactly three approved external reference sites: IP2Location, IPinfo, and ip.teoh.io.
- Each **Copy Link** action copies only that site's public website URL.
- MTS does not open a site, append or submit a candidate IP, call a provider, classify VPN/proxy status, fill either VPN answer, or determine pass/fail from a lookup.
- No saved candidate IP is required.
- There is no user-facing setting that enables an automatic checker.

The trainer opens a copied link separately and manually enters the candidate IP on the external site. Those sites are reference tools only. The existing VPN answer and explicit failure-confirmation workflow remains authoritative.

## Internal provider code

The backend `/api/ip-intelligence/check` implementation and legacy `vpnProxyCheckMode` data handling are retained only as inactive internal/future-development code. The release frontend has no client method, component hook, startup task, or Settings control that calls or exposes that endpoint. It therefore produces no provider traffic and cannot affect MTS UI or session state.

Do not document the internal endpoint or legacy setting as a packaged feature, and do not instruct users or administrators to enable it. Any future proposal to ship automatic verification requires a separate product decision, privacy/network review, user-interface review, and acceptance plan.

## Compatibility boundaries

Do not change these systems as part of the manual lookup presentation:

- `vpn_on` and `vpn_off` session/history fields
- the explicit VPN failure confirmation
- fallback/Gemini summary behavior
- Microsoft Form/Selenium VPN mappings
- Google Sheets credentials or service-account files
