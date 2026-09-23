# Release 1.0.4

La 1.0.4 añade estado real de créditos a la lectura directa de cuotas y alinea el
repositorio con la versión pública 1.0.3 previa.

## Cambios principales

- Saldo de créditos cuando Codex lo informa.
- Estados diferenciados: disponibles, saldo no expuesto, ilimitados, ninguno y desconocido.
- Relación visual entre cuota agotada y créditos disponibles.
- Validación de `accountId` en la lectura directa.
- Conservación de `ordinaryUsageAllowed`, `rateLimitReachedType` y upsell metadata.
- Barra visible inmediatamente durante el primer refresco.
- Preview Docker persistente con escenarios ficticios de créditos.
- CI Node 22 en Windows y Linux.
- Documentación, privacidad e instalación actualizadas.

## Preparar

```powershell
npm test
npm run package
```

Paquete esperado: `dist\codex-gestion-1.0.4.vsix`.

## Publicar

1. Verifica que `main` contiene la 1.0.4 y que CI pasa.
2. Instala y prueba el VSIX local.
3. Publica `dist/codex-gestion-1.0.4.vsix` en el publisher `jacom15`.
4. Instala desde Marketplace en un perfil limpio y comprueba créditos, cuotas y cuentas.

Consulta [PUBLISHING.md](PUBLISHING.md) para la lista completa.
