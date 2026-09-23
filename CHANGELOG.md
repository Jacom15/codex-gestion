# Changelog

## 1.0.4 - 2026-09-23

- Added real active-account credit status from Codex `account/rateLimits/read`.
- Display exact balances when Codex exposes them, plus distinct states for available-without-balance, unlimited, none, and unknown.
- Treat a missing credit snapshot as unknown instead of zero.
- Explain credit availability when an included quota is exhausted.
- Preserve and validate backend `accountId` before applying a direct rate-limit response to the active account.
- Preserve `ordinaryUsageAllowed`, `rateLimitReachedType`, and Codex upsell metadata for future UI and diagnostics.
- Keep the status bar visible immediately while the first live app-server read is in flight.
- Harden diagnostics so error stacks do not leak local paths, make path comparison platform-aware, and disable project-context session excerpts by default.
- Recognize the current `ent26` enterprise plan variant.
- Added credit normalization/protocol tests and made activation smoke checks tolerate the valid pending state.
- Added a persistent Docker Compose Watch preview with fictional credit scenarios.
- Added a VS Code Extension Host launch profile and Node 22 CI on Windows and Linux.
- Updated README, installation, privacy, publishing, release, roadmap, and source-layout documentation for 1.0.4.

## 1.0.3 - 2026-09-07

- Added current active-account quota and reset reads through the installed Codex app server, with local session and saved-reading fallback.
- Improved active-account attribution, quota refresh, account cards, reset formatting, and status tooltip behavior.
- Added coverage for quota protocol, fallback, timeouts, account attribution, and live account-card updates.

## 1.0.2 - 2026-09-04

- Fixed quota percentage display so a real `1% free` remains visible, while fractional exhausted readings can round down to `0% free`.

## 1.0.1 - 2026-09-04

- Fixed status-bar tooltip actions so Overview and Refresh are clickable again.
- Kept the redesigned vertical tooltip layout while preserving command links.

## 1.0.0 - 2026-09-04

- Redesigned the dashboard into focused Overview, Accounts, Context, and Diagnostics sections.
- Added dynamic quota windows, account-aware snapshots, account switching, project handoff, and sanitized diagnostics.

## 0.0.6 - 2026-07-27

- Previous public Marketplace release.

## 0.0.3 - 2026-07-01

- Added English UI support and language configuration.
- Changed the project license to source-available.

## 0.0.2 - 2026-07-01

- Initial public Marketplace release.
