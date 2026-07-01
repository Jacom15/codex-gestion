<p align="center">
  <img src="https://raw.githubusercontent.com/Jacom15/codex-gestion/main/media/codex-gestion-logo.png" width="112" alt="Codex Gestion logo">
</p>

<h1 align="center">Codex Gestion</h1>

<p align="center">
  A local VS Code dashboard for Codex quotas, sessions, and account switching.
</p>

<p align="center">
  <img alt="Version" src="https://img.shields.io/badge/version-0.0.2-60a5fa?style=for-the-badge">
  <img alt="License" src="https://img.shields.io/badge/license-MIT-4ec9b0?style=for-the-badge">
  <img alt="Privacy" src="https://img.shields.io/badge/privacy-local_only-111827?style=for-the-badge">
  <img alt="VS Code" src="https://img.shields.io/badge/VS_Code-%5E1.85-007ACC?style=for-the-badge">
</p>

<p align="center">
  <img src="https://raw.githubusercontent.com/Jacom15/codex-gestion/main/media/readme-hero.png" alt="Codex Gestion hero preview">
</p>

Codex Gestion gives Codex power users a clean local view of usage, quota windows,
account snapshots, and account switching inside VS Code. It is built for the
small but very real moment where you want to know: which account am I using,
how much quota is left, and when does it reset?

## Preview

| Dashboard | Status tooltip |
| --- | --- |
| <img src="https://raw.githubusercontent.com/Jacom15/codex-gestion/main/media/readme-dashboard.png" alt="Dashboard preview"> | <img src="https://raw.githubusercontent.com/Jacom15/codex-gestion/main/media/readme-tooltip.png" alt="Tooltip preview"> |

## Highlights

| Area | What it does |
| --- | --- |
| Quotas | Shows primary and secondary Codex quota windows when Codex records them locally. |
| Dashboard | Opens a polished Chart.js dashboard with availability gauges and reset times. |
| Status bar | Adds a compact status-bar summary and visual tooltip for quick checks. |
| Accounts | Stores local account credentials in VS Code SecretStorage and lets you switch accounts. |
| Switching | Reloads VS Code automatically after a successful switch and guards against Codex restoring the previous account. |
| Handoff | Maintains a safe project context file at `.codex-gestion/PROJECT_CONTEXT.md`. |
| Diagnostics | Generates sanitized troubleshooting output without tokens or full chat contents. |

## Privacy-first by design

Codex Gestion is a local helper. It is not a hosted service and it does not need
a backend.

It reads:

- `~/.codex/sessions/**/*.jsonl`
- `~/.codex/auth.json`
- VS Code SecretStorage entries created by this extension
- the current workspace path when creating project context

It writes:

- `~/.codex/auth.json` when you explicitly add or switch accounts
- VS Code SecretStorage entries for saved account credentials
- `.codex-gestion/PROJECT_CONTEXT.md` in the current workspace

It does not intentionally send tokens, credentials, prompts, file contents,
session contents, or diagnostics to any remote server. See `PRIVACY.md` for
the full policy.

## Installation

From a local VSIX package:

```powershell
code --install-extension .\dist\codex-gestion-0.0.2.vsix --force
```

From VS Code, you can also run:

```text
Extensions: Install from VSIX...
```

When published to the Marketplace, search for:

```text
Codex Gestion
```

## Commands

| Command | Purpose |
| --- | --- |
| `Codex Gestion: Abrir panel visual` | Open the visual dashboard. |
| `Codex Gestion: Actualizar` | Refresh local usage data. |
| `Codex Gestion: Gestionar cuentas` | Add, switch, rename, or remove local accounts. |
| `Codex Gestion: Cambiar cuenta` | Switch directly between saved accounts. |
| `Codex Gestion: Abrir contexto del proyecto` | Create or open the handoff context file. |
| `Codex Gestion: Ver diagnostico` | Show sanitized diagnostic output. |

## Multiple accounts

Codex threads cannot combine context windows or rate limits from multiple
accounts. When you switch accounts, Codex Gestion updates the local auth file,
waits briefly to protect the selection, and reloads VS Code so new Codex work
starts from the selected account cleanly.

## Development

```powershell
npm install
npm test
npm run package
```

The package is created at:

```text
dist\codex-gestion-0.0.2.vsix
```

## Publishing

See `PUBLISHING.md`. The current Marketplace publisher is `jacom15`.

## Support the project

Codex Gestion is free. If it saves you time, donations are welcome but optional.

<p align="center">
  <a href="https://ko-fi.com/jacom15"><img alt="Support on Ko-fi" src="https://img.shields.io/badge/Support%20on-Ko--fi-ff5f5f?style=for-the-badge&logo=kofi&logoColor=white"></a>
</p>

Donations do not unlock extra features; they just help keep maintenance moving.
See `DONATE.md` for details.

## License

MIT. See `LICENSE`.

