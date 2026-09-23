# Privacy Policy

Codex Gestion is a local VS Code extension for inspecting and managing Codex
usage state on your own machine. It has no hosted backend operated by this
project.

## Data read by the extension

The extension may read:

- `~/.codex/sessions/**/*.jsonl` for local usage/rate-limit snapshots and, when enabled, short sanitized project-handoff excerpts.
- `~/.codex/auth.json` to identify or switch the active local Codex account.
- VS Code SecretStorage entries created by Codex Gestion.
- Workspace metadata used to create `.codex-gestion/PROJECT_CONTEXT.md`.
- Active-account state returned by the installed Codex app server, including quota windows, reset times, plan information, account identity used for attribution, and the credit snapshot when Codex provides one.

The credit snapshot may contain whether credits exist, whether they are
unlimited, and an exact balance when the backend exposes one. A missing credit
snapshot is treated as unknown, not as a zero balance.

## Data written by the extension

The extension may write:

- `~/.codex/auth.json` only when you explicitly add or switch Codex accounts.
- VS Code SecretStorage entries for saved account credentials.
- `.codex-gestion/PROJECT_CONTEXT.md` in the current workspace, optionally with sanitized excerpts from recent local Codex sessions.

## Direct quota and credit refresh

To refresh the active account, Codex Gestion starts the installed Codex app
server locally and communicates with it over standard input/output using this
read-only sequence:

```text
initialize
account/read
account/rateLimits/read
```

Codex Gestion does not start a chat or model turn and does not send a message to
a model to obtain quotas or credits. The Codex app server may use its existing
authentication and network connection to contact OpenAI. That network behavior
belongs to Codex itself.

Codex Gestion does not attach prompts, workspace files, session contents, or
diagnostics to the rate-limit request, and it does not intentionally log
credentials or full protocol responses.

## Account attribution

A live response is only applied after checking that it still belongs to the
currently active local account. When Codex provides `accountId`, that value is
also validated before the quota/credit state is accepted.

Inactive saved accounts are not silently signed in for background refresh. They
show saved quota readings instead.

## Credentials

Saved account credentials use VS Code SecretStorage. They are not shown in the
dashboard, project context, or sanitized diagnostics.

## Diagnostics

Diagnostics are intended for local troubleshooting and are sanitized to avoid
tokens, account IDs, complete chat contents, and full local paths.

## Project context excerpts

`codexGestion.projectContext.includeSessionExcerpts` is disabled by default.
When enabled, Codex Gestion may add short sanitized excerpts from recent local
Codex sessions to `.codex-gestion/PROJECT_CONTEXT.md`. The excerpts stay local
unless you explicitly share that file yourself.

## Donations

Donation links are external services. Using them is optional and subject to the
provider's own privacy policy.
