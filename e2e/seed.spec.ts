// Seed for the Playwright test agents (planner / generator / healer): every generated test starts
// from this state - signed in as the Project Manager on the Projects page of the E2E server.
import { test, expect } from '@playwright/test';

const PASSWORD = 'E2ePassword123'; // matches DEMO_PASSWORD in playwright.config.js webServer.env

test.describe('Test group', () => {
  test('seed', async ({ page }) => {
    await page.goto('/#/login');
    await page.fill('input[name=email]', 'pm@demo.local');
    await page.fill('input[name=password]', PASSWORD);
    await page.click('button:has-text("Sign in")');
    await expect(page.getByRole('heading', { name: 'Projects' })).toBeVisible();
  });
});
