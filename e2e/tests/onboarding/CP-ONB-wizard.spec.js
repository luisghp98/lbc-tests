const { test, expect } = require('@playwright/test');
const { loginViaUI } = require('../../utils/auth');
const { OnboardingPage, SLOW } = require('../../pages/OnboardingPage');
const { asUser, rest } = require('../../utils/rest');
const { qaChild, qaEmail, QaCleanup } = require('../../utils/qa');
const { AulasQA } = require('../../utils/aulas');
const { png, archivo } = require('../../utils/imagen');

const MB = 1024 * 1024;
const enDias = (n) => new Date(Date.now() + n * 86400000);
const haceAnios = (n) => { const d = new Date(); d.setFullYear(d.getFullYear() - n); return d; };

test.describe('CP-ONB: Onboarding del niño (wizard)', { tag: '@onboarding' }, () => {
  test.setTimeout(900_000);

  const limpieza = new QaCleanup();
  const aulas = new AulasQA();
  let page;
  let headers;
  let aulaSinPersonal;
  let aulaConAsignacion;

  test.beforeAll(async ({ browser }) => {
    page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
    await loginViaUI(page);
    headers = await asUser();
    await limpieza.sweep(headers);
    await aulas.sweep(headers);
    aulaSinPersonal = await aulas.crear(headers, { etiqueta: 'SinPersonal', conPersonal: false });
    aulaConAsignacion = await aulas.crear(headers, { etiqueta: 'ConAsignacion', conPersonal: true });
  });

  test.afterAll(async () => {
    headers = await asUser();
    await limpieza.run(headers);
    await aulas.limpiar(headers);
    await page.context().close();
  });

  test('CP-ONB-01: registro completo con foto, medicación y primera aula habilitada', async () => {
    const onb = new OnboardingPage(page);
    const nino = qaChild();
    await onb.goto();
    await onb.datosNino({ ...nino, nacimiento: haceAnios(4), foto: archivo('foto-qa.png', 'image/png', png(1 * MB)) });
    await expect(onb.errorFoto()).toHaveCount(0);
    await onb.siguiente('Next: Family Member');
    await onb.familiarNuevo(qaEmail());
    await onb.siguiente('Next: Medical Info');
    await onb.medicacion({ nombre: 'QA-Medicina', inicio: enDias(0), fin: enDias(1) });
    await onb.siguiente('Next: Enrollment');
    await onb.matricula({ aula: 'habilitada' });

    await onb.completar();
    const buscar = async () => (await rest('children', { headers, query: `last_name=eq.${nino.lastName}&select=id` })).json || [];
    await expect.poll(async () => (await buscar()).length, { timeout: SLOW, message: 'el niño debe crearse' }).toBe(1);
    const id = (await buscar())[0].id;
    limpieza.trackChild(id);
    console.log(`[CP-ONB-01] URL tras completar: ${page.url()}`);

    const hijo = await rest('children', { headers, query: `id=eq.${id}&select=id,first_name,last_name,status` });
    expect(hijo.json[0].last_name).toBe(nino.lastName);
    const matriculas = await rest('enrollments', { headers, query: `child_id=eq.${id}&select=*` });
    expect(matriculas.json.length, 'el niño debe tener matrícula').toBeGreaterThan(0);
    const facturas = async () => (await rest('invoices', { headers, query: `child_id=eq.${id}&select=id,status,total_amount` })).json || [];
    await expect.poll(async () => (await facturas()).length, { timeout: 120_000, message: 'se crea la factura de onboarding' }).toBeGreaterThan(0);
    expect(Number((await facturas())[0].total_amount), 'la factura tiene importe').toBeGreaterThan(0);
  });

  test('CP-ONB-02: aulas sin personal o con personal sin presencia quedan cerradas en el paso 4', async () => {
    const onb = new OnboardingPage(page);
    await onb.goto();
    await onb.datosNino({ ...qaChild(), nacimiento: haceAnios(4) });
    await onb.siguiente('Next: Family Member');
    await onb.familiarNuevo(qaEmail());
    await onb.siguiente('Next: Medical Info');
    await onb.siguiente('Next: Enrollment');
    await onb.matricula({ aula: null });
    const sinPersonal = await onb.opcionAula(aulaSinPersonal.nombre);
    await expect(sinPersonal, 'el aula sin personal sale cerrada').toBeDisabled();
    await expect(sinPersonal).toContainText('[NO STAFF]');

    // Con personal asignado pero sin presencia: el aula puede salir cerrada u oculta; lo que no puede es elegirse.
    const conAsignacion = await onb.opcionAula(aulaConAsignacion.nombre);
    const seleccionable = (await conAsignacion.count()) > 0 && (await conAsignacion.isEnabled());
    expect(seleccionable, 'un aula sin personal presente no debe poder elegirse').toBeFalsy();
  });
});
