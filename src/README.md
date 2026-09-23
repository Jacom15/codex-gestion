# Source layout

- `runtime.js`: lifecycle, refresh orchestration, status bar, dashboard and account UI.
- `constants.js`: filesystem paths, storage keys and timing constants.
- `auth/accounts.js`: account identity parsing, profile IDs and SecretStorage keys.
- `codex/cli.js`: Codex executable discovery and login command construction.
- `codex/rate-limits.js`: read-only app-server requests, account attribution and quota/credit normalization.
- `sessions/reader.js`: local session discovery and JSONL fallback parsing.
- `plans/policy.js`: plan-family behavior and refresh policy.
- `utils/format.js`: formatting, escaping, percentages and usage advice.
- `i18n.js`: runtime English/Spanish strings.

The direct account read is intentionally read-only: `initialize` → `account/read`
→ `account/rateLimits/read`. Credits are normalized separately from plan
eligibility; a missing credit snapshot means unknown, not zero.
