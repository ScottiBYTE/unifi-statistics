# UniFi Statistics v2.1.1

## Fixes

- Fixed UniFi OS version bubble opening stale release notes.
- Removed unsafe hardcoded UniFi OS release UUID behavior.
- Added exact UniFi OS release-note resolution for current and future versions.
- Added headless Chromium fallback to discover the correct UniFi Community release URL when the standard release service does not return a direct result.
- Added support for UniFi OS release families including Dream Machines, Cloud Gateways, Cloud Keys, and Express when resolving release notes.
- Improved release-link behavior so future UniFi OS versions do not generate invalid hybrid URLs.

## UI Stability

- Reduced dashboard refresh “hop” during refresh cycles.
- Prevented overlapping refresh operations.
- Disabled animated Chart.js redraws during dashboard data refresh.

## Docker

- Docker image now includes Chromium dependencies required for headless UniFi release-note resolution.
