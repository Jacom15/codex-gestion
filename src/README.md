# Source Layout

- `runtime.js`: VS Code lifecycle, command registration, refresh orchestration, and UI wiring.
- `constants.js`: shared filesystem paths, storage keys, debounce values, and command timing.
- `auth/accounts.js`: account identity parsing, profile IDs, SecretStorage keys, and auth failure summaries.
- `codex/cli.js`: Codex executable discovery and shell-safe login command construction.
- `sessions/reader.js`: local Codex session discovery and JSONL stats parsing.
- `utils/format.js`: pure formatting, escaping, percentages, quota labels, and usage advice.

Keep new behavior near the module that owns the concept. `extension.js` should stay as the thin VS Code entrypoint.