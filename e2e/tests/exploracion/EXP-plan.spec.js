const { test, expect } = require('@playwright/test');
const { loginViaUI } = require('../../utils/auth');
const { OnboardingPage, SLOW } = require('../../pages/OnboardingPage');
const { asUser } = require('../../utils/rest');
const { qaChild, qaEmail, QaCleanup } = require('../../utils/qa');

const haceAnios = (n) => { const d = new Date(); d.setFullYear(d.getFullYear() - n); return d; };

// Exploración del plan LBC-1702: recuperación de la sesión del wizard y contenido del paso 4.
test.describe('EXP-PLAN', () => {
  test.setTimeout(600_000);
  const limpieza = new QaCleanup();
  let page; let headers;
  test.beforeAll(async ({ browser }) => {
    page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
    await loginViaUI(page);
    headers = await asUser();
    await limpieza.sweep(headers);
  });
  test.afterAll(async () => { await limpieza.run(await asUser()); await page.context().close(); });

  test('EXP-PLAN-02: recuperación de la sesión del wizard', async () => {
    test.fixme(!process.env.CI, 'Solo CI');
    const p2 = await page.context().newPage(); // misma sesión, pestaña nueva y sin el script que borra el borrador
    await p2.goto('/admin/children/new');
    await p2.getByRole('heading', { name: 'Add New Child' }).waitFor({ timeout: SLOW });
    const onb = new OnboardingPage(p2);
    const nino = qaChild();
    await onb.datosNino({ ...nino, nacimiento: haceAnios(4) });
    await onb.siguiente('Next: Family Member');
    await onb.familiarNuevo(qaEmail());
    await p2.getByRole('combobox', { name: /Register a payment method/ }).click();
    console.log(`[EXP] opciones de método de pago en la pestaña nueva: ${JSON.stringify((await p2.getByRole('option').allInnerTexts()).map((t) => t.trim()))}`);
    await p2.keyboard.press('Escape');
    await onb.metodoPago('Cash');
    await p2.getByRole('checkbox', { name: /Recurring Payment Authorization/i }).first().check();
    console.log('[EXP] paso 2 lleno con Cash y la recurrencia marcada; se recarga la página');
    await p2.reload();
    await p2.waitForLoadState('domcontentloaded');
    await p2.getByRole('heading', { name: 'Add New Child' }).waitFor({ timeout: SLOW });
    await p2.waitForTimeout(3000);
    console.log(`[EXP] tras recargar: ${await p2.getByText(/Step \d of 4/).first().innerText().catch(() => 'sin paso')}`);
    console.log(`[EXP] nombre del niño conservado: ${(await p2.getByRole('textbox', { name: 'First Name *' }).inputValue().catch(() => null)) === nino.firstName}`);
    console.log(`[EXP] método de pago conservado: ${await p2.getByRole('combobox', { name: /Register a payment method/ }).innerText().catch(() => null)}`);
    console.log(`[EXP] recurrencia conservada: ${await p2.getByRole('checkbox', { name: /Recurring Payment Authorization/i }).first().isChecked().catch(() => null)}`);
    console.log(`[EXP] aceptación de políticas conservada: ${await p2.getByRole('checkbox', { name: /Acceptance of Policies/ }).isChecked().catch(() => null)}`);
    await p2.close();
  });

  test('EXP-PLAN-03: contenido del paso 4', async () => {
    test.fixme(!process.env.CI, 'Solo CI');
    const onb = new OnboardingPage(page);
    await onb.goto();
    await onb.datosNino({ ...qaChild(), nacimiento: haceAnios(4) });
    await onb.siguiente('Next: Family Member');
    await onb.familiarNuevo(qaEmail());
    await onb.siguiente('Next: Medical Info');
    await onb.siguiente('Next: Enrollment');
    await onb.matricula({ tipo: /Full Time Matricula/, aula: 'habilitada' });
    const lineas = (await page.locator('main').innerText()).split(/\r?\n/).map((t) => t.trim()).filter((t) => t && t.length < 90);
    console.log(`[EXP] texto del paso 4: ${JSON.stringify(lineas.slice(0, 70))}`);
    const botones = await page.locator('main button').evaluateAll((bs) => bs.map((x) => (x.getAttribute('aria-label') || x.textContent || '').trim()).filter((t) => t && t.length < 60));
    console.log(`[EXP] botones del paso 4: ${JSON.stringify([...new Set(botones)])}`);
    expect(true).toBe(true);
  });
});
