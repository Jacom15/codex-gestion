# Changelog

## 1.0.2 - 2026-09-04

- Fixed quota percentage display so a real `1% free` remains visible, while fractional exhausted readings can round down to `0% free`.

## 1.0.1 - 2026-09-04

- Fixed status-bar tooltip actions so Overview and Refresh are clickable again.
- Kept the redesigned vertical tooltip layout while preserving command links.

## 1.0.0 - 2026-09-04

- Redesigned the dashboard into focused Overview, Accounts, Context, and Diagnostics sections.
- Added an operational health summary for local session status, quota windows, context source, saved credentials, and refresh cadence.
- Added dynamic quota windows so the dashboard follows the durations Codex records locally instead of assuming fixed limits.
- Added account-aware quota snapshots: each saved account keeps its last attributed quota reading, while pending accounts stay clearly marked.
- Fixed account switching so generic Codex quota readings no longer overwrite other saved accounts.
- Added short-lived fast polling after account switches so new quota readings appear sooner once Codex writes them.
- Improved dashboard quota refresh so charts update in place instead of rebuilding from zero.
- Updated the status-bar hover with compact visual quota cards, action links, and a calmer footer.
- Expanded sanitized diagnostics with saved profile counts, encrypted credential counts, quota state, context source, and health signals.
- Refreshed Marketplace screenshots and README copy for the 1.0.0 release.
- Updated quota handling to render the local Codex quota windows dynamically by plan data instead of assuming fixed durations.
- Refreshed Marketplace README content with a clearer local-only privacy section, larger dark-mode screenshots, and a focused dashboard hero.
- Updated tests and smoke checks for dynamic quota labels, workspace plan policy, and account-aware rendering.
- Removed the experimental Codex controls/skills hub because those private Codex chat actions are not reliably callable from another VS Code extension.

## 0.0.6 - 2026-07-27

- Previous public Marketplace release.

## 0.0.3 - 2026-07-01

- Added English UI support with automatic language detection from VS Code.
- Added `codexGestion.language` with `auto`, `es`, and `en` modes.
- Localized Marketplace command titles and settings metadata.
- Changed the project license from MIT to a source-available license for this and future versions.

## 0.0.2 - 2026-07-01

- Initial public Marketplace release.
- Added visual quota dashboard, account switching, status tooltip, diagnostics, and Ko-fi support.
