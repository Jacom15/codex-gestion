# Release rápido

Guía corta para preparar, probar y publicar una versión de Codex Gestion.

## 1. Elegir versión

Usa siempre una versión nueva si la anterior ya se subió al Marketplace.

Ejemplos:

- Si Marketplace ya tiene una version publicada, prepara la siguiente version de forma explicita.
- Si solo estós probando localmente y no has publicado, puedes regenerar la misma versión.

## 2. Preparar release completo

```powershell
npm run release:prepare -- -Version <version> -Notes "Mejora del selector de idioma", "Tooltip de cuotas mas claro"
```

Esto hace automíticamente:

- actualiza `package.json`
- actualiza la versión raíz de `package-lock.json`
- actualiza referencias de VSIX en `README.md`, `INSTALL.md` y `PUBLISHING.md`
- crea entrada en `CHANGELOG.md` si no existe
- ejecuta tests
- genera el VSIX
- comprueba que el VSIX existe
- muestra la ruta final

El resultado esperado será:

```text
dist\codex-gestion-1.0.1.vsix
```

## 3. Probar en local

Instala la versión generada:

```powershell
code --install-extension .\dist\codex-gestion-1.0.1.vsix --force
```

Reinicia o recarga VS Code si no ves el cambio inmediatamente.

Comprueba la versión instalada:

```powershell
code --list-extensions --show-versions | findstr codex
```

Debe salir algo como:

```text
jacom15.codex-gestion@<version>
```

## 4. Subir al Marketplace

Cuando localmente se vea bien:

1. Entra al portal de Visual Studio Marketplace.
2. Abre el publisher `jacom15`.
3. Entra en `Codex Gestion`.
4. Usa `Update`.
5. Sube el archivo:

```text
dist\codex-gestion-1.0.1.vsix
```

Espera a que pase de `Verifying` a publicado.

## 5. Push a GitHub

Cuando el Marketplace está bien o quieras guardar el estado:

```powershell
git status
git add .
git commit -m "Release <version>"
git push
```

## 6. Regenerar la misma versión

Solo para pruebas locales o si todavía no la has publicado:

```powershell
npm run release:prepare -- -Version <version>
```

## 7. Probar sin generar VSIX

útil para validar bump, changelog y tests sin empaquetar:

```powershell
npm run release:prepare -- -Version <version> -SkipPackage
```

## 8. Si algo falla

### No aparece la nueva versión en VS Code

```powershell
code --install-extension .\dist\codex-gestion-1.0.1.vsix --force
```

Luego recarga VS Code.

### Marketplace no deja actualizar

Revisa que `package.json` tenga una versión mayor que la publicada.

```powershell
node -e "console.log(require('./package.json').version)"
```

### El VSIX no existe

Ejecuta de nuevo:

```powershell
npm run release:prepare -- -Version <version>
```

### Tests fallan

Primero ejecuta:

```powershell
npm test
```

Arregla el fallo y vuelve a preparar release.

## 9. Checklist final

- [ ] versión nueva elegida.
- [ ] `npm run release:prepare` completado sin errores.
- [ ] VSIX existe en `dist`.
- [ ] Instalado localmente con `code --install-extension`.
- [ ] Panel probado en VS Code.
- [ ] Marketplace actualizado.
- [ ] Git commit y push hechos.






