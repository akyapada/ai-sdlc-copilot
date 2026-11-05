// Positive end-to-end flow with the handbook sample: the journey a real team performs, all through the UI.
// PM uploads and approves requirements -> Architect approves architecture -> PM approves tasks
// -> QA approves tests -> PM checks traceability, exports and the audit trail.
import path from 'node:path';
import { test, expect } from '@playwright/test';

const PASSWORD = 'E2ePassword123';
const samples = path.join(import.meta.dirname, '..', 'samples');
test.describe.configure({ mode: 'serial' });

let projectUrl;

async function login(page, user) {
  await page.goto('/#/login');
  await page.fill('input[name=email]', `${user}@demo.local`);
  await page.fill('input[name=password]', PASSWORD);
  await page.click('button:has-text("Sign in")');
  await expect(page.getByRole('heading', { name: 'Projects' })).toBeVisible();
}

async function approve(page, stage, comment) {
  await page.fill('#rv-comment', comment);
  await page.click('#rv-approve');
  await page.click('dialog button:has-text("Approve")');
  await expect(page.locator('.step', { hasText: stage })).toContainText('approved');
}

test('1. PM creates the project and uploads the sample inputs', async ({ page }) => {
  await login(page, 'pm');
  await page.click('button:has-text("New project")');
  await page.fill('dialog input[name=name]', 'Positive flow - Express Checkout');
  await page.click('dialog button:has-text("Create")');
  await expect(page).toHaveURL(/#\/project\/\d+\/files/);
  projectUrl = page.url().replace(/\/files$/, '');

  await page.setInputFiles('label.dropzone[data-kind=requirements] input', path.join(samples, 'requirements-sample.docx'));
  await expect(page.getByText('FR-101').first()).toBeVisible();
  await page.setInputFiles('label.dropzone[data-kind=team] input', path.join(samples, 'team-sample.xlsx'));
  await expect(page.getByRole('cell', { name: 'Meera Iyer' })).toBeVisible();
  await expect(page.locator('.step').first()).toContainText('files ready');
});

test('2. PM generates and approves the requirements analysis (Gate 1)', async ({ page }) => {
  await login(page, 'pm');
  await page.goto(`${projectUrl}/requirements`);
  await page.click('button:has-text("Generate Requirements")');
  await expect(page.locator('.gauge')).toBeVisible();
  for (const id of ['FR-101', 'FR-102', 'NFR-201', 'NFR-202']) await expect(page.locator('td.id', { hasText: new RegExp(`^${id}`) }).first()).toBeVisible();
  await expect(page.getByText('Ambiguities & clarifying questions')).toBeVisible();
  await expect(page.locator('.side')).toContainText('passed');
  await approve(page, 'Requirements', 'Reviewed with the product owner');
});

test('3. Architect generates and approves the architecture (Gate 2)', async ({ page }) => {
  await login(page, 'architect');
  await page.goto(`${projectUrl}/architecture`);
  await page.click('button:has-text("Generate Architecture")');
  await expect(page.locator('#diagram svg')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole('cell', { name: 'FraudGuard API Adapter' }).first()).toBeVisible();
  await approve(page, 'Architecture', 'Approved for planning');
});

test('4. PM generates, reviews and approves the dev tasks (Gate 3)', async ({ page }) => {
  await login(page, 'pm');
  await page.goto(`${projectUrl}/tasks`);
  await page.click('button:has-text("Generate Dev Tasks")');
  await expect(page.locator('.cap')).toHaveCount(3);
  for (const dev of ['Asha Rao', 'Ravi Kumar', 'Priya Nair']) await expect(page.locator('.cap', { hasText: dev })).toBeVisible();
  const rows = page.locator('#content table').first().locator('tr');
  expect(await rows.count()).toBeGreaterThan(20);
  await approve(page, 'Dev Tasks', 'Assignments and sequencing reviewed');
});

test('5. QA generates and approves the test cases (Gate 4)', async ({ page }) => {
  await login(page, 'qa');
  await page.goto(`${projectUrl}/tests`);
  await page.click('button:has-text("Generate QA Tests")');
  for (const type of ['Positive', 'Negative', 'Boundary', 'Integration', 'Regression', 'Security', 'Usability']) {
    await expect(page.locator('.filters button', { hasText: type })).toBeVisible();
  }
  await approve(page, 'QA Tests', 'Coverage approved');
});

test('6. PM sees every gate approved, 100% traceability, exports and the audit trail', async ({ page }) => {
  await login(page, 'pm');
  await page.goto(`${projectUrl}/overview`);
  for (const stage of ['Requirements', 'Architecture', 'Dev Tasks', 'QA Tests']) await expect(page.locator('.step', { hasText: stage })).toContainText('approved');

  await page.goto(`${projectUrl}/trace`);
  await expect(page.locator('.kpi', { hasText: 'Fully traced' })).toContainText('100%');

  await page.goto(`${projectUrl}/export`);
  await page.check('#approved-only');
  for (const fmt of ['xlsx', 'md', 'jira-csv']) {
    const download = page.waitForEvent('download');
    await page.click(`a[data-fmt=${fmt}]`);
    expect((await download).suggestedFilename()).toContain('Positive_flow');
  }

  await page.goto(`${projectUrl}/audit`);
  await expect(page.locator('#at tr', { hasText: 'GATE_APPROVED' })).toHaveCount(4);
});
