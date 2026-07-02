# Publishing Checklist

This file tracks the work needed to publish Codex Gestion publicly.

Official VS Code publishing docs:

https://code.visualstudio.com/api/working-with-extensions/publishing-extension

## 1. Choose public identity

Pick these before publishing:

- Marketplace publisher ID: `TODO`
- Display publisher name: `TODO`
- Repository URL: `TODO`
- Donation URL: `TODO`
- Support/contact URL or email: `TODO`

Then update `package.json`:

```json
{
  "publisher": "your-publisher-id"
}
```

Recommended optional fields once you have public URLs:

```json
{
  "repository": {
    "type": "git",
    "url": "https://github.com/USER/REPO.git"
  },
  "bugs": {
    "url": "https://github.com/USER/REPO/issues"
  },
  "homepage": "https://github.com/USER/REPO#readme"
}
```

## 2. Prepare Marketplace account

1. Create or sign in to the Visual Studio Marketplace publisher portal.
2. Create a publisher with the exact publisher ID you put in `package.json`.
3. Create a Personal Access Token as described in the official VS Code docs.
4. Login locally:

```powershell
npx vsce login your-publisher-id
```

## 3. Pre-release checks

Run:

```powershell
npm test
npm run package
```

Inspect the VSIX contents:

```powershell
tar -tf .\dist\codex-gestion-0.0.5.vsix
```

Confirm the package includes:

- `src/runtime.js`
- `media/chart.umd.min.js`
- `README.md`
- `PRIVACY.md`
- `LICENSE.txt`

Confirm it does not include:

- local logs
- `.git`
- old `.vsix` files
- `node_modules`
- credentials or local auth files

## 4. README images

The README uses images from `media/`. For local VSIX builds, the package script
uses `--no-rewrite-relative-links` so the package can be generated without a
public repository.

For Marketplace publishing, configure one of these before running `vsce publish`:

- add a real `repository.url` in `package.json`, preferably a GitHub or GitLab repo
- or publish with `--baseContentUrl` and `--baseImagesUrl`

Example once the repo is public:

```powershell
npx vsce publish --baseContentUrl https://raw.githubusercontent.com/USER/REPO/main --baseImagesUrl https://raw.githubusercontent.com/USER/REPO/main
```

## 5. Publish

Publish the current version:

```powershell
npx vsce publish
```

Or use the script:

```powershell
npm run publish:marketplace
```

## 6. After publishing

- Open the Marketplace listing and verify the README formatting.
- Install it from Marketplace in a clean VS Code profile.
- Test: refresh, dashboard, account switch, project context, diagnostics.
- Add screenshots or GIFs to the README if the listing feels too plain.

## 7. Donations

Marketplace does not provide a built-in donation checkout for this extension.
Use an external donation link and document it in `DONATE.md` and the README.

Common options:

- GitHub Sponsors
- Ko-fi
- Buy Me a Coffee
- PayPal.Me
- Stripe Payment Link

If the repository is on GitHub, configure `.github/FUNDING.yml` too.
