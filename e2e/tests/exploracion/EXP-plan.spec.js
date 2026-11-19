const { test, expect } = require('@playwright/test');
const { loginViaUI } = require('../../utils/auth');
const { OnboardingPage, SLOW } = require('../../pages/OnboardingPage');
const { asUser, rest } = require('../../utils/rest');
const { qaChild, qaEmail, QaCleanup } = require('../../utils/qa');

const haceAnios = (n) => { const d = new Date(); d.setFullYear(d.getFullYear() - n); return d; };

// Exploración del plan LBC-1702: conceptos de la factura y recuperación de la sesión del wizard.
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

  test('EXP-PLAN-01: conceptos de la factura de onboarding', async () => {
    test.fixme(!process.env.CI, 'Solo CI');
    const onb = new OnboardingPage(page);
    await onb.goto();
    await onb.datosNino({ ...qaChild(), nacimiento: haceAnios(4) });
    await onb.siguiente('Next: Family Member');
    await onb.familiarNuevo(qaEmail());
    await onb.siguiente('Next: Medical Info');
    await onb.siguiente('Next: Enrollment');
    await onb.matricula({ aula: 'habilitada' });
    const envio = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().includes('/admin/children/new'), { timeout: SLOW });
    await onb.completar();
    await envio;
    await page.waitForURL(/\/admin\/children\/[0-9a-f-]{36}/, { timeout: 120_000 });
    const id = page.url().match(/children\/([0-9a-f-]{36})/)[1];
    limpieza.trackChild(id);
    await expect.poll(async () => ((await rest('invoices', { headers, query: `child_id=eq.${id}&select=id` })).json || []).length, { timeout: 120_000 }).toBeGreaterThan(0);
    const f = (await rest('invoices', { headers, query: `child_id=eq.${id}&select=id,invoice_number,subtotal,tax_amount,total_amount` })).json[0];
    console.log(`[EXP] factura: ${JSON.stringify(f)}`);
    const it = await rest('invoice_items', { headers, query: `invoice_id=eq.${f.id}&select=*` });
    console.log(`[EXP] conceptos HTTP ${it.status}: ${(it.json || []).length} filas`);
    for (const x of it.json || []) console.log(`[EXP] concepto: ${JSON.stringify(Object.fromEntries(Object.entries(x).filter(([k, v]) => v !== null && !/_id$|^id$|created|updated|school/.test(k))))}`);
    const cols = (it.json && it.json[0]) ? Object.keys(it.json[0]).join(',') : '';
    console.log(`[EXP] columnas de invoice_items: ${cols}`);
  });

  test('EXP-PLAN-02: recuperación de la sesión del wizard', async () => {
    test.fixme(!process.env.CI, 'Solo CI');
    // Sin el script que borra el borrador: se prueba el comportamiento real de la aplicación.
    const p2 = await (await page.context().browser().newContext({ viewport: { width: 1280, height: 800 } })).newPage();
    await p2.goto('/admin/children/new');
    // la sesión de la primera página no se comparte: se inicia sesión de nuevo
    await loginViaUI(p2);
    await p2.goto('/admin/children/new');
    await p2.getByRole('heading', { name: 'Add New Child' }).waitFor({ timeout: SLOW });
    const onb = new OnboardingPage(p2);
    const nino = qaChild();
    await onb.datosNino({ ...nino, nacimiento: haceAnios(4) });
    await onb.siguiente('Next: Family Member');
    await onb.familiarNuevo(qaEmail());
    await onb.metodoPago('Cash');
    const casilla = p2.getByRole('checkbox', { name: /Recurring Payment Authorization/i }).first();
    await casilla.check();
    console.log('[EXP] paso 2 lleno con Cash y la recurrencia marcada; se recarga la página');
    await p2.reload();
    await p2.waitForLoadState('domcontentloaded');
    await p2.waitForTimeout(3000);
    const paso = await p2.getByText(/Step \d of 4/).first().innerText().catch(() => 'sin paso');
    console.log(`[EXP] tras recargar: ${paso}`);
    const nombre = await p2.getByRole('textbox', { name: 'First Name *' }).inputValue().catch(() => null);
    console.log(`[EXP] nombre del niño conservado: ${nombre === nino.firstName}`);
    const textoMetodo = await p2.getByRole('combobox', { name: /Register a payment method/ }).innerText().catch(() => null);
    console.log(`[EXP] método de pago conservado: ${textoMetodo}`);
    const marcada = await p2.getByRole('checkbox', { name: /Recurring Payment Authorization/i }).first().isChecked().catch(() => null);
    console.log(`[EXP] recurrencia conservada: ${marcada}`);
    const politicas = await p2.getByRole('checkbox', { name: /Acceptance of Policies/ }).isChecked().catch(() => null);
    console.log(`[EXP] aceptación de políticas conservada (paso 1): ${politicas}`);
    await p2.context().close();
  });
});
