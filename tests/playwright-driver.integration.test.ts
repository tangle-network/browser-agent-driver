import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { chromium, type Browser } from 'playwright';
import { PlaywrightDriver } from '../src/drivers/playwright.js';

describe('PlaywrightDriver integration', () => {
  let server: Server;
  let browser: Browser;
  let baseUrl: string;

  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url === '/next') {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('<html><body><h1>Next Page</h1></body></html>');
        return;
      }

      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(`<!doctype html>
<html>
  <body>
    <h1>Driver Test</h1>
    <button id="increment">Increment</button>
    <button id="next">Go next</button>
    <p id="count">Count: 0</p>
    <script>
      const count = document.getElementById('count');
      let n = 0;
      document.getElementById('increment').addEventListener('click', () => {
        n += 1;
        count.textContent = 'Count: ' + n;
      });
      document.getElementById('next').addEventListener('click', () => {
        window.location.href = '/next';
      });
    </script>
  </body>
</html>`);
    });

    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
    browser = await chromium.launch({ headless: true });
  }, 30_000);

  afterAll(async () => {
    await browser.close();
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  it('observes and executes actions by stable @ref selectors', async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    const driver = new PlaywrightDriver(page, { captureScreenshots: false });

    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });

    const first = await driver.observe();
    expect(first.snapshot).toContain('button "Increment"');
    expect(first.snapshot).toContain('paragraph');

    const incrementRef = first.snapshot.match(/button "Increment" \[ref=([^\]]+)\]/)?.[1];
    expect(incrementRef).toBeTruthy();

    const clickResult = await driver.execute({ action: 'click', selector: `@${incrementRef}` });
    expect(clickResult.success).toBe(true);
    const countText = await page.locator('#count').textContent();
    expect(countText).toBe('Count: 1');

    const second = await driver.observe();
    expect(second.snapshot).toContain('button "Go next"');

    const nextRef = second.snapshot.match(/button "Go next" \[ref=([^\]]+)\]/)?.[1];
    expect(nextRef).toBeTruthy();

    const nextClick = await driver.execute({ action: 'click', selector: `@${nextRef}` });
    expect(nextClick.success).toBe(true);

    await page.waitForURL(`${baseUrl}/next`);
    const third = await driver.observe();
    expect(third.url).toContain('/next');
    expect(third.snapshot).toContain('heading "Next Page"');

    await driver.close();
    await context.close();
  }, 45_000);

  it('does not dismiss the target dialog before clicking an element inside it', async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    const driver = new PlaywrightDriver(page, { captureScreenshots: false });

    await page.setContent(`<!doctype html>
<html>
  <body>
    <div id="modal" role="dialog">
      <button aria-label="Close" id="close">Close</button>
      <button id="other">Other sign-in options</button>
    </div>
    <script>
      window.__clicked = 0;
      document.getElementById('close').addEventListener('click', () => {
        document.getElementById('modal').style.display = 'none';
      });
      document.getElementById('other').addEventListener('click', () => {
        window.__clicked += 1;
      });
    </script>
  </body>
</html>`, { waitUntil: 'domcontentloaded' });

    const state = await driver.observe();
    const otherRef = state.snapshot.match(/button "Other sign-in options" \[ref=([^\]]+)\]/)?.[1];
    expect(otherRef).toBeTruthy();

    const clickResult = await driver.execute({ action: 'click', selector: `@${otherRef}` });
    expect(clickResult.success).toBe(true);

    const clicked = await page.evaluate(() => (window as unknown as { __clicked: number }).__clicked);
    const modalDisplay = await page.locator('#modal').evaluate((el) => getComputedStyle(el).display);
    expect(clicked).toBe(1);
    expect(modalDisplay).not.toBe('none');

    await driver.close();
    await context.close();
  }, 45_000);

  it('follows links that open in a new tab', async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    const driver = new PlaywrightDriver(page, { captureScreenshots: false });

    await page.setContent(`<!doctype html>
<html>
  <body>
    <h1>Popup Test</h1>
    <a href="${baseUrl}/next" target="_blank">Open next in new tab</a>
  </body>
</html>`, { waitUntil: 'domcontentloaded' });

    const state = await driver.observe();
    const linkRef = state.snapshot.match(/link "Open next in new tab" \[ref=([^\]]+)\]/)?.[1];
    expect(linkRef).toBeTruthy();

    const clickResult = await driver.execute({ action: 'click', selector: `@${linkRef}` });
    expect(clickResult.success).toBe(true);

    const followedPage = driver.getPage();
    expect(followedPage).toBeTruthy();
    await followedPage!.waitForURL(`${baseUrl}/next`);

    const nextState = await driver.observe();
    expect(nextState.url).toBe(`${baseUrl}/next`);
    expect(nextState.snapshot).toContain('heading "Next Page"');

    await driver.close();
    await context.close();
  }, 45_000);
});
