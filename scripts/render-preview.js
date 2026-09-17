// Render the production UI with fictional accounts. Never activate the extension
// or read user authentication/session files to make public screenshots.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createRequire } = require('module');
const { pathToFileURL } = require('url');

const root = path.resolve(__dirname, '..');
const output = path.join(root, 'preview', 'generated');
const pkg = require('../package.json');
const NativeDate = Date;
const fixtureNow = NativeDate.parse('2026-09-07T12:05:00+02:00');
class FixtureDate extends NativeDate {
  constructor(...args) { super(...(args.length ? args : [fixtureNow])); }
  static now() { return fixtureNow; }
}

const theme = {
  'font-family': '"Segoe UI", Arial, sans-serif', foreground: '#cccccc', descriptionForeground: '#9d9d9d',
  'editor-background': '#1f1f1f', 'editorWidget-background': '#252526', 'widget-border': '#454545', 'widget-shadow': '#00000040',
  'button-background': '#0078d4', 'button-foreground': '#ffffff', 'button-border': '#ffffff1a', 'button-hoverBackground': '#026ec1',
  'button-secondaryBackground': '#313131', 'button-secondaryForeground': '#cccccc', 'button-secondaryHoverBackground': '#3c3c3c',
  'toolbar-hoverBackground': '#ffffff14', focusBorder: '#0078d4', 'badge-background': '#616161', 'badge-foreground': '#f8f8f8',
  'charts-green': '#89d185', 'charts-orange': '#d7ba7d', 'charts-red': '#f48771', 'textLink-foreground': '#4daafc',
  'textBlockQuote-background': '#2b2b2b', 'inputValidation-errorBorder': '#be1100', 'inputValidation-errorBackground': '#5a1d1d',
  'inputValidation-warningBorder': '#b89500', 'list-hoverBackground': '#2a2d2e', errorForeground: '#f85149'
};
const themeCss = `:root{${Object.entries(theme).map(([k, v]) => `--vscode-${k}:${v}`).join(';')}}`;

function createRenderer(language) {
  const vscode = {
    env: { language }, version: '1.85+',
    workspace: { workspaceFolders: [], getConfiguration: () => ({ get: (_key, fallback) => _key === 'language' ? language : fallback }) },
    Uri: { file: fsPath => ({ fsPath }) },
    MarkdownString: class { constructor() { this.value = ''; } appendMarkdown(value) { this.value += value; } },
    ThemeColor: class { constructor(id) { this.id = id; } }
  };
  const filename = path.join(root, 'src', 'runtime.js');
  const localRequire = createRequire(filename);
  const sandbox = {
    require: name => name === 'vscode' ? vscode : localRequire(name),
    module: { exports: {} }, __dirname: path.dirname(filename), __filename: filename,
    console, Buffer, process, Date: FixtureDate, setTimeout, clearTimeout, setInterval, clearInterval
  };
  const hooks = `
    module.exports.render = (view) => {
      i18n.init(vscode);
      const account = { id: 'demo-work', identity: 'account:demo-work', email: 'alex@example.com', name: 'Alex Morgan', mode: 'chatgpt', hasCredentials: true };
      const activeId = accountProfileId(account);
      latestStats = {
        timestamp: new Date().toISOString(), accountEmail: account.email, accountLabel: account.email,
        quotaSource: 'app-server', quotaCheckedAt: Date.now(), isSnapshotFallback: false,
        contextSource: 'workspace', contextUpdatedAt: new Date().toISOString(), contextPercent: 29,
        activeSessions: 1, rateLimitFingerprint: 'account:' + activeId,
        rateLimits: { account_id: activeId, plan_type: 'plus',
          primary: { used_percent: 37, window_minutes: 300, resets_at: Date.parse('2026-09-07T18:08:00+02:00') / 1000 },
          secondary: { used_percent: 22, window_minutes: 10080, resets_at: Date.parse('2026-09-11T21:20:00+02:00') / 1000 }
        }
      };
      const profiles = [
        { id: activeId, label: 'alex@example.com', email: account.email, name: account.name, mode: 'chatgpt', credentialsStored: true, lastSeen: Date.now(), snapshot: mergeAccountSnapshot({}, latestStats) },
        { id: 'demo-personal', label: '${language === 'es' ? 'Personal' : 'Personal'}', email: 'personal@example.com', name: 'Alex', mode: 'chatgpt', credentialsStored: true, lastSeen: Date.now() - 45 * 60000,
          snapshot: { primaryUsed: 88, secondaryUsed: 44, primaryWindowMinutes: 300, secondaryWindowMinutes: 10080, primaryResetsAt: Date.parse('2026-09-07T16:30:00+02:00') / 1000, secondaryResetsAt: Date.parse('2026-09-12T09:00:00+02:00') / 1000, plan: 'plus', quotaSource: 'account-scoped', rateLimitFingerprint: 'account:demo-personal' }
        }
      ];
      readCurrentAccount = () => account;
      getAccountProfiles = () => profiles;
      buildDiagnostics = () => 'Codex Gestion ${pkg.version}\\nExample data for screenshots.';
      extensionContext = { extension: { packageJSON: ${JSON.stringify(pkg)} }, extensionPath: ${JSON.stringify(root)} };
      latestAuthStatus = { state: 'ok', checkedAt: Date.now(), message: '' };
      lastRefreshAt = Date.now(); lastRefreshDurationMs = 420; scheduledRefreshSeconds = 30;
      if (view === 'pending') { latestStats = null; profiles.forEach(profile => { profile.snapshot = {}; }); }
      currentPlanPolicy = planPolicyFrom(latestStats, profiles[0]);
      dashboardView = view === 'pending' ? 'overview' : view;
      statusItem = { show() {} };
      updateStatusBar(latestStats);
      return { html: dashboardHtml({ cspSource: 'file:', asWebviewUri: uri => pathToFileURL(uri.fsPath).href }), tooltip: (latestStats ? buildTooltip(latestStats) : buildEmptyTooltip()).value, status: statusItem.text };
    };
  `;
  sandbox.pathToFileURL = pathToFileURL;
  vm.runInNewContext(fs.readFileSync(filename, 'utf8') + hooks, sandbox, { filename });
  return sandbox.module.exports.render;
}

