# Privacy Policy

Codex Gestion is a local VS Code extension. It is built to help you inspect and
manage local Codex usage data on your own machine.

## Data read by the extension

The extension may read:

- `~/.codex/sessions/**/*.jsonl` to find usage and rate-limit snapshots.
- `~/.codex/auth.json` to identify and switch the active local Codex account.
- VS Code SecretStorage entries created by this extension.
- The current workspace path when creating `.codex-gestion/PROJECT_CONTEXT.md`.

## Data written by the extension

The extension may write:

- `~/.codex/auth.json` when you add or switch Codex accounts.
- VS Code SecretStorage entries for saved account credentials.
- `.codex-gestion/PROJECT_CONTEXT.md` in the current workspace.

## Network access

Codex Gestion does not intentionally send your credentials, tokens, prompts,
files, diagnostics, session contents, or account identifiers to any remote
server.

The extension may execute Codex CLI commands such as `codex login status` or
open Codex-related VS Code commands. Those tools are outside this extension and
may have their own network behavior.

## Credentials

Saved account credentials are stored through VS Code SecretStorage. They are not
shown in the dashboard, logs, diagnostics, or project context file.

## Diagnostics

Diagnostics are sanitized and intended for local troubleshooting. They should
not include tokens, account IDs, complete chat contents, or full local file
paths.

## Donations

Donation links, if configured, are external services. Using them is optional and
subject to the privacy policy of the selected donation provider.
