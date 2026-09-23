# Publicación de Codex Gestion

## Identidad de la release

| Campo | Valor |
| --- | --- |
| Versión | `1.0.4` |
| Publisher | `jacom15` |
| Extension ID | `jacom15.codex-gestion` |
| Repositorio | https://github.com/Jacom15/codex-gestion |
| Soporte | https://github.com/Jacom15/codex-gestion/issues |
| Paquete | `dist/codex-gestion-1.0.4.vsix` |

La 1.0.4 parte de la 1.0.3 pública y añade lectura/visualización real de créditos,
además del flujo de preview persistente.

## Antes de empaquetar

```powershell
git status
npm test
npm run package
```

Comprueba que se crea `dist\codex-gestion-1.0.4.vsix` e instálalo localmente:

```powershell
code --install-extension ./dist/codex-gestion-1.0.4.vsix --force
```

## Pruebas mínimas antes de publicar

- Cuenta activa y plan correctos.
- Cuotas y horas de renovación.
- Créditos con saldo exacto cuando Codex lo proporciona.
- Estado `Disponible` cuando `hasCredits=true` y `balance=null`.
- Créditos ilimitados.
- Sin créditos cuando Codex lo informa explícitamente.
- Estado desconocido cuando no existe snapshot de créditos.
- Cambio de cuenta y lectura guardada de cuentas inactivas.
- Tooltip, barra de estado, español e inglés.
- Diagnósticos sin datos sensibles.

## Capturas

El preview utiliza datos ficticios y el mismo renderer del producto. Antes de
actualizar imágenes públicas, revisa visualmente los escenarios y evita publicar
datos de cuentas reales.

```powershell
npm run preview:render
npm run preview
```

## Publicar

Puedes subir el VSIX desde el portal de Visual Studio Marketplace o usar una
sesión `vsce` ya autenticada:

```powershell
npx vsce publish --packagePath ./dist/codex-gestion-1.0.4.vsix
```

No guardes tokens del Marketplace en el repositorio. Después de publicar, instala
la versión desde Marketplace en un perfil limpio y verifica panel, créditos,
cuentas y tooltip.
