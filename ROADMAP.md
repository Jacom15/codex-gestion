# Roadmap de mejoras

Checklist para ir mejorando Codex Gestion sin perder el hilo. Marca cada punto cuando este hecho.

## Alta prioridad

- [x] Selector de idioma dentro del panel
  - [x] Mostrar control `Auto | Espanol | English` en la cabecera del dashboard.
  - [x] Guardar el cambio en `codexGestion.language`.
  - [x] Refrescar el panel al cambiar idioma.
  - [x] Anadir prueba smoke para espanol/ingles desde el selector.

- [x] Tooltip rapido de cuotas en la barra
  - [x] Mostrar en hover las ventanas de cuota disponibles con porcentaje libre y tiempo hasta renovar.
  - [x] Mostrar reset y porcentaje libre sin asumir duraciones fijas.
  - [x] Evitar textos ambiguos como etiquetas compactas sin contexto.
  - [x] Cubrir el formato con test.

- [x] Script/comando de preparar release
  - [x] Bump de version seguro en `package.json` y `package-lock.json`.
  - [x] Actualizar referencias de README/INSTALL/PUBLISHING.
  - [x] Crear entrada de CHANGELOG.
  - [x] Ejecutar tests.
  - [x] Generar VSIX.
  - [x] Validar que el VSIX existe y mostrar la ruta final.
  - [x] Evitar reemplazos globales peligrosos como tocar dependencias del lockfile.

## Media prioridad

- [x] Mejor onboarding inicial
  - [x] Disenar pantalla bonita cuando no hay datos locales todavia.
  - [x] Anadir acciones directas: `Abrir Codex`, `Gestionar cuentas`, `Crear contexto del proyecto`.
  - [x] Explicar de forma breve que los datos aparecen tras iniciar o usar un chat de Codex.

- [x] Contexto del proyecto mas inteligente
  - [x] Detectar objetivo probable del proyecto desde sesiones locales.
  - [x] Resumir cambios recientes del repo.
  - [x] Extraer senales de decisiones tomadas desde conversaciones recientes.
  - [x] Proponer proximos pasos probables.
  - [x] Mantener todo local y saneado.

- [x] Mejor diferenciacion de cuentas
  - [x] Permitir alias visibles tipo `Trabajo`, `Personal`, `Backup`.
  - [x] Anadir color local por cuenta.
  - [x] Anadir icono/indicador simple por cuenta.
  - [x] Mantener email y plan como detalle secundario.

## Baja prioridad / marketing

- [x] Pagina Marketplace mas potente
  - [x] Añadir seccion `Why this exists`.
  - [x] Añadir seccion `Local-only privacy` mas visible.
  - [x] Preparar capturas en espanol e ingles.
  - [x] Crear captura enfocada del dashboard para Marketplace.
  - [x] Revisar que README y Marketplace se vean bien en modo oscuro.

## Release actual

- [ ] Publicar `1.0.1` en Marketplace.
- [ ] Hacer push a GitHub.
- [ ] Confirmar que VS Code detecta la actualizacion.
- [x] Comprobar que el logo ya no muestra esquinas blancas.

