# Instalacion

## Requisitos

- Visual Studio Code instalado.
- El archivo `codex-gestion-0.0.2.vsix`, o la extension publicada en el
  Marketplace.

Node.js no es necesario para usar la extension. Solo hace falta si quieres
modificarla o generar un nuevo paquete.

## Instalar desde VSIX

Si el paquete esta en la carpeta actual:

```powershell
code --install-extension .\dist\codex-gestion-0.0.2.vsix --force
```

Tambien puedes instalarlo desde VS Code con:

```text
Extensions: Install from VSIX...
```

VS Code copia la extension a la carpeta de extensiones del usuario, por ejemplo:

```text
%USERPROFILE%\.vscode\extensions
```

No hace falta conservar el `.vsix` despues de instalarlo, aunque conviene
guardarlo para reinstalar o compartir la misma version.

## Instalar desde Marketplace

Cuando la extension este publicada, abre la vista Extensions en VS Code y busca:

```text
Codex Gestion
```

Despues de instalar o actualizar, ejecuta `Developer: Reload Window` si VS Code
no recarga automaticamente la extension.

## Crear un paquete nuevo

```powershell
npm install
npm run package
```

Esto ejecuta los tests y crea:

```text
dist\codex-gestion-0.0.2.vsix
```

Para probarlo en el equipo actual:

```powershell
npm run install:local
```

## Actualizar la extension

1. Cambia la version en `package.json`.
2. Ejecuta `npm run package`.
3. Instala el nuevo `.vsix` con `npm run install:local` o distribuyelo.

## Limpiar artefactos

```powershell
npm run clean
```
