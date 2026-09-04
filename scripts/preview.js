const fs = require('fs');
const http = require('http');
const path = require('path');

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
    sendFile(response, path.join(root, 'preview', 'index.html'));
    return;
  }
  sendFile(response, path.join(root, decodeURIComponent(url.pathname)));
});

const watchTargets = ['preview', 'src', 'media', 'package.json'];
for (const target of watchTargets) {
  const fullPath = path.join(root, target);
  if (!fs.existsSync(fullPath)) continue;
  fs.watch(fullPath, { recursive: true }, (_event, filename) => {
    if (filename && String(filename).includes('codex-gestion-')) return;
    broadcastReload();
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
    console.log('Watching preview/, src/, media/, and package.json for live reload.');
  });
}

listen(preferredPort);
