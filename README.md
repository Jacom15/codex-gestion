<p align="center">
  <img src="media/codex-gestion-logo.png" width="96" alt="Codex Gestion logo">
</p>

<h1 align="center">Codex Gestion</h1>

<p align="center">Codex quotas, credits, reset times and accounts · inside VS Code.</p>
<p align="center"><a href="#english">English</a> · <a href="#espanol">Español</a></p>

<p align="center">
  <img src="https://img.shields.io/badge/version-1.0.4-60a5fa" alt="Version 1.0.4">
  <img src="https://img.shields.io/badge/VS_Code-1.85%2B-007ACC" alt="VS Code 1.85 or later">
  <img src="https://img.shields.io/badge/backend-none-4ec9b0" alt="No hosted backend">
  <img src="https://img.shields.io/badge/license-source--available-9da3ad" alt="Source-available license">
</p>

<a id="english"></a>

## English

Codex Gestion keeps the active Codex account state visible without leaving the
editor. It combines a compact status-bar indicator, a detailed hover, a visual
dashboard and local account switching.

### New in 1.0.4

- **Real credit state from Codex.** The active account can show an exact balance, available credits without an exposed balance, unlimited credits, no credits, or an unknown state.
- **Credits are not inferred from the plan.** A missing credit snapshot means unknown, not zero.
- **Quota exhaustion and credits are shown together.** If an included quota reaches 100% used, the dashboard explains whether Codex reports credits that can continue usage.
- **Safer account attribution.** Direct quota responses preserve and validate `accountId` before being applied to the active account.
- **More backend state is preserved.** `ordinaryUsageAllowed`, `rateLimitReachedType`, and upsell metadata are retained for future UI/diagnostic use.
- **Persistent development preview.** Docker Compose Watch keeps the production renderer synchronized after `git pull` and includes fictional credit scenarios.

### Quotas and credits

Codex Gestion asks the installed Codex app server for the active ChatGPT
account's `account/rateLimits/read` response. That response can contain quota
windows and a credit snapshot.

| Credit state | Meaning |
| --- | --- |
| Exact balance | Codex reports credits and a balance, for example `25 credits`. |
| Available | Codex reports credits are available but does not expose an exact balance. |
| Unlimited | Codex reports unlimited credits. |
| None | Codex explicitly reports no credits available. |
| Unknown | Codex did not provide a credit snapshot. This is **not** treated as zero. |

Only the **active account** is queried live. Inactive accounts keep their last
saved quota reading and are not silently signed in just to refresh data.

### How refresh works

A refresh uses a read-only local Codex app-server session:

```text
initialize
account/read
account/rateLimits/read
```

It does not start a chat, model turn, or account switch. Automatic direct reads
are throttled; the manual **Refresh** command requests a current reading. If the
direct read is unavailable, Codex Gestion can fall back to local session data or
a saved reading.

### Privacy

Codex Gestion has **no hosted backend**. It starts the installed Codex app server
locally and communicates with it over standard input/output. Codex may use its
existing authentication and network connection to obtain quota/credit state from
OpenAI. Codex Gestion does not attach prompts, workspace files, session contents,
or diagnostics to that request.

Saved account credentials use VS Code SecretStorage. See [PRIVACY.md](PRIVACY.md)
for the complete data-flow description.

### Installation

Requires **VS Code 1.85+**. From Marketplace, search for **Codex Gestion** by
publisher **jacom15**, or install the local package:

```powershell
code --install-extension ./dist/codex-gestion-1.0.4.vsix --force
```

See [INSTALL.md](INSTALL.md) for development and local packaging instructions.

### Commands and settings

| Command | Purpose |
| --- | --- |
| `Codex Gestion: Open visual panel` | View quotas, credits, and reset times. |
| `Codex Gestion: Refresh` | Request the current active-account reading. |
| `Codex Gestion: Manage accounts` | Add, switch, rename, or remove saved accounts. |
| `Codex Gestion: Open project context` | Create/open the local handoff file. |
| `Codex Gestion: View diagnostics` | Inspect sanitized troubleshooting information. |

| Setting | Default | Purpose |
| --- | --- | --- |
| `codexGestion.language` | `auto` | Follow VS Code language, or choose `en` / `es`. |
| `codexGestion.refreshIntervalSeconds` | `30` | Requested refresh interval; plan policy may lengthen it. |
| `codexGestion.projectContext.includeSessionExcerpts` | `false` | Optionally include short sanitized session excerpts in the local handoff file. |

### Development preview

With Docker Desktop and Docker Compose Watch:

```powershell
git pull origin main
docker compose up -d --build --watch
```

Open `http://localhost:5177`. Normal source changes are synchronized without
rebuilding the container. The scenario launcher is at
`http://localhost:5177/launcher`.

Useful fictional credit scenarios:

