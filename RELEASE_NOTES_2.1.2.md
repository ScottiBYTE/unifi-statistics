# UniFi Statistics v2.1.2

## Summary

This release improves UniFi login reliability and makes UniFi OS release-note links faster and more accurate.

## Changes

- Improved UniFi login/session handling.
- Added cached UniFi session reuse to reduce repeated login attempts.
- Added login storm protection and rate-limit backoff behavior.
- Fixed UniFi OS release-note link resolution for hardware-family-specific release pages.
- Added support for Dream Machines, Cloud Gateways, Cloud Keys, Express, Dream Wall, Enterprise Network Video Recorders, and NAS-style UniFi OS release families.
- Added persistent local release URL caching with `data/releaseUrlCache.json`.
- Improved release-link click speed after the first successful lookup.
- Prevented older UniFi OS release UUIDs from being reused after a version change by including the version and hardware-family slug in the cache key.
- Failed release lookups are not cached, allowing the app to retry later if Community UI indexing is delayed.

## Notes

The first lookup for a new UniFi OS version may take several seconds because the app may need to launch Chromium, search Community UI, and extract the correct UUID-backed release URL.

After the URL is cached, future clicks should redirect almost instantly.
