<p align="center">
  <img src="https://raw.githubusercontent.com/Jacom15/codex-gestion/main/media/codex-gestion-logo.png" width="112" alt="Codex Gestion logo">
</p>

<h1 align="center">Codex Gestion</h1>

<p align="center">
  A local VS Code dashboard for Codex quotas, sessions, and account switching.
</p>

<p align="center">
  <a href="#english"><img alt="English" src="https://img.shields.io/badge/Read-English-60a5fa?style=for-the-badge"></a>
  <a href="#espanol"><img alt="Espanol" src="https://img.shields.io/badge/Leer-Espa%C3%B1ol-4ec9b0?style=for-the-badge"></a>
</p>

<p align="center">
  <img alt="Version" src="https://img.shields.io/badge/version-0.0.3-60a5fa?style=for-the-badge">
  <img alt="License" src="https://img.shields.io/badge/license-source--available-4ec9b0?style=for-the-badge">
  <img alt="Privacy" src="https://img.shields.io/badge/privacy-local_only-111827?style=for-the-badge">
  <img alt="VS Code" src="https://img.shields.io/badge/VS_Code-%5E1.85-007ACC?style=for-the-badge">
</p>

<p align="center">
  <img src="https://raw.githubusercontent.com/Jacom15/codex-gestion/main/media/readme-hero.png" alt="Codex Gestion hero preview">
</p>

<a id="english"></a>

## English

<p align="right"><a href="#espanol">Leer en español</a></p>

Codex Gestion gives Codex power users a clean local view of usage, quota windows,
account snapshots, and account switching inside VS Code. It is built for the
small but very real moment where you want to know: which account am I using,
how much quota is left, and when does it reset?

### New in 0.0.3

- English UI support with automatic VS Code language detection.
- New `codexGestion.language` setting with `auto`, `es`, and `en` modes.
- Marketplace commands and settings are localized.
- Source-available license: users can install and review the extension, but copying, modifying, repackaging, redistributing, or publishing derivative extensions is not permitted without written permission.

### Preview

| Dashboard | Status tooltip |
| --- | --- |
| <img src="https://raw.githubusercontent.com/Jacom15/codex-gestion/main/media/readme-dashboard.png" alt="Dashboard preview"> | <img src="https://raw.githubusercontent.com/Jacom15/codex-gestion/main/media/readme-tooltip.png" alt="Tooltip preview"> |

### Highlights

| Area | What it does |
| --- | --- |
| Quotas | Shows primary and secondary Codex quota windows when Codex records them locally. |
| Dashboard | Opens a polished Chart.js dashboard with availability gauges and reset times. |
| Status bar | Adds a compact status-bar summary and visual tooltip for quick checks. |
| Accounts | Stores local account credentials in VS Code SecretStorage and lets you switch accounts. |
| Switching | Reloads VS Code automatically after a successful switch and guards against Codex restoring the previous account. |
| Handoff | Maintains a safe project context file at `.codex-gestion/PROJECT_CONTEXT.md`. |
| Diagnostics | Generates sanitized troubleshooting output without tokens or full chat contents. |

### Privacy-first by design

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

### Installation

From the Marketplace, search for:

```text
Codex Gestion
```

From a local VSIX package:

```powershell
code --install-extension .\dist\codex-gestion-0.0.3.vsix --force
```

### Commands

| Command | Purpose |
| --- | --- |
| `Codex Gestion: Open visual panel` | Open the visual dashboard. |
| `Codex Gestion: Refresh` | Refresh local usage data. |
| `Codex Gestion: Manage accounts` | Add, switch, rename, or remove local accounts. |
| `Codex Gestion: Switch account` | Switch directly between saved accounts. |
| `Codex Gestion: Open project context` | Create or open the handoff context file. |
| `Codex Gestion: View diagnostics` | Show sanitized diagnostic output. |

### Language

Codex Gestion supports English and Spanish. Use `codexGestion.language` to choose:

```text
auto | es | en
```

`auto` follows the VS Code display language.

### Multiple accounts

Codex threads cannot combine context windows or rate limits from multiple
accounts. When you switch accounts, Codex Gestion updates the local auth file,
waits briefly to protect the selection, and reloads VS Code so new Codex work
starts from the selected account cleanly.

### Support the project

Codex Gestion is free. If it saves you time, donations are welcome but optional.

<p align="center">
  <a href="https://ko-fi.com/jacom15"><img alt="Support on Ko-fi" src="https://img.shields.io/badge/Support%20on-Ko--fi-ff5f5f?style=for-the-badge&logo=kofi&logoColor=white"></a>
</p>

Donations do not unlock extra features; they just help keep maintenance moving.
See `DONATE.md` for details.

### License

Codex Gestion is source-available. You may install and use the official extension,
and view the source for transparency, but copying, modifying, redistributing,
repackaging, or publishing derivative extensions is not permitted without written
permission. See `LICENSE`.

---

<a id="espanol"></a>

## Español

<p align="right"><a href="#english">Read in English</a></p>