```text
/overview-es.html
/credits-none-es.html
/credits-unlimited-es.html
/credits-unknown-es.html
/credits-normal-es.html
```

For the real VS Code extension surface, press **F5** and use the launch profile
`Codex Gestion: Extension real`.

### Build a VSIX

If dependencies are already installed:

```powershell
npm test
npm run package
```

If `node_modules` is missing:

```powershell
npm install --prefer-offline --no-audit --no-fund
npm test
npm run package
```

Output: `dist/codex-gestion-1.0.4.vsix`.

### Support and license

[Issues](https://github.com/Jacom15/codex-gestion/issues) ·
[Source](https://github.com/Jacom15/codex-gestion) ·
[Optional Ko-fi donation](https://ko-fi.com/jacom15)

Codex Gestion is source-available. See [LICENSE](LICENSE).

---

<a id="espanol"></a>

## Español

Codex Gestion mantiene visible el estado de la cuenta activa de Codex sin salir
del editor. Combina barra de estado, tooltip, panel visual y cambio local de
cuentas.

### Novedades de la 1.0.4

- **Créditos reales de la cuenta.** El panel puede mostrar saldo exacto, créditos disponibles sin saldo exacto, créditos ilimitados, ausencia de créditos o estado desconocido.
- **Los créditos no se deducen por el plan.** Un snapshot de créditos ausente significa desconocido, no cero.
- **Cuota agotada + créditos.** Si una ventana llega al 100% usado, el panel explica si Codex informa de créditos con los que puede continuar el uso.
- **Atribución de cuenta más segura.** Se conserva y valida `accountId` antes de aplicar una lectura directa.
- **Más estado del app server.** Se conservan `ordinaryUsageAllowed`, `rateLimitReachedType` y metadatos de upsell.
- **Preview persistente.** Docker Compose Watch sincroniza el código después de `git pull` y permite probar escenarios ficticios de créditos.

### Cuotas y créditos

Codex Gestion consulta `account/rateLimits/read` mediante el app server instalado
de Codex. La misma respuesta puede incluir las ventanas de cuota y el estado de
créditos.

| Estado | Significado |
| --- | --- |
| Saldo exacto | Codex informa de créditos y un saldo, por ejemplo `25 créditos`. |
| Disponibles | Hay créditos, pero Codex no expone el saldo exacto. |
| Ilimitados | Codex informa de créditos ilimitados. |
| Ninguno | Codex informa explícitamente de que no hay créditos disponibles. |
| Desconocido | Codex no devuelve snapshot de créditos. **No equivale a cero.** |

Solo se consulta en vivo la **cuenta activa**. Las cuentas inactivas mantienen su
última lectura de cuotas guardada.

### Cómo funciona Actualizar

La consulta directa usa una sesión local y de solo lectura del app server:

```text
initialize
account/read
account/rateLimits/read
```

No inicia un chat, turno del modelo ni cambio de cuenta. Si la consulta directa
no está disponible, la extensión puede usar datos de sesiones locales o una
lectura guardada.

### Privacidad

Codex Gestion **no tiene backend alojado propio**. Inicia el app server instalado
de Codex y se comunica con él por entrada/salida estándar. Codex puede utilizar
la autenticación y conexión de red existentes para obtener de OpenAI cuotas y
créditos. Codex Gestion no añade prompts, archivos del workspace, contenido de
sesiones ni diagnósticos a esa consulta.

Las credenciales guardadas se almacenan mediante VS Code SecretStorage. Consulta
[PRIVACY.md](PRIVACY.md).

### Instalación

Requiere **VS Code 1.85 o posterior**. Desde Marketplace busca **Codex Gestion**
del publisher **jacom15**, o instala el paquete local:

```powershell
code --install-extension ./dist/codex-gestion-1.0.4.vsix --force
```

### Desarrollo rápido

Con Docker Desktop:

```powershell
git pull origin main
docker compose up -d --build --watch
```

Abre `http://localhost:5177`. Después, mientras el contenedor siga levantado, un
`git pull` normal sincroniza los cambios. El selector técnico de escenarios está
en `http://localhost:5177/launcher`.

Para probar la extensión real en VS Code, pulsa **F5** y usa
`Codex Gestion: Extension real`.

### Crear el VSIX

Con dependencias ya instaladas:

```powershell
npm test
npm run package
```

Si has borrado `node_modules`:

```powershell
npm install --prefer-offline --no-audit --no-fund
npm test
npm run package
```

Resultado: `dist/codex-gestion-1.0.4.vsix`.

### Soporte y licencia

[Problemas](https://github.com/Jacom15/codex-gestion/issues) ·
[Repositorio](https://github.com/Jacom15/codex-gestion) ·
[Donación opcional en Ko-fi](https://ko-fi.com/jacom15)

Codex Gestion es source-available. Consulta [LICENSE](LICENSE).
