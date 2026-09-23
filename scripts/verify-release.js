const fs = require('fs');
const path = require('path');
const assert = require('assert');

const root = path.resolve(__dirname, '..');
const pkg = require('../package.json');
const version = pkg.version;
const text = name => fs.readFileSync(path.join(root, name), 'utf8');

function checkSources() {
  const lock = JSON.parse(text('package-lock.json'));
  assert.strictEqual(lock.version, version);
  assert.strictEqual(lock.packages[''].version, version);
  assert.strictEqual(pkg.publisher, 'jacom15');
  assert.strictEqual(pkg.name, 'codex-gestion');
  assert.strictEqual(pkg.contributes.configuration.properties['codexGestion.projectContext.includeSessionExcerpts'].default, false);

  const changelog = text('CHANGELOG.md');
  assert.strictEqual(changelog.match(/^## ([\d.]+) -/m)?.[1], version);
  const readme = text('README.md');
  assert.ok(readme.includes(`version-${version}-`), 'README version badge is stale');
  assert.ok(readme.includes(`New in ${version}`), 'README English release section is stale');
  assert.ok(readme.includes(`Novedades de la ${version}`), 'README Spanish release section is stale');

  for (const name of ['README.md', 'INSTALL.md', 'PUBLISHING.md', 'RELEASES.md', 'PRIVACY.md']) {
    const value = text(name);
    assert.ok(!/[\uFFFD]/u.test(value), `${name}: broken text encoding`);
    assert.ok(!/TODO|your-publisher-id|github\.com\/USER\/REPO/.test(value), `${name}: release placeholder`);
    for (const match of value.matchAll(/codex-gestion-([\d.]+)\.vsix/g)) {
      assert.strictEqual(match[1], version, `${name}: wrong VSIX version`);
    }
  }

  const rateLimitSource = text('src/codex/rate-limits.js');
  for (const expected of ['account/rateLimits/read', 'hasCredits', 'unlimited', 'balance', 'accountId']) {
    assert.ok(rateLimitSource.includes(expected), `Missing direct quota/credit support: ${expected}`);
  }

  console.log(`Release ${version}: source and documentation checks passed.`);
}

checkSources();
