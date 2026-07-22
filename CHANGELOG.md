# Changelog

## 0.0.6 - 2026-07-02

- Added an in-panel language selector for Auto, Spanish, and English.
- Added first-run onboarding with direct actions for Codex, accounts, and project context.
- Added `npm run release:prepare` to bump, test, package, and validate VSIX releases safely.
- Added smarter project handoff context for continuing work in another chat or Codex account.
- Added ROADMAP-driven next steps, recent Git commits, detected project identity, and local decision signals to generated project context.
- Added a clear `AGENTS.md` note explaining what Codex can read automatically versus manual handoff context.
- Added clearer account differentiation with local color accents, initials, visible aliases, and secondary email/plan details.
- Added optional sanitized local session excerpts to `.codex-gestion/PROJECT_CONTEXT.md` through `codexGestion.projectContext.includeSessionExcerpts`.
- Added Git status and clearer continuation guidance to generated project context.
- Improved the compact status bar text so it shows available quota plus time left to reset, instead of the confusing `5h` window label.
- Improved status-bar tooltip quota summaries with available percent, reset timing, and used percent.
- Fixed the Marketplace/extension logo PNG so rounded corners are transparent instead of white.
- Fixed stale reset wording so old local quota data does not show confusing `in now` / `dentro de now` text.

## 0.0.3 - 2026-07-01

- Added English UI support with automatic language detection from VS Code.
- Added `codexGestion.language` with `auto`, `es`, and `en` modes.
- Localized Marketplace command titles and settings metadata.
- Changed the project license from MIT to a source-available license for this and future versions.

## 0.0.2 - 2026-07-01

- Initial public Marketplace release.
- Added visual quota dashboard, account switching, status tooltip, diagnostics, and Ko-fi support.