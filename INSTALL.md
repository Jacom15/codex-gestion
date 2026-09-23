# Instalación de Codex Gestion 1.0.4

## Requisitos

- VS Code 1.85 o posterior.
- Codex configurado con una cuenta de ChatGPT para consultar cuotas y créditos del plan.
- Un ejecutable local compatible de Codex para la consulta directa.

Si la consulta directa no está disponible, Codex Gestion puede usar datos de
sesiones locales o la última lectura guardada. Node.js no es necesario para usar
un VSIX ya generado.

## Marketplace

Busca **Codex Gestion**, publisher **jacom15**, en Extensiones.

## Instalar el VSIX local

```powershell
code --install-extension ./dist/codex-gestion-1.0.4.vsix --force
```

Después ejecuta **Developer: Reload Window** si VS Code no recarga la extensión.

## Comprobación rápida

1. Abre **Codex Gestion: Abrir panel visual**.
2. Pulsa **Actualizar** con la cuenta deseada activa en Codex.
3. Comprueba cuotas, renovaciones y la tarjeta de créditos.
4. Si Codex no devuelve `credits`, el panel debe mostrar estado desconocido, no `0`.
5. Las cuentas inactivas muestran una lectura guardada, no una consulta en vivo.

## Desarrollo normal

Con dependencias instaladas:

```powershell
npm test
npm run package
```

Si `node_modules` no existe:

```powershell
npm install --prefer-offline --no-audit --no-fund
npm test
npm run package
```

Resultado: `dist\codex-gestion-1.0.4.vsix`.

## Preview persistente con Docker

```powershell
docker compose up -d --build --watch
```

Abre `http://localhost:5177`. Mientras Docker siga levantado, los cambios
normales del repo se sincronizan automáticamente. El launcher está en
`http://localhost:5177/launcher`.

## Probar la extensión real

Abre el repo en VS Code, pulsa **F5** y usa
`Codex Gestion: Extension real`.
