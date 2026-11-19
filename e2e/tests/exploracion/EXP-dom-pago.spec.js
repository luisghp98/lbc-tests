const { test } = require('@playwright/test');
const { loginViaUI } = require('../../utils/auth');
const { OnboardingPage } = require('../../pages/OnboardingPage');
const { asUser } = require('../../utils/rest');
const { qaChild, qaEmail, QaCleanup } = require('../../utils/qa');

const haceAnios = (n) => { const d = new Date(); d.setFullYear(d.getFullYear() - n); return d; };

// Exploración de solo lectura: cómo están armados los campos de pago del paso 2. No se escribe nada en ellos.
test.describe('EXP-DOM-PAGO', () => {
  test.setTimeout(300_000);
  const limpieza = new QaCleanup();
  let page;
  test.beforeAll(async ({ browser }) => {
    page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
    await loginViaUI(page);
    await limpieza.sweep(await asUser());
  });
  test.afterAll(async () => { await limpieza.run(await asUser()); await page.context().close(); });

  for (const metodo of ['Card', 'ACH']) {
    test(`EXP-DOM-PAGO: ${metodo}`, async () => {
      test.fixme(!process.env.CI, 'Solo CI');
      const onb = new OnboardingPage(page);
      await onb.goto();
      await onb.datosNino({ ...qaChild(), nacimiento: haceAnios(4) });
      await onb.siguiente('Next: Family Member');
      await onb.familiarNuevo(qaEmail());
      await onb.metodoPago(metodo);
      await page.waitForTimeout(6000); // los campos seguros tardan en cargar
      const marcos = page.frames().filter((f) => f !== page.mainFrame());
      console.log(`[EXP] ${metodo}: ${marcos.length} marcos (iframes)`);
      for (const [i, f] of marcos.entries()) {
        const u = (() => { try { const x = new URL(f.url()); return x.host + x.pathname; } catch { return f.url().slice(0, 60); } })();
        const campos = await f.locator('input, select, textarea, button').evaluateAll((els) => els.map((e) => ({
          etiqueta: e.tagName.toLowerCase(), tipo: e.getAttribute('type'), id: e.id || null, nombre: e.getAttribute('name'), placeholder: e.getAttribute('placeholder'),
          aria: e.getAttribute('aria-label'), autocompletar: e.getAttribute('autocomplete'), texto: e.tagName === 'BUTTON' ? (e.textContent || '').trim().slice(0, 40) : null,
        }))).catch(() => []);
        console.log(`[EXP] ${metodo} marco ${i + 1}: ${u} | campos: ${JSON.stringify(campos)}`);
      }
      const enPagina = await page.locator('main iframe').evaluateAll((fs) => fs.map((f) => ({ titulo: f.getAttribute('title'), id: f.id || null, nombre: f.getAttribute('name'), src: (() => { try { const x = new URL(f.src); return x.host + x.pathname; } catch { return null; } })() })));
      console.log(`[EXP] ${metodo} iframes en la página: ${JSON.stringify(enPagina)}`);
      const botones = await page.locator('main button').evaluateAll((bs) => [...new Set(bs.map((b) => (b.getAttribute('aria-label') || b.textContent || '').trim()).filter((t) => t && t.length < 50))]);
      console.log(`[EXP] ${metodo} botones de la página: ${JSON.stringify(botones)}`);
      const rotulos = await page.locator('main label').allInnerTexts();
      console.log(`[EXP] ${metodo} etiquetas visibles: ${JSON.stringify(rotulos.map((t) => t.trim()).filter((t) => t && t.length < 60))}`);
    });
  }
});
