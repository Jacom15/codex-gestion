const assert = require('assert');
const path = require('path');
const Module = require('module');

const commands = new Map();
const executedCommands = [];
const storage = new Map();
const secrets = new Map();
let dashboardPanel = null;
let dashboardMessageHandler = null;
const statusItem = {
  text: '',
  tooltip: null,
  backgroundColor: undefined,
  shown: false,
  show() {
    this.shown = true;
  },
  dispose() {}
};

class MarkdownString {
  constructor() {
    this.value = '';
    this.isTrusted = false;
  }

  appendMarkdown(value) {
    this.value += value;
  }
}

const disposable = () => ({ dispose() {} });
const vscodeMock = {
  MarkdownString,
  ThemeColor: class ThemeColor {
    constructor(id) {
      this.id = id;
    }
  },
  StatusBarAlignment: { Right: 2 },
  ViewColumn: { Beside: 2 },
  Uri: {
    file(filePath) {
      return { fsPath: filePath, toString: () => filePath };
    }
  },
  commands: {
    registerCommand(name, handler) {
      commands.set(name, handler);
      return disposable();
    },
    async getCommands() {
      return ['chatgpt.openSidebar'];
    },
    async executeCommand(name) {
      executedCommands.push(name);
    }
  },
  workspace: {
    workspaceFolders: [{ uri: { fsPath: path.resolve(__dirname, '..') } }],
    getConfiguration() {
      return {
        get(name, fallback) {
          return fallback;
        }
      };
    },
    onDidChangeConfiguration() {
      return disposable();
    },
    async openTextDocument(filePath) {
      return { uri: { fsPath: filePath } };
    }
  },
  window: {
    createOutputChannel() {
      return {
        clear() {},
        appendLine() {},
        show() {},
        dispose() {}
      };
    },
    createStatusBarItem() {
      return statusItem;
    },
    async showTextDocument() {},
    async showInformationMessage() {},
    async showWarningMessage() {},
    async showQuickPick() {},
    createTerminal() {
      return {
        show() {},
        sendText() {},
        dispose() {}
      };
    },
    createWebviewPanel() {
      dashboardPanel = {
        reveal() {},
        onDidDispose() {
          return disposable();
        },
        webview: {
          html: '',
          cspSource: 'vscode-resource:',
          asWebviewUri(uri) {
            return `vscode-resource:${uri.fsPath}`;
          },
          onDidReceiveMessage(handler) {
            dashboardMessageHandler = handler;
            return disposable();
          }
        }
      };
      return dashboardPanel;
    }
  }
};

const originalLoad = Module._load;
Module._load = function load(request, parent, isMain) {
  if (request === 'vscode') return vscodeMock;
  return originalLoad.call(this, request, parent, isMain);
};

const extension = require('../extension');
Module._load = originalLoad;

const context = {
  subscriptions: [],
  extension: { packageJSON: require('../package.json') },
  extensionPath: path.resolve(__dirname, '..'),
  globalState: {
    get(key, fallback) {
      return storage.has(key) ? storage.get(key) : fallback;
    },
    async update(key, value) {
      storage.set(key, value);
    }
  },
  secrets: {
    async get(key) {
      return secrets.get(key);
    },
    async store(key, value) {
      secrets.set(key, value);
    },
    async delete(key) {
      secrets.delete(key);
    }
  }
};

(async () => {
  extension.activate(context);
  await new Promise(resolve => setTimeout(resolve, 1000));

  assert.strictEqual(commands.has('codexGestion.refresh'), true);
  assert.strictEqual(commands.has('codexGestion.addAccount'), true);
  assert.strictEqual(commands.has('codexGestion.switchAccount'), true);
  assert.strictEqual(commands.has('codexGestion.manageAccounts'), true);
  assert.strictEqual(commands.has('codexGestion.openProjectContext'), true);
  assert.strictEqual(statusItem.shown, true);
  assert.notStrictEqual(statusItem.text, '');
  assert.match(statusItem.tooltip.value, /Cuota 5 h/);
  assert.match(statusItem.tooltip.value, /Cuota 7 dias/);
  assert.match(statusItem.tooltip.value, /(% libre[\s\S]*% usado|Sin lectura visual todavia)/);
  assert.match(statusItem.tooltip.value, /(<img src="data:image\/svg\+xml;base64,|Sin lectura visual todavia)/);
  assert.match(statusItem.tooltip.value, /Cuota 5 h[\s\S]*---[\s\S]*Cuota 7 dias[\s\S]*---[\s\S]*Actualizado/);
  assert.match(statusItem.tooltip.value, /command:codexGestion\.refresh/);
  assert.match(statusItem.tooltip.value, /command:codexGestion\.showDashboard/);
  assert.doesNotMatch(statusItem.tooltip.value, /command:codexGestion\.switchAccount/);
  assert.doesNotMatch(statusItem.tooltip.value, /command:codexGestion\.addAccount/);
  assert.doesNotMatch(statusItem.tooltip.value, /command:codexGestion\.openProjectContext/);

  storage.set('accountProfiles', [{
    id: 'historical-profile',
    label: 'Cuenta historica',
    mode: 'chatgpt',
    lastSeen: Date.now(),
    credentialsStored: true,
    snapshot: { primaryUsed: 20, secondaryUsed: 30, plan: 'plus' }
  }]);
  await commands.get('codexGestion.showDashboard')();
  assert.ok(dashboardPanel);
  assert.match(dashboardPanel.webview.html, /Panel de uso de Codex/);
  assert.match(dashboardPanel.webview.html, /Gestion de cuentas/);
  assert.match(dashboardPanel.webview.html, /Contexto proyecto/);
  assert.match(dashboardPanel.webview.html, /chart\.umd\.min\.js/);
  assert.match(dashboardPanel.webview.html, /metric-chart/);
  assert.doesNotMatch(dashboardPanel.webview.html, /Contexto del chat detectado/);
  assert.match(dashboardPanel.webview.html, /Cambiar cuenta/);
  assert.match(dashboardPanel.webview.html, /Agregar cuenta/);
  assert.match(dashboardPanel.webview.html, /data-action="accountCard"/);
  assert.match(dashboardPanel.webview.html, />Renombrar<\/button>/);
  assert.match(dashboardPanel.webview.html, />Eliminar<\/button>/);
  assert.doesNotMatch(dashboardPanel.webview.html, /Editar alias/);
  assert.doesNotMatch(dashboardPanel.webview.html, /Codex Switch/);

  extension.deactivate();
  for (const item of context.subscriptions) {
    if (item && typeof item.dispose === 'function') item.dispose();
  }
  console.log('Codex Gestion activation smoke test passed.');
})().catch(error => {
  extension.deactivate();
  console.error(error);
  process.exitCode = 1;
});
