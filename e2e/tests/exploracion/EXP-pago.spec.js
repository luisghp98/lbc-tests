const { test, expect } = require('@playwright/test');
const { loginViaUI } = require('../../utils/auth');
const { OnboardingPage, SLOW } = require('../../pages/OnboardingPage');
const { asUser, rest, request } = require('../../utils/rest');
const { qaChild, qaEmail, QaCleanup } = require('../../utils/qa');

const haceAnios = (n) => { const d = new Date(); d.setFullYear(d.getFullYear() - n); return d; };

// Exploración: qué hace el wizard y qué guarda la factura con cada método de pago. No escribe datos de tarjeta ni de cuenta.
test.describe('EXP-PAGO', () => {
  test.setTimeout(900_000);
  const limpieza = new QaCleanup();
  let page; let headers;

  test.beforeAll(async ({ browser }) => {
    page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
    await loginViaUI(page);
    headers = await asUser();
    await limpieza.sweep(headers);
  });
  test.afterAll(async () => { await limpieza.run(await asUser()); await page.context().close(); });

  test('EXP-PAGO-00: columnas de pago en el esquema', async () => {
    test.fixme(!process.env.CI, 'Solo CI');
    const spec = (await request('/rest/v1/', { headers })).json || {};
    const defs = spec.definitions || {};
    console.log(`[EXP] tablas con payment_method: ${Object.keys(defs).filter((t) => /payment_method/i.test(t)).join(', ')}`);
    console.log(`[EXP] columnas de invoices: ${Object.keys((defs.invoices || {}).properties || {}).join(', ')}`);
    for (const t of Object.keys(defs).filter((x) => /payment_method/i.test(x))) console.log(`[EXP] columnas de ${t}: ${Object.keys(defs[t].properties || {}).join(', ')}`);
  });

  for (const metodo of ['Card', 'ACH', 'Cash', 'Check', 'Bank Transfer']) {
    test(`EXP-PAGO: ${metodo}`, async () => {
      test.fixme(!process.env.CI, 'Solo CI');
      const onb = new OnboardingPage(page);
      const nino = qaChild();
      await onb.goto();
      await onb.datosNino({ ...nino, nacimiento: haceAnios(4) });
      await onb.siguiente('Next: Family Member');
      await onb.familiarNuevo(qaEmail());
      await onb.metodoPago(metodo);
      const casilla = await page.getByText('Recurring Payment Authorization').first().isVisible();
      await onb.siguiente('Next: Medical Info');
      const avanza = await page.getByText('Step 3 of 4').waitFor({ timeout: 10_000 }).then(() => true, () => false);
      const avisos = avanza ? [] : (await page.locator('[role="alert"], [class*="destructive"], [class*="red-"]').allInnerTexts()).map((t) => t.trim().slice(0, 140)).filter(Boolean).slice(0, 6);
      console.log(`[EXP] ${metodo}: casilla recurrente visible=${casilla}; avanza al paso 3 sin datos de pago=${avanza}; avisos=${JSON.stringify(avisos)}`);
      if (!avanza) return;
      await onb.siguiente('Next: Enrollment');
      await onb.matricula({ aula: 'habilitada' });
      const envio = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().includes('/admin/children/new'), { timeout: SLOW });
      await onb.completar();
      await envio;
      await page.waitForURL(/\/admin\/children\/[0-9a-f-]{36}/, { timeout: 120_000 });
      const id = page.url().match(/children\/([0-9a-f-]{36})/)[1];
      limpieza.trackChild(id);
      await expect.poll(async () => ((await rest('invoices', { headers, query: `child_id=eq.${id}&select=id` })).json || []).length, { timeout: 120_000 }).toBeGreaterThan(0);
      const facturas = (await rest('invoices', { headers, query: `child_id=eq.${id}&select=*` })).json;
      for (const f of facturas) console.log(`[EXP] ${metodo}: factura ${JSON.stringify(Object.fromEntries(Object.entries(f).filter(([, v]) => v !== null)))}`);
    });
  }
});
