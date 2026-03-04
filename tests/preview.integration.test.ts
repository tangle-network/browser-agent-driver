import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { chromium, type Browser } from 'playwright';
import { verifyPreview } from '../src/preview.js';
import { AriaSnapshotHelper } from '../src/drivers/snapshot.js';

describe('Preview verification integration', () => {
  let browser: Browser;
  let appServer: Server;
  let hostServer: Server;
  let appBaseUrl: string;
  let hostBaseUrl: string;

  beforeAll(async () => {
    appServer = createServer((req, res) => {
      if (req.url === '/error') {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('<html><body><vite-error-overlay></vite-error-overlay></body></html>');
        return;
      }

      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(`<!doctype html>
<html>
  <head><title>Preview App</title></head>
  <body>
    <main>
      <h1>Live Preview Ready</h1>
      <button id="save">Save</button>
    </main>
  </body>
</html>`);
    });

    hostServer = createServer((req, res) => {
      if (req.url === '/no-iframe') {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('<html><body><h1>No Preview Iframe</h1></body></html>');
        return;
      }

      const previewPath = req.url === '/host-error' ? '/error' : '/';
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(`<!doctype html>
<html>
  <head><title>Host Page</title></head>
  <body>
    <h1>Builder Host</h1>
    <iframe title="Preview" src="__APP_BASE__${previewPath}" width="800" height="500"></iframe>
  </body>
</html>`);
    });

    await new Promise<void>((resolve) => appServer.listen(0, '127.0.0.1', () => resolve()));
    await new Promise<void>((resolve) => hostServer.listen(0, '127.0.0.1', () => resolve()));
    const appAddr = appServer.address() as AddressInfo;
    const hostAddr = hostServer.address() as AddressInfo;
    appBaseUrl = `http://127.0.0.1:${appAddr.port}`;
    hostBaseUrl = `http://127.0.0.1:${hostAddr.port}`;

    hostServer.removeAllListeners('request');
    hostServer.on('request', (req, res) => {
      if (req.url === '/no-iframe') {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('<html><body><h1>No Preview Iframe</h1></body></html>');
        return;
      }
      const previewPath = req.url === '/host-error' ? '/error' : '/';
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(`<!doctype html>
<html>
  <head><title>Host Page</title></head>
  <body>
    <h1>Builder Host</h1>
    <iframe title="Preview" src="${appBaseUrl}${previewPath}" width="800" height="500"></iframe>
  </body>
</html>`);
    });

    browser = await chromium.launch({ headless: true });
  }, 30_000);

  afterAll(async () => {
    await browser.close();
    await new Promise<void>((resolve, reject) => appServer.close((err) => (err ? reject(err) : resolve())));
    await new Promise<void>((resolve, reject) => hostServer.close((err) => (err ? reject(err) : resolve())));
  });

  it('navigates to preview iframe URL, verifies app, and returns to host page', async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`${hostBaseUrl}/host-ok`, { waitUntil: 'domcontentloaded' });

    const snapshot = new AriaSnapshotHelper();
    const result = await verifyPreview(page, snapshot, { captureScreenshot: true, screenshotQuality: 40 });

    expect(result).not.toBeNull();
    expect(result?.previewUrl).toContain(appBaseUrl);
    expect(result?.appLoaded).toBe(true);
    expect(result?.title).toBe('Preview App');
    expect(result?.snapshot).toContain('heading "Live Preview Ready"');
    expect(result?.screenshot).toBeTruthy();
    expect(result?.errors.length).toBe(0);

    expect(page.url()).toContain('/host-ok');
    await context.close();
  }, 30_000);

  it('returns null when no preview iframe exists', async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`${hostBaseUrl}/no-iframe`, { waitUntil: 'domcontentloaded' });

    const snapshot = new AriaSnapshotHelper();
    const result = await verifyPreview(page, snapshot, { captureScreenshot: false });

    expect(result).toBeNull();
    await context.close();
  }, 30_000);

  it('flags preview errors when overlay-like failure markers are present', async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`${hostBaseUrl}/host-error`, { waitUntil: 'domcontentloaded' });

    const snapshot = new AriaSnapshotHelper();
    const result = await verifyPreview(page, snapshot, { captureScreenshot: false });

    expect(result).not.toBeNull();
    expect(result?.appLoaded).toBe(false);
    expect(result?.errors.join(' ')).toMatch(/overlay|blank/i);
    await context.close();
  }, 30_000);
});
