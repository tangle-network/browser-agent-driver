/**
 * browser-agent-driver#177: a batch of clicks planned from one observation
 * must act on the elements the model saw, even after the first click
 * re-renders the list.
 *
 * Fixture: a saucedemo-shaped inventory with one "Add to cart" button per
 * product. Clicking a button adds the product and re-renders the whole list,
 * so the clicked button turns into "Remove" and every later "Add to cart"
 * shifts down one position. The model's batch from the issue,
 * clickSequence [@add, @add_1] ("Backpack, then Bike Light"), used to land
 * its second click on the Bolt T-Shirt.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { chromium, type Browser, type Page } from 'playwright';
import { PlaywrightDriver } from '../src/drivers/playwright.js';
import { quoteIsOnPage } from '../src/brain/tasks/goal-verification.js';

const INVENTORY_HTML = `<!doctype html>
<html><body>
  <h1>Products</h1>
  <ul id="inventory"></ul>
  <script>
    const products = ['Sauce Labs Backpack', 'Sauce Labs Bike Light', 'Sauce Labs Bolt T-Shirt'];
    const cart = [];
    const keyed = new URLSearchParams(location.search).has('keyed');
    const buttons = new Map();
    function render() {
      const list = document.getElementById('inventory');
      if (!keyed) { list.replaceChildren(); buttons.clear(); }
      for (const name of products) {
        let button = buttons.get(name);
        if (!button) {
          const item = document.createElement('li');
          const title = document.createElement('span');
          title.textContent = name;
          button = document.createElement('button');
          button.addEventListener('click', () => {
            const at = cart.indexOf(name);
            if (at >= 0) cart.splice(at, 1); else cart.push(name);
            render();
          });
          buttons.set(name, button);
          item.append(title, button);
          list.append(item);
        }
        button.textContent = cart.includes(name) ? 'Remove' : 'Add to cart';
      }
      window.cart = cart.slice();
    }
    render();
  </script>
</body></html>`;

function addToCartRefs(snapshot: string): string[] {
  return [...snapshot.matchAll(/button "Add to cart" \[ref=([^\]]+)\]/g)].map((m) => `@${m[1]}`);
}

function refAfterText(snapshot: string, text: string, buttonName: string): string | undefined {
  const lines = snapshot.split('\n');
  const at = lines.findIndex((line) => line.includes(text));
  if (at < 0) return undefined;
  for (const line of lines.slice(at + 1)) {
    const match = line.match(new RegExp(`button "${buttonName}" \\[ref=([^\\]]+)\\]`));
    if (match) return `@${match[1]}`;
  }
  return undefined;
}

const cartOf = (page: Page) => page.evaluate(() => (window as unknown as { cart: string[] }).cart);

describe('batched clicks after the first click re-renders the list (#177)', () => {
  let server: Server;
  let browser: Browser;
  let baseUrl: string;

  beforeAll(async () => {
    server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(INVENTORY_HTML);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
    browser = await chromium.launch({ headless: true });
  }, 30_000);

  afterAll(async () => {
    await browser?.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('never clicks the shifted button: binds to the observed element or stops the batch', async () => {
    const page = await (await browser.newContext()).newPage();
    const driver = new PlaywrightDriver(page, { captureScreenshots: false });

    // 1. Full re-render (new nodes): the second ref's element is gone after
    //    the first click. The batch must stop instead of clicking whatever
    //    "Add to cart" now sits at that position.
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
    let observed = await driver.observe();
    let [backpack, bikeLight] = addToCartRefs(observed.snapshot);
    expect(backpack).toBeTruthy();
    expect(bikeLight).toBeTruthy();

    let result = await driver.execute({ action: 'clickSequence', refs: [backpack!, bikeLight!] });
    expect(await cartOf(page)).toEqual(['Sauce Labs Backpack']);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/changed since the last observation/);

    // Same batch as a primary click plus a follow-up click (nextActions).
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
    observed = await driver.observe();
    [backpack, bikeLight] = addToCartRefs(observed.snapshot);
    expect((await driver.execute({ action: 'click', selector: backpack! })).success).toBe(true);
    result = await driver.execute({ action: 'click', selector: bikeLight! });
    expect(await cartOf(page)).toEqual(['Sauce Labs Backpack']);
    expect(result.success).toBe(false);

    // Observing again shows which button belongs to which product.
    observed = await driver.observe();
    const freshBikeLight = refAfterText(observed.snapshot, 'Sauce Labs Bike Light', 'Add to cart');
    expect(freshBikeLight).toBeTruthy();
    expect((await driver.execute({ action: 'click', selector: freshBikeLight! })).success).toBe(true);
    expect(await cartOf(page)).toEqual(['Sauce Labs Backpack', 'Sauce Labs Bike Light']);

    // 2. Keyed re-render (nodes kept, as React does on saucedemo): the second
    //    button is still the same element with the same name, so the whole
    //    batch runs and adds exactly the two products the model chose.
    await page.goto(`${baseUrl}?keyed`, { waitUntil: 'domcontentloaded' });
    observed = await driver.observe();
    [backpack, bikeLight] = addToCartRefs(observed.snapshot);
    result = await driver.execute({ action: 'clickSequence', refs: [backpack!, bikeLight!] });
    expect(result.success).toBe(true);
    expect(await cartOf(page)).toEqual(['Sauce Labs Backpack', 'Sauce Labs Bike Light']);
  }, 60_000);
});

describe('page text the goal verifier quotes (#177)', () => {
  let browser: Browser;
  beforeAll(async () => { browser = await chromium.launch({ headless: true }); }, 30_000);
  afterAll(async () => { await browser?.close(); });

  it('keeps one rendered text run on one line and never stitches separate records into a value', async () => {
    const page = await (await browser.newContext()).newPage();
    const driver = new PlaywrightDriver(page, { captureScreenshots: false });
    // React renders "Item total: $" and the amount as two text nodes.
    await page.setContent('<main><div>Item total: $<!-- -->39.98</div><div>New <!-- -->York</div><div>Tax: $3</div><div>9.98</div></main>');
    const { snapshot } = await driver.observe();
    expect(snapshot).toContain('- text: Item total: $39.98');
    expect(snapshot).toContain('- text: New York');
    expect(quoteIsOnPage('Item total: $39.98', [{ text: snapshot }])).toBe(true);
    expect(quoteIsOnPage('Tax: $39.98', [{ text: snapshot }])).toBe(false);
  }, 30_000);

  // Live 0.38.2 runs: login spent up to 14 turns because the verifier's "Logged in as tomsmith"
  // spans two snapshot lines, and todo rep 4 lost a correct end state to rejected list quotes.
  it('accepts a quote that runs across adjacent lines or omits snapshot markup (login, todo-4 shape)', async () => {
    const page = await (await browser.newContext()).newPage();
    const driver = new PlaywrightDriver(page, { captureScreenshots: false });
    await page.setContent(`<main>
      <h2>Secure Area</h2><p>Logged in as <span>tomsmith</span></p>
      <ul>
        <li><input type="checkbox" aria-label="Toggle Todo"><label>buy milk</label></li>
        <li><input type="checkbox" aria-label="Toggle Todo" checked><label>write report</label></li>
        <li><input type="checkbox" aria-label="Toggle Todo"><label>call Ana</label></li>
      </ul>
      <div>Tax: $3</div><div>9.98</div>
    </main>`);
    const { snapshot } = await driver.observe();
    const onPage = (quote: string) => quoteIsOnPage(quote, [{ text: snapshot }]);
    expect(snapshot).not.toContain('Logged in as tomsmith'); // two text runs, two lines
    expect(onPage('Logged in as tomsmith')).toBe(true);
    expect(onPage('checkbox "Toggle Todo" [checked]\nLabelText\nwrite report')).toBe(true);
    expect(onPage('buy milk ... write report ... call Ana')).toBe(true);
    // Still refused: a value stitched from two records, and text the page does not show.
    expect(onPage('Tax: $39.98')).toBe(false);
    expect(onPage('Logged in as admin')).toBe(false);
    expect(onPage('checkbox "Toggle Todo" [checked]\nLabelText\ncall Ana')).toBe(false);
  }, 30_000);
});