function renderAll() {
  fs.mkdirSync(output, { recursive: true });
  global.Date = FixtureDate;
  try {
    for (const language of ['en', 'es']) {
      const render = createRenderer(language);
      for (const view of ['overview', 'accounts', 'pending']) {
        const { html } = render(view);
        const nonce = html.match(/<style nonce="([^"]+)"/)[1];
        const injected = html.replace('</head>', `<style nonce="${nonce}">${themeCss}</style><script nonce="${nonce}">window.acquireVsCodeApi=()=>({postMessage:m=>window.previewMessages.push(m)});window.previewMessages=[];</script></head>`);
        fs.writeFileSync(path.join(output, `${view}-${language}.html`), injected, 'utf8');
      }
      const { tooltip, status } = render('overview');
      const text = status.replace('$(dashboard) ', '');
      fs.writeFileSync(path.join(output, `tooltip-${language}.html`), `<!doctype html><html lang="${language}"><meta charset="utf-8"><title>Codex Gestion ${pkg.version}</title><style>
        *{box-sizing:border-box}body{margin:0;background:#181818;color:#ccc;font:12px "Segoe UI",Arial,sans-serif}
        .capture{padding:18px 18px 0;display:inline-flex;flex-direction:column;align-items:flex-end;gap:12px}
        .hover{padding:4px 8px 8px;border:1px solid #454545;border-radius:4px;background:#202020;box-shadow:0 4px 14px #0004;line-height:1.5}
        .hover img{vertical-align:middle}.hover a{display:inline-block;margin-top:6px}.status{align-self:stretch;border-top:1px solid #2b2b2b;padding:5px 8px;text-align:right;background:#181818}
        .status span{padding:2px 6px}.status svg{vertical-align:-2px;margin-right:5px}
      </style><div class="capture"><div class="hover">${tooltip}</div><div class="status"><span><svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor"><circle cx="8" cy="8" r="6"/><path d="M4 10a4 4 0 0 1 8 0M8 8l3-3"/></svg>${text}</span></div></div></html>`, 'utf8');
    }
    const links = ['overview-en','accounts-en','overview-es','accounts-es','tooltip-en','tooltip-es'];
    fs.writeFileSync(path.join(output, 'index.html'), `<!doctype html><meta charset="utf-8"><title>Codex Gestion ${pkg.version} preview</title><style>body{font:16px system-ui;background:#181818;color:#ddd;padding:40px}a{color:#60a5fa}li{margin:16px}</style><h1>Codex Gestion ${pkg.version}</h1><p>Production renderer · fictional accounts · Dark Modern theme tokens</p><ul>${links.map(name=>`<li><a href="${name}.html">${name}</a></li>`).join('')}</ul>`);
  } finally { global.Date = NativeDate; }
  console.log(`Rendered production UI previews: ${output}`);
}

if (require.main === module) renderAll();
module.exports = { renderAll };
