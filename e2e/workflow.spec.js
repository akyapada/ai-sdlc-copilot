// End-to-end browser tests of the main user journeys (serial: later tests build on earlier state).
import path from 'node:path';
import { test, expect } from '@playwright/test';

const PASSWORD = 'E2ePassword123';
const samples = path.join(import.meta.dirname, '..', 'samples');
test.describe.configure({ mode: 'serial' });

async function login(page, user) {
  await page.goto('/#/login');
  await page.fill('input[name=email]', `${user}@demo.local`);
  await page.fill('input[name=password]', PASSWORD);
  await page.click('button:has-text("Sign in")');
  await expect(page.getByRole('heading', { name: 'Projects' })).toBeVisible();
}

const projectName = 'E2E <img src=x onerror="window.__xss=1"> Checkout';
let projectUrl;

test('sign-in rejects a wrong password with a message', async ({ page }) => {
  await page.goto('/#/login');
  await page.fill('input[name=email]', 'pm@demo.local');
  await page.fill('input[name=password]', 'wrong-password-1');
  await page.click('button:has-text("Sign in")');
  await expect(page.locator('.toast.error')).toContainText('Invalid email or password');
  await expect(page).toHaveURL(/#\/login/);
});

test('PM creates a project and uploads inputs; bad file is rejected in the UI', async ({ page }) => {
  await login(page, 'pm');
  await page.click('button:has-text("New project")');
  await page.fill('dialog input[name=name]', projectName);
  await page.click('dialog button:has-text("Create")');
  await expect(page).toHaveURL(/#\/project\/\d+\/files/);
  projectUrl = page.url().replace(/\/files$/, '');

  await page.setInputFiles('label.dropzone[data-kind=requirements] input', path.join(samples, 'panel-pack', '5-fake-requirements.docx'));
  await expect(page.locator('#res-requirements .alert.error')).toContainText('not a valid Office Open XML package');

  await page.setInputFiles('label.dropzone[data-kind=requirements] input', path.join(samples, 'requirements-sample.docx'));
  await expect(page.locator('.toast.ok').last()).toContainText('Uploaded v1');
  await page.setInputFiles('label.dropzone[data-kind=team] input', path.join(samples, 'team-sample.xlsx'));
  await expect(page.getByRole('cell', { name: 'Priya Nair' })).toBeVisible();
  await expect(page.locator('.step').first()).toContainText('files ready');
});

test('project name with HTML is shown as text (no XSS)', async ({ page }) => {
  await login(page, 'pm');
  await page.goto(projectUrl + '/overview');
  await expect(page.locator('h1')).toContainText('<img src=x');
  expect(await page.evaluate(() => window.__xss)).toBeUndefined();
});

test('requirements: generate, refine with the feedback agent, approve', async ({ page }) => {
  await login(page, 'pm');
  await page.goto(projectUrl + '/requirements');
  await page.click('button:has-text("Generate Requirements")');
  await expect(page.locator('.gauge')).toBeVisible();
  await expect(page.getByRole('cell', { name: 'FR-101' }).first()).toBeVisible();
  await expect(page.locator('#ver')).toContainText('v1');

  await page.fill('#fb-text', 'add risk: FraudGuard SLA unknown for FR-102\nassign T-999 to Nobody');
  await page.click('#fb-go');
  await expect(page.locator('#ver')).toContainText('v2');
  await expect(page.locator('.side')).toContainText('Added risk');
  await expect(page.locator('.side')).toContainText('Not applied');
  await expect(page.locator('tr.row-added')).toHaveCount(1);

  await page.click('#rv-approve');
  await page.click('dialog button:has-text("Approve")');
  await expect(page.locator('.step', { hasText: 'Requirements' })).toContainText('v2 approved');
  await expect(page.locator('.step', { hasText: 'Architecture' })).toContainText('ready');
});

test('developer can read but not approve or generate', async ({ page }) => {
  await login(page, 'dev');
  await page.goto(projectUrl + '/architecture');
  await expect(page.getByText('cannot generate this stage')).toBeVisible();
  await page.goto(projectUrl + '/requirements');
  await expect(page.locator('#rv-approve')).toHaveCount(0);
  await expect(page.locator('#edit')).toHaveCount(0);
});

test('architect generates architecture with a rendered component diagram and approves', async ({ page }) => {
  await login(page, 'architect');
  await page.goto(projectUrl + '/architecture');
  await page.click('button:has-text("Generate Architecture")');
  await expect(page.locator('#diagram svg')).toBeVisible({ timeout: 15_000 });
  await page.fill('#rv-comment', 'Approved for planning');
  await page.click('#rv-approve');
  await page.click('dialog button:has-text("Approve")');
  await expect(page.locator('.step', { hasText: 'Architecture' })).toContainText('approved');
});

test('PM edits a task assignee inline; a new version shows the change', async ({ page }) => {
  await login(page, 'pm');
  await page.goto(projectUrl + '/tasks');
  await page.click('button:has-text("Generate Dev Tasks")');
  await expect(page.locator('.cap')).toHaveCount(3);
  await page.click('#edit');
  await page.locator('#content select[data-k=assignee]').first().selectOption('Ravi Kumar');
  await page.fill('#edit-comment', 'Rebalance');
  await page.click('#save-edit');
  await expect(page.locator('#ver')).toContainText('human-edit');
  await expect(page.locator('tr.row-modified')).toHaveCount(1);
});

test('traceability and export pages load', async ({ page }) => {
  await login(page, 'pm');
  await page.goto(projectUrl + '/trace');
  await expect(page.locator('.kpi').first()).toContainText('4');
  await page.goto(projectUrl + '/export');
  const download = page.waitForEvent('download');
  await page.click('a[data-fmt=xlsx]');
  expect((await download).suggestedFilename()).toMatch(/\.xlsx$/);
});
