import { test } from '@e2e-dev/web';
import { expect } from 'e2e';

// Minimal smoke: one NL step a small local model can actually complete, with
// a locator assertion after it so e2e records the step into the replay cache.
// A second `npx e2e run` should then show `Cache 1 replayed · 0 model calls`.
test('fill the email field', async ({ app, agent, browser }) => {
  await app.open('/simple.html');

  await agent.act('fill the Email field with jordan@example.com');

  await expect(browser.locator('[data-testid="email-input"]')).toHaveValue('jordan@example.com');
});
