import { expect, test } from '@playwright/test';

import { API_ORIGIN } from '../playwright.config';

test('a visitor mints sandbox keys and runs contract examples from the public docs', async ({ page }) => {
  await page.goto(`${API_ORIGIN}/docs`);
  await expect(page.getByRole('heading', { name: 'Purse API', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Mint sandbox keys' }).click();
  await expect(page.locator('#keys')).toContainText('sk_sandbox_');
  await expect(page.locator('#keys')).toContainText('pk_sandbox_');

  await page.getByLabel('Request example').selectOption({ label: 'POST /v1/users — users.create' });
  await page.getByLabel('JSON request body').fill(JSON.stringify({ externalId: `docs-smoke-${Date.now()}` }));
  await page.getByRole('button', { name: 'Run request' }).click();
  await expect(page.locator('#response')).toContainText('HTTP 201');
  await expect(page.getByRole('status')).toHaveText('Complete.');
  const firstRequest = await page.locator('#request').innerText();
  expect(firstRequest).toContain('Idempotency-Key:');

  await page.getByLabel('Request example').selectOption({ label: 'GET /v1/users/usr_<id> — users.get' });
  await expect(page.locator('#path')).toHaveValue(/\/v1\/users\/usr_[0-9a-f-]{36}$/);
  await page.getByRole('button', { name: 'Run request' }).click();
  await expect(page.locator('#response')).toContainText('HTTP 200');
  await expect(page.getByRole('status')).toHaveText('Complete.');

  // An edited path cannot send the sandbox credential to another origin.
  await page.locator('#path').fill('https://example.com/v1/users');
  await page.getByRole('button', { name: 'Run request' }).click();
  await expect(page.getByRole('status')).toContainText('Use a /v1/ path on this API origin.');
  await page.reload();
  await expect(page.locator('#keys')).toHaveText('No keys minted.');
  await expect(page.getByRole('button', { name: 'Run request' })).toBeDisabled();
});
