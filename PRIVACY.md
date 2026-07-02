# Privacy Policy

Codex Gestion is a local VS Code extension. It is built to help you inspect and
manage local Codex usage data on your own machine.

## Data read by the extension

The extension may read:

- `~/.codex/sessions/**/*.jsonl` to find usage and rate-limit snapshots, and to collect short sanitized excerpts for project handoff when enabled.
- `~/.codex/auth.json` to identify and switch the active local Codex account.
- VS Code SecretStorage entries created by this extension.
- The current workspace path when creating `.codex-gestion/PROJECT_CONTEXT.md`.

## Data written by the extension

The extension may write:

- `~/.codex/auth.json` when you add or switch Codex accounts.
- VS Code SecretStorage entries for saved account credentials.
- `.codex-gestion/PROJECT_CONTEXT.md` in the current workspace, optionally including sanitized excerpts from recent local Codex sessions.

## Network access

Codex Gestion does not intentionally send your credentials, tokens, prompts,
files, diagnostics, session contents, or account identifiers to any remote
server. Optional session excerpts are written only to `.codex-gestion/PROJECT_CONTEXT.md` in your local workspace.

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


## Project context excerpts

When `codexGestion.projectContext.includeSessionExcerpts` is enabled, Codex Gestion may add short sanitized excerpts from recent local Codex session files to `.codex-gestion/PROJECT_CONTEXT.md`. This is intended to help you continue the same project from another chat or account on the same machine.

The excerpts stay local, are truncated, and obvious token-like values are redacted. Disable the setting if you want the project context file to contain only metadata such as quota, account label, and Git status.

## Donations

Donation links, if configured, are external services. Using them is optional and
subject to the privacy policy of the selected donation provider.
