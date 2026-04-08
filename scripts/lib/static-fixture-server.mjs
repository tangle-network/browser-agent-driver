/**
 * Tiny static HTTP server for serving local fixture HTML to bench scenarios
 * that use `__FIXTURE_BASE_URL__/...` placeholders. Used by run-tier1-gate
 * and run-multi-rep so they share one implementation.
 *
 * Returns { baseUrl, close }. Listens on 127.0.0.1, ephemeral port.
 */

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

export async function startStaticFixtureServer(root) {
  const server = http.createServer((req, res) => {
    const rawPath = decodeURIComponent((req.url || '/').split('?')[0]);
    const safePath = rawPath === '/' ? '/index.html' : rawPath;
    const normalized = path.normalize(safePath).replace(/^(\.\.[/\\])+/, '');
    const filePath = path.join(root, normalized);
    if (!filePath.startsWith(root)) {
      res.statusCode = 403;
      res.end('Forbidden');
      return;
    }
    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      res.statusCode = 404;
      res.end('Not Found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const contentType =
      ext === '.html'
        ? 'text/html; charset=utf-8'
        : ext === '.js'
          ? 'text/javascript; charset=utf-8'
          : ext === '.css'
            ? 'text/css; charset=utf-8'
            : 'application/octet-stream';
    res.setHeader('Content-Type', contentType);
    res.end(fs.readFileSync(filePath));
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}
