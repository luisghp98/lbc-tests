const { test, expect } = require('@playwright/test');
const { loginViaUI } = require('../../utils/auth');
const { OnboardingPage, SLOW } = require('../../pages/OnboardingPage');
const { asUser, rest } = require('../../utils/rest');
const { qaChild, qaEmail, QaCleanup } = require('../../utils/qa');
const { AulasQA } = require('../../utils/aulas');

const haceAnios = (n) => { const d = new Date(); d.setFullYear(d.getFullYear() - n); return d; };

// Exploración: por qué un aula con personal asignado (sin presencia) sale cerrada u oculta en el paso 4.
test.describe('EXP-AULAS', () => {
  test.setTimeout(600_000);
  const limpieza = new QaCleanup(); const aulas = new AulasQA();
  let page; let headers; let sinPersonal; let conAsignacion;

  test.beforeAll(async ({ browser }) => {
    page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
    await loginViaUI(page);
    headers = await asUser();
    await limpieza.sweep(headers); await aulas.sweep(headers);
    sinPersonal = await aulas.crear(headers, { etiqueta: 'SinPersonal', conPersonal: false });
    conAsignacion = await aulas.crear(headers, { etiqueta: 'ConAsignacion', conPersonal: true });
  });
  test.afterAll(async () => { const h = await asUser(); await limpieza.run(h); await aulas.limpiar(h); await page.context().close(); });

  test('EXP-AULAS-01: el paso 4 y las aulas de prueba', async () => {
    test.fixme(!process.env.CI, 'Solo CI');
    const capturas = [];
    page.on('response', async (r) => {
      const u = r.url();
      if (!/\/rest\/v1\/(rpc\/|classrooms|classroom_)/.test(u) || r.request().method() === 'OPTIONS') return;
      try { capturas.push({ ruta: new URL(u).pathname.replace('/rest/v1/', '') + (new URL(u).search ? '?' + new URL(u).search.slice(1, 120) : ''), cuerpo: r.request().postData(), json: await r.json().catch(() => null), estado: r.status() }); } catch { /* respuesta no disponible */ }
    });
    const onb = new OnboardingPage(page);
    await onb.goto();
    await onb.datosNino({ ...qaChild(), nacimiento: haceAnios(4) });
    await onb.siguiente('Next: Family Member');
    await onb.familiarNuevo(qaEmail());
    await onb.siguiente('Next: Medical Info');
    await onb.siguiente('Next: Enrollment');
    await onb.matricula({ aula: null });
    const op = (n) => onb.opcionAula(n);
    for (const a of [sinPersonal, conAsignacion]) {
      const o = await op(a.nombre);
      const n = await o.count();
      console.log(`[EXP] ${a.nombre.replace(/-[a-z]{4}$/, '')}: en el desplegable=${n > 0}${n > 0 ? `; deshabilitada=${await o.isDisabled()}; texto=${JSON.stringify((await o.innerText()).slice(0, 80))}` : ''}`);
    }
    for (const c of capturas) {
      const lista = Array.isArray(c.json) ? c.json : (c.json && typeof c.json === 'object' ? [c.json] : []);
      const qa = lista.filter((x) => JSON.stringify(x).includes('QA-1702'));
      console.log(`[EXP] llamada ${c.ruta} (HTTP ${c.estado}) cuerpo=${JSON.stringify(c.cuerpo || '').slice(0, 200)} -> ${Array.isArray(c.json) ? c.json.length + ' filas' : typeof c.json}; claves=${Object.keys(lista[0] || {}).slice(0, 30).join(',')}; entradas QA-1702=${qa.length}`);
      for (const q of qa) console.log(`[EXP]   QA: ${JSON.stringify(q).slice(0, 700)}`);
    }
  });
});
