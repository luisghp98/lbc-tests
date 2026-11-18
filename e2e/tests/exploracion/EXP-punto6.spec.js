const { test, expect } = require('@playwright/test');
const { loginViaUI } = require('../../utils/auth');
const { OnboardingPage, SLOW } = require('../../pages/OnboardingPage');
const { asUser, rest, request } = require('../../utils/rest');
const { qaChild, qaEmail, QaCleanup } = require('../../utils/qa');

const haceAnios = (n) => { const d = new Date(); d.setFullYear(d.getFullYear() - n); return d; };

// Exploración del punto 6: campos de los pasos 2 y 3 del wizard y la casilla de recurrencia con métodos sin datos de pago.
test.describe('EXP-P6', () => {
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

  const campos = () => page.locator('main').evaluate((el) => {
    const out = [];
    el.querySelectorAll('label, legend, h2, h3, button[role="combobox"], [role="checkbox"], textarea, input').forEach((n) => {
      const t = (n.getAttribute('aria-label') || n.getAttribute('placeholder') || n.textContent || '').trim().replace(/\s+/g, ' ');
      if (t && t.length <= 70 && !/[0-9@]/.test(t)) out.push(`${n.tagName.toLowerCase()}:${t}`);
    });
    return [...new Set(out)];
  });

  test('EXP-P6-01: campos de los pasos 2, 3 y 4', async () => {
    test.fixme(!process.env.CI, 'Solo CI');
    const onb = new OnboardingPage(page);
    await onb.goto();
    await onb.datosNino({ ...qaChild(), nacimiento: haceAnios(4) });
    await onb.siguiente('Next: Family Member');
    await onb.familiarNuevo(qaEmail());
    console.log(`[EXP] paso 2: ${JSON.stringify(await campos())}`);
    await onb.siguiente('Next: Medical Info');
    await page.getByText('Step 3 of 4').waitFor({ timeout: 30_000 });
    console.log(`[EXP] paso 3: ${JSON.stringify(await campos())}`);
    await onb.siguiente('Next: Enrollment');
    await page.getByText('Step 4 of 4').waitFor({ timeout: 30_000 });
    console.log(`[EXP] paso 4: ${JSON.stringify(await campos())}`);
  });

  for (const metodo of ['Cash', 'Check', 'Bank Transfer']) {
    test(`EXP-P6: ${metodo} con la casilla de recurrencia marcada`, async () => {
      test.fixme(!process.env.CI, 'Solo CI');
      const onb = new OnboardingPage(page);
      await onb.goto();
      await onb.datosNino({ ...qaChild(), nacimiento: haceAnios(4) });
      await onb.siguiente('Next: Family Member');
      await onb.familiarNuevo(qaEmail());
      await onb.metodoPago(metodo);
      const casilla = page.getByRole('checkbox', { name: /Recurring Payment Authorization/i });
      const hay = await casilla.count();
      if (hay) await casilla.first().check();
      console.log(`[EXP] ${metodo}: casilla encontrada=${hay > 0}; marcada=${hay ? await casilla.first().isChecked() : null}`);
      await onb.siguiente('Next: Medical Info');
      const avanza = await page.getByText('Step 3 of 4').waitFor({ timeout: 10_000 }).then(() => true, () => false);
      const avisos = avanza ? [] : (await page.locator('[role="alert"], [class*="destructive"], [class*="red-"]').allInnerTexts()).map((t) => t.trim().slice(0, 140)).filter(Boolean).slice(0, 6);
      console.log(`[EXP] ${metodo}: avanza=${avanza}; avisos=${JSON.stringify(avisos)}`);
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
      const f = (await rest('invoices', { headers, query: `child_id=eq.${id}&select=invoice_number,status,total_amount,recurring_payment_method_id,family_id,invoice_category,notes` })).json[0];
      console.log(`[EXP] ${metodo}: factura ${JSON.stringify({ ...f, notes: String(f.notes).slice(0, 160) })}`);
      const pm = await rest('payment_methods', { headers, query: `family_id=eq.${f.family_id}&select=type,provider,is_default,is_active,is_recurring_enabled` });
      const au = await rest('payment_method_audit_logs', { headers, query: `family_id=eq.${f.family_id}&select=action,result,source,error_code` });
      console.log(`[EXP] ${metodo}: payment_methods=${JSON.stringify(pm.json).slice(0, 300)}; auditoría=${JSON.stringify(au.json).slice(0, 300)}`);
    });
  }

  test('EXP-P6-02: botones, opciones y tablas', async () => {
    test.fixme(!process.env.CI, 'Solo CI');
    const spec = (await request('/rest/v1/', { headers })).json || {};
    const defs = spec.definitions || {};
    for (const t of Object.keys(defs).filter((x) => /allerg|medical_cond|special_need|family_member|child_famil|guardian|emergency|authorized_pick/i.test(x))) console.log(`[EXP] tabla ${t}: ${Object.keys(defs[t].properties || {}).join(', ')}`);
    const onb = new OnboardingPage(page);
    await onb.goto();
    await onb.datosNino({ ...qaChild(), nacimiento: haceAnios(4) });
    await onb.siguiente('Next: Family Member');
    await onb.familiarNuevo(qaEmail());
    const botones = () => page.locator('main button').evaluateAll((bs) => [...new Set(bs.map((b) => (b.getAttribute('aria-label') || b.textContent || '').trim().replace(/\s+/g, ' ')).filter((t) => t && t.length < 60))]);
    const opciones = async (nombre) => { await page.getByRole('combobox', { name: nombre }).click(); const o = await page.getByRole('option').allInnerTexts(); await page.keyboard.press('Escape'); return o.map((t) => t.trim()); };
    console.log(`[EXP] botones paso 2: ${JSON.stringify(await botones())}`);
    console.log(`[EXP] opciones Relationship: ${JSON.stringify(await opciones(/Relationship to Child/))}`);
    console.log(`[EXP] opciones Type of ID: ${JSON.stringify(await opciones(/Type of ID/))}`);
    await onb.siguiente('Next: Medical Info');
    await page.getByText('Step 3 of 4').waitFor({ timeout: 30_000 });
    console.log(`[EXP] botones paso 3: ${JSON.stringify(await botones())}`);
    console.log(`[EXP] opciones Severity: ${JSON.stringify(await opciones(/Severity/))}`);
    const marcos = await page.locator('main [role="checkbox"], main input[type="checkbox"]').evaluateAll((cs) => cs.map((c) => c.getAttribute('aria-label') || c.id || c.name || ''));
    console.log(`[EXP] casillas paso 3: ${JSON.stringify(marcos)}`);
  });
});
