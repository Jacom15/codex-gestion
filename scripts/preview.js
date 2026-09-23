const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

const root = path.resolve(__dirname, '..');
const preferredPort = Number(process.env.PORT || 5177);
const clients = new Set();
const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.json': 'application/json; charset=utf-8'
};

let renderRunning = false;
let renderQueued = false;
let renderTimer = null;

function sendFile(response, filePath) {
  const normalized = path.resolve(filePath);
  if (!normalized.startsWith(root)) {
    response.writeHead(403);
    response.end('Forbidden');
    return;
  }
  fs.readFile(normalized, (error, content) => {
    if (error) {
      response.writeHead(error.code === 'ENOENT' ? 404 : 500);
      response.end(error.code === 'ENOENT' ? 'Not found' : 'Server error');
      return;
    }
    response.writeHead(200, {
      'Content-Type': mimeTypes[path.extname(normalized)] || 'application/octet-stream',
      'Cache-Control': 'no-store'
    });
    response.end(content);
  });
}

function broadcastReload() {
  for (const response of clients) {
    response.write('event: reload\n');
    response.write(`data: ${Date.now()}\n\n`);
  }
}

function injectLiveReload(filePath) {
  if (!fs.existsSync(filePath)) return;
  const html = fs.readFileSync(filePath, 'utf8');
  if (html.includes('/__events')) return;
  const nonce = html.match(/<script nonce=\"([^\"]+)\"/)?.[1] || html.match(/<style nonce=\"([^\"]+)\"/)?.[1] || null;
  const nonceAttr = nonce ? ` nonce=\"${nonce}\"` : '';
  const script = `<script${nonceAttr}>(()=>{const e=new EventSource('/__events');e.addEventListener('reload',()=>location.reload());})();</script>`;
  fs.writeFileSync(
    filePath,
    html.includes('</body>') ? html.replace('</body>', `${script}</body>`) : `${html}${script}`,
    'utf8'
  );
}

function injectLiveReloadIntoGenerated() {
  const generated = path.join(root, 'preview', 'generated');
  if (!fs.existsSync(generated)) return;
  for (const file of fs.readdirSync(generated)) {
    if (file.endsWith('.html')) injectLiveReload(path.join(generated, file));
  }
}

function renderPreview() {
  if (renderRunning) {
    renderQueued = true;
    return;
  }

  renderRunning = true;
  const child = spawn(process.execPath, [path.join(root, 'scripts', 'render-preview.js')], {
    cwd: root,
    stdio: 'inherit'
  });
  child.on('exit', code => {
    renderRunning = false;
    if (code === 0) {
      injectLiveReloadIntoGenerated();
      broadcastReload();
    } else {
      console.error(`Preview render failed with exit code ${code}.`);
    }

    if (renderQueued) {
      renderQueued = false;
      renderPreview();
    }
  });
}

function scheduleRender() {
  clearTimeout(renderTimer);
  renderTimer = setTimeout(renderPreview, 120);
}

const server = http.createServer((request, response) => {
  const address = server.address();
  const currentPort = typeof address === 'object' && address ? address.port : preferredPort;
  const url = new URL(request.url, `http://localhost:${currentPort}`);
  if (url.pathname === '/__events') {
    response.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive'
    });
    response.write('\n');
    clients.add(response);
    request.on('close', () => clients.delete(response));
    return;
  }
  if (url.pathname === '/') {
    sendFile(response, path.join(root, 'preview', 'generated', 'overview-es.html'));
    return;
  }
  if (url.pathname === '/launcher' || url.pathname === '/index.html') {
    sendFile(response, path.join(root, 'preview', 'generated', 'index.html'));
    return;
  }

  const requestedPath = decodeURIComponent(url.pathname).replace(/^\/+/, '');
  if (/^(overview|accounts|pending|tooltip)-(en|es)\.html$|^credits-(none|unlimited|unknown|normal)-(en|es)\.html$/.test(requestedPath)) {
    sendFile(response, path.join(root, 'preview', 'generated', requestedPath));
    return;
  }

  sendFile(response, path.join(root, requestedPath));
});

function shouldIgnore(filename) {
  const value = String(filename || '').replace(/\\/g, '/');
  return !value || value.startsWith('generated/') || value.includes('codex-gestion-');
}

for (const target of ['src', 'media']) {
  const fullPath = path.join(root, target);
  if (!fs.existsSync(fullPath)) continue;
  fs.watch(fullPath, { recursive: true }, (_event, filename) => {
    if (shouldIgnore(filename)) return;
    scheduleRender();
  });
}

for (const file of ['package.json', path.join('scripts', 'render-preview.js')]) {
  const fullPath = path.join(root, file);
  if (!fs.existsSync(fullPath)) continue;
  fs.watchFile(fullPath, { interval: 750 }, (current, previous) => {
    if (current.mtimeMs !== previous.mtimeMs) scheduleRender();
  });
}

function listen(port, attemptsLeft = 10) {
  server.once('error', error => {
    if (error.code === 'EADDRINUSE' && attemptsLeft > 0) {
      listen(port + 1, attemptsLeft - 1);
      return;
    }
    throw error;
  });
  server.listen(port, () => {
    const address = server.address();
    const currentPort = typeof address === 'object' && address ? address.port : port;
    console.log(`Codex Gestion preview running at http://localhost:${currentPort}`);
    if (currentPort !== preferredPort) {
      console.log(`Port ${preferredPort} was busy, so preview used ${currentPort}.`);
    }
    console.log('Production preview is regenerated and reloaded automatically after source changes.');
    renderPreview();
  });
}

listen(preferredPort);
