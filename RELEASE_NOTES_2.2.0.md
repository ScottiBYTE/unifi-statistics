# UniFi Statistics v2.2.0

Feature release adding UniFi update availability and release-channel awareness.

## Added

- Added update-availability detection for UniFi OS and installed UniFi applications.
- Added release-channel detection for:
  - UniFi OS
  - UniFi Network
  - UniFi Protect
  - UniFi Talk
  - UniFi Access when installed
- Added channel labels for:
  - Official
  - Release Candidate
  - Early Access
- Version pills now display the installed and available versions when an update exists.
- Update pills link directly to the available version's UniFi release notes.
- Added hover details showing:
  - Installed version
  - Available version
  - Selected release channel
- Added forced application-status refresh when the dashboard Refresh button is clicked.
- Added the ScottiBYTE browser favicon and Apple touch icon.

## Improved

- UniFi OS update discovery now follows the selected release channel.
- UniFi OS firmware versions with a leading `v` and build suffix are normalized correctly.
- Changing a release channel no longer requires deleting the cache or restarting the container.
- Last-known installed versions and release channels remain available during partial UniFi API responses.
- Stale cached update notices are no longer restored after an update is installed.
- Missing or uninstalled applications now use consistent `null` update values.

## Dashboard behavior

- Current applications use the normal green version-pill appearance.
- Applications with an available update use the amber update appearance.
- Update pills display:

  `Installed Version → Available Version`

- Clicking an update pill opens the release notes for the available version.
