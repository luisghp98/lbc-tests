const { test } = require('@playwright/test');
const { loginViaUI } = require('../../utils/auth');
const { OnboardingPage } = require('../../pages/OnboardingPage');
const { asUser } = require('../../utils/rest');
const { qaChild, qaEmail, QaCleanup } = require('../../utils/qa');

const haceAnios = (n) => { const d = new Date(); d.setFullYear(d.getFullYear() - n); return d; };

// Exploración: cómo se añade un concepto de factura (Add Item) en el paso 4.
test.describe('EXP-ITEMS', () => {
  test.setTimeout(300_000);
  const limpieza = new QaCleanup();
  let page;
  test.beforeAll(async ({ browser }) => {
    page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
    await loginViaUI(page);
    await limpieza.sweep(await asUser());
  });
  test.afterAll(async () => { await limpieza.run(await asUser()); await page.context().close(); });

  test('EXP-ITEMS-01', async () => {
    test.fixme(!process.env.CI, 'Solo CI');
    const onb = new OnboardingPage(page);
    await onb.goto();
    await onb.datosNino({ ...qaChild(), nacimiento: haceAnios(4) });
    await onb.siguiente('Next: Family Member');
    await onb.familiarNuevo(qaEmail());
    await onb.siguiente('Next: Medical Info');
    await onb.siguiente('Next: Enrollment');
    await onb.matricula({ aula: 'habilitada' });
    const ver = async (titulo) => {
      const texto = (await page.locator('main').innerText()).split(/\r?\n/).map((t) => t.trim()).filter(Boolean);
      const i = texto.findIndex((t) => /Invoice Items/.test(t));
      console.log(`[EXP] ${titulo}: ${JSON.stringify(texto.slice(i, i + 40))}`);
    };
    await ver('antes de Add Item');
    await page.getByRole('button', { name: 'Add Item' }).click();
    await ver('después de Add Item');
    const combos = await page.getByRole('combobox').evaluateAll((cs) => cs.map((c) => (c.getAttribute('aria-label') || c.textContent || '').trim().slice(0, 60)));
    console.log(`[EXP] comboboxes: ${JSON.stringify(combos)}`);
    const producto = page.getByRole('combobox').filter({ hasText: /Select a product/i }).first();
    if (await producto.count()) {
      await producto.click();
      console.log(`[EXP] productos: ${JSON.stringify((await page.getByRole('option').allInnerTexts()).map((t) => t.trim().replace(/\s+/g, ' ')))}`);
      await page.keyboard.press('Escape');
    } else console.log('[EXP] no se encontró el selector de producto');
  });
});