Codex Gestion ofrece a usuarios intensivos de Codex una vista local y clara de
uso, ventanas de cuota, cuentas detectadas y cambio de cuenta dentro de VS Code.
Esta pensada para ese momento concreto en el que quieres saber: que cuenta estoy
usando, cuanta cuota queda y cuando se renueva?

### Nuevo en 0.0.3

- Soporte de interfaz en ingles con deteccion automatica del idioma de VS Code.
- Nuevo ajuste `codexGestion.language` con modos `auto`, `es` y `en`.
- Comandos y ajustes del Marketplace localizados.
- Licencia source-available: los usuarios pueden instalar y revisar la extension, pero no copiar, modificar, reempaquetar, redistribuir ni publicar extensiones derivadas sin permiso escrito.

### Vista previa

| Panel visual | Tooltip de estado |
| --- | --- |
| <img src="https://raw.githubusercontent.com/Jacom15/codex-gestion/main/media/readme-dashboard.png" alt="Vista previa del panel"> | <img src="https://raw.githubusercontent.com/Jacom15/codex-gestion/main/media/readme-tooltip.png" alt="Vista previa del tooltip"> |

### Caracteristicas

| Area | Que hace |
| --- | --- |
| Cuotas | Muestra las ventanas de cuota principal y secundaria cuando Codex las registra localmente. |
| Panel visual | Abre un panel Chart.js cuidado con graficas de disponibilidad y horas de renovacion. |
| Barra de estado | Anade un resumen compacto y un tooltip visual para consultas rapidas. |
| Cuentas | Guarda credenciales locales en VS Code SecretStorage y permite cambiar entre cuentas. |
| Cambio de cuenta | Recarga VS Code automaticamente tras un cambio correcto y evita que Codex restaure la cuenta anterior. |
| Traspaso | Mantiene un archivo seguro de contexto en `.codex-gestion/PROJECT_CONTEXT.md`. |
| Diagnostico | Genera informacion de ayuda saneada, sin tokens ni contenido completo de chats. |

### Privacidad primero

Codex Gestion es una ayuda local. No es un servicio alojado y no necesita backend.

Lee:

- `~/.codex/sessions/**/*.jsonl`
- `~/.codex/auth.json`
- entradas de VS Code SecretStorage creadas por esta extension
- la ruta del workspace actual al crear contexto de proyecto

Escribe:

- `~/.codex/auth.json` cuando agregas o cambias cuentas explicitamente
- entradas de VS Code SecretStorage para credenciales guardadas
- `.codex-gestion/PROJECT_CONTEXT.md` en el workspace actual

No envia intencionadamente tokens, credenciales, prompts, contenidos de archivos,
contenidos de sesiones ni diagnosticos a ningun servidor remoto. Consulta
`PRIVACY.md` para ver la politica completa.

### Instalacion

Desde el Marketplace, busca:

```text
Codex Gestion
```

Desde un paquete VSIX local:

```powershell
code --install-extension .\dist\codex-gestion-0.0.3.vsix --force
```

### Comandos

| Comando | Uso |
| --- | --- |
| `Codex Gestion: Abrir panel visual` | Abrir el panel visual. |
| `Codex Gestion: Actualizar` | Actualizar los datos locales de uso. |
| `Codex Gestion: Gestionar cuentas` | Agregar, cambiar, renombrar o eliminar cuentas locales. |
| `Codex Gestion: Cambiar cuenta` | Cambiar directamente entre cuentas guardadas. |
| `Codex Gestion: Abrir contexto del proyecto` | Crear o abrir el archivo de contexto de traspaso. |
| `Codex Gestion: Ver diagnostico` | Mostrar diagnostico saneado. |

### Idioma

Codex Gestion soporta ingles y espanol. Usa `codexGestion.language` para elegir:

```text
auto | es | en
```

`auto` sigue el idioma configurado en VS Code.

### Multiples cuentas

Los hilos de Codex no pueden combinar ventanas de contexto ni limites de varias
cuentas. Al cambiar de cuenta, Codex Gestion actualiza el archivo local de auth,
espera brevemente para proteger la seleccion y recarga VS Code para que el nuevo
trabajo de Codex empiece limpiamente con la cuenta seleccionada.

### Apoyar el proyecto

Codex Gestion es gratis. Si te ahorra tiempo, las donaciones son bienvenidas pero opcionales.

<p align="center">
  <a href="https://ko-fi.com/jacom15"><img alt="Support on Ko-fi" src="https://img.shields.io/badge/Support%20on-Ko--fi-ff5f5f?style=for-the-badge&logo=kofi&logoColor=white"></a>
</p>

Las donaciones no desbloquean funciones extra; solo ayudan a mantener el proyecto.
Consulta `DONATE.md` para mas detalles.

### Licencia

Codex Gestion es source-available. Puedes instalar y usar la extension oficial,
y revisar el codigo por transparencia, pero no esta permitido copiar, modificar,
redistribuir, reempaquetar ni publicar extensiones derivadas sin permiso escrito.
Consulta `LICENSE`.