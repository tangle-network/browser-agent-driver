import { test } from '@e2e-dev/web';
import { expect } from 'e2e';

// Spike suite for the harness-adapter RFC (docs/rfc/driver-pluggable-pivot-2026-10.md):
// the same multi-step form used by bench/competitive/tasks/form-fill-multi-step.json,
// expressed as three natural-language agent steps plus a locator assertion that
// confirms the agent steps and lets e2e record them into its replay cache.
test('multi-step account creation form', async ({ app, agent, browser }) => {
  await app.open('/form.html');

  await agent.act(
    "Complete step 1 of the form: first name Jordan, last name Rivera, date of birth 1990-04-15, gender 'other'; then click Next",
  );
  await agent.act(
    'Complete step 2 of the form: email jordan.rivera@example.com, phone 555-0142, street address 742 Evergreen Terrace, city Seattle, state Washington (WA), ZIP 98101; then click Next',
  );
  await agent.act(
    "Complete step 3 of the form: select plan 'Pro ($9/mo)', check SMS notifications, Push notifications, and Weekly digest, bio 'Senior engineer building reliable browser automation.', website https://jordan.example.com, check Terms of Service and Privacy Policy; then click Create Account",
  );

  await expect(browser.locator('text=Account Created!')).toBeVisible();
});
