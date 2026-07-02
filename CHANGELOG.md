# Changelog

## 0.0.5 - 2026-07-02

- Added smarter project handoff context for continuing work in another chat or Codex account.
- Added optional sanitized local session excerpts to `.codex-gestion/PROJECT_CONTEXT.md` through `codexGestion.projectContext.includeSessionExcerpts`.
- Added Git status and clearer continuation guidance to generated project context.
- Improved the compact status bar text so it shows available quota plus time left to reset, instead of the confusing `5h` window label.
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