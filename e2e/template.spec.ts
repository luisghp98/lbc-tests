// e2e/feature.spec.ts
import { test, expect, BrowserContext, Page } from '@playwright/test';
import {
  clickTableAction,
  createCharge,
  expectToast,
  findTableRow,
  getModal,
  verifyFormFields,
} from './utils/helpers';
import { apiDelete, apiPatch } from './utils/api';
import { loginViaUI } from './utils/auth';

test.describe('Feature Name', () => {
  let sharedContext: BrowserContext;
  let sharedPage: Page;

  test.beforeAll(async ({ browser }) => {
    sharedContext = await browser.newContext();
    sharedPage = await sharedContext.newPage();
    await loginViaUI(sharedPage);
  });

  test.afterAll(async () => {
    await sharedContext.close();
  });

  test('CP-XXX-01 - Test description', async () => {
    
  });
});