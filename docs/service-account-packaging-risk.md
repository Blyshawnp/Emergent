# Service Account Packaging Risk

`google-service-account.json` is intentionally packaged into the application installer for the v1.0.x release cycle. 

This is a **known, temporary security tradeoff** accepted by the engineering team to streamline the distribution and installation process for early release testers. 

### Security Guidelines & Mitigations

To mitigate the risk of packaging service account credentials:
1. **Least Privilege**: The service account must be strictly scoped to the absolute minimum permissions required.
2. **Resource Scoping**: It should only have access to the specific Google Sheets required by the application. Do not grant project-level or broad API access.
3. **Limited Distribution**: The application installer must be distributed only to trusted internal users. Do not host the installer on public URLs.
4. **Credential Rotation**: The service account key must be rotated periodically and immediately after the initial release testing phase is complete.

### Future Architecture

For future releases (v1.1.x+), the architecture should move away from packaging service accounts by implementing one of the following:
* Admin-provided credentials configured during setup.
* User-level OAuth2 authentication flow.
* A secure backend proxy service that handles API access on behalf of the desktop clients.
