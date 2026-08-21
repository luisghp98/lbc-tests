const { test, expect } = require('@playwright/test');
const { loginViaUI } = require('../../utils/auth');

test('Inspect Level select options', async ({ page }) => {
  await loginViaUI(page);
  await page.goto('/admin/classrooms/new');
  await page.waitForFunction(() => !document.body.innerText.includes('Loading'));

  const selects = await page.locator('select').all();
  console.log(`Found ${selects.length} select elements`);

  for (let i = 0; i < selects.length; i++) {
    const options = await selects[i].locator('option').allTextContents();
    console.log(`Select #${i}: ${JSON.stringify(options)}`);
  }
});
