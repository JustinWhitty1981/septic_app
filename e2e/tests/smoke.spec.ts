import { test, expect } from '@playwright/test';

// The seeded e2e account (role: admin). Created with:
//   docker compose exec backend npm run seed:user -- \
//     --email=e2e@septic.test --role=admin --first=E2E --last=Runner \
//     --password='E2e-Run!2026-x7'
const EMAIL = process.env.E2E_EMAIL ?? 'e2e@septic.test';
const PASSWORD = process.env.E2E_PASSWORD ?? 'E2e-Run!2026-x7';

test.describe('sign-in gate', () => {
  test('app shell loads and shows the login screen', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveTitle(/Septic Service/);
    await expect(page.getByRole('heading', { name: 'Septic Service' })).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Email Address' })).toBeVisible();
  });

  test('the frontend dev proxy reaches the backend', async ({ request }) => {
    const res = await request.get('/api/health');
    expect(res.status()).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ status: 'ok' });
  });

  test('bad credentials are refused without reaching a protected screen', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('textbox', { name: 'Email Address' }).fill(EMAIL);
    await page.locator('#password').fill('wrong-password');
    await page.getByRole('button', { name: 'Sign In' }).click();
    await expect(page.getByRole('alert')).toBeVisible();
    await expect(page).toHaveURL(/\/(login)?$/);
  });
});

test.describe('authenticated office surface', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.getByRole('textbox', { name: 'Email Address' }).fill(EMAIL);
    await page.locator('#password').fill(PASSWORD);
    await page.getByRole('button', { name: 'Sign In' }).click();
    await expect(page.getByRole('link', { name: 'Due queue' })).toBeVisible();
  });

  test('admin sees the office menu', async ({ page }) => {
    await expect(page.getByRole('link', { name: 'Schedule' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Import rejects' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Find a site' })).toBeVisible();
  });

  test('due queue renders rows from the computed view', async ({ page }) => {
    await page.getByRole('link', { name: 'Due queue' }).click();
    await expect(page).toHaveURL(/\/due-queue/);
    await expect(page.getByText(/overdue/i).first()).toBeVisible();
  });

  test('log out returns to the login screen', async ({ page }) => {
    await page.getByRole('button', { name: /log ?out/i }).click();
    await expect(page.getByRole('button', { name: 'Sign In' })).toBeVisible();
  });
});
