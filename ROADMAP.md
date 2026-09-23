# Roadmap

## Completado

- [x] Selector de idioma ES/EN/Auto.
- [x] Tooltip visual con cuotas, porcentaje libre y renovaciones.
- [x] Barra de estado compacta.
- [x] Gestión y cambio de cuentas con SecretStorage.
- [x] Lectura directa de cuotas mediante el app server local de Codex.
- [x] Validación de cuenta antes de aplicar lecturas directas.
- [x] Contexto de proyecto y diagnósticos saneados.
- [x] Estado real de créditos (`hasCredits`, `unlimited`, `balance`).
- [x] Estado desconocido sin confundir `null` con cero.
- [x] Explicación de créditos cuando una cuota está agotada.
- [x] Preview persistente con Docker Compose Watch.
- [x] Launch config para probar la extensión real con F5.
- [x] CI Node 22 en Windows y Linux.

## Próximos pasos posibles

- [ ] Mostrar el mensaje/CTA de `rateLimitUpsell` cuando aporte información útil y no duplique la tarjeta de créditos.
- [ ] Añadir estado de créditos al tooltip si puede mantenerse compacto.
- [ ] Actualizar capturas públicas específicas de 1.0.4.
- [ ] Ampliar pruebas para nuevas variantes del protocolo de Codex.

## Release actual

- [x] Base 1.0.3 integrada.
- [x] Funcionalidad 1.0.4 implementada.
- [x] Documentación 1.0.4 actualizada.
- [ ] Publicar 1.0.4 en Marketplace.
