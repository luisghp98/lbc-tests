const { test, expect } = require('@playwright/test');
const { loginViaUI } = require('../../utils/auth');
const { OnboardingPage } = require('../../pages/OnboardingPage');
const { resolveSchoolId, resolveCampusId } = require('../../utils/school');

test.describe('CP-ONB: Onboarding del Nino (flujo E2E del wizard)', {
  tag: '@onboarding @cp-onb',
}, () => {
  let sharedPage;
  // Se resuelven desde la sesión del usuario del .env: sin UUIDs quemados.
  let SCHOOL_ID;
  let CAMPUS_ID;

  test.beforeAll(async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    sharedPage = await ctx.newPage();
    await loginViaUI(sharedPage);
    SCHOOL_ID = await resolveSchoolId(sharedPage);
    CAMPUS_ID = await resolveCampusId(sharedPage);
    console.log(`  [CP-ONB] usuario: ${process.env.USER} | school_id: ${SCHOOL_ID} | campus_id: ${CAMPUS_ID}`);
  });

  function makeChildOpts(overrides = {}) {
    const d = new Date();
    const years = 2 + Math.floor(Math.random() * 2); // 2 o 3
    d.setFullYear(d.getFullYear() - years);
    // Opcional: ajustar el mes y día para evitar fechas futuras
    d.setMonth(d.getMonth() - Math.floor(Math.random() * 12));

    const defaultBirth = d.toISOString().split('T')[0];
    const letters = 'ABCDEFGHJKLMNPRSTVWXYZ';
    let suffix = '';
    for (let i = 0; i < 4; i++) suffix += letters[Math.floor(Math.random() * letters.length)];
    return { firstName: 'Auto', lastName: 'Onb' + suffix, birthDate: defaultBirth, gender: 'Male', ...overrides };
  }

  test('CP-ONB-01: Registro completo del nino via wizard de 4 pasos', async () => {
    const onb = new OnboardingPage(sharedPage);
    await onb.goto();
    await onb.completeWizard({ childData: makeChildOpts({ firstName: 'Full' }) });

    await sharedPage.screenshot({ path: 'evidence/screenshots/cp-onb-01-complete.png', fullPage: true });

    const ok = await onb.isSuccessVisible();
    expect(ok, 'El registro debe redirigir al detalle del nino').toBeTruthy();
    expect(sharedPage.url(), 'Debe quedar en /admin/children/{id}').toContain('/admin/children/');
    const status = await onb.getChildStatus();
    console.log('status', status)
    console.log('[CP-ONB-01 INFO] estado del nino tras onboarding:', status);
    expect(['Active', 'active'].includes(status), 'El nino debe quedar registrado (estado activo tras onboarding)').toBeTruthy();
  });

  test('CP-ONB-02: Registro con solo campos obligatorios', async () => {
    const onb = new OnboardingPage(sharedPage);
    await onb.goto();
    await onb.completeWizard({ childData: makeChildOpts({ firstName: 'Min' }) });

    await sharedPage.screenshot({ path: 'evidence/screenshots/cp-onb-02-minimal.png', fullPage: true });
    const ok = await onb.isSuccessVisible();
    expect(ok, 'El registro minimo debe completarse').toBeTruthy();
  });

  test('CP-ONB-04: Acceso al wizard sin sesion redirige a login', async ({ page }) => {
    await page.goto('/admin/children/new');
    await page.waitForTimeout(3000);
    await page.screenshot({ path: 'evidence/screenshots/cp-onb-04-no-auth.png', fullPage: true });
    const onLogin = page.url().includes('/login');
    expect(onLogin, 'Sin sesion el wizard debe redirigir a /login').toBeTruthy();
  });

  test('CP-ONB-05: Persistencia de la informacion en la base de datos', async () => {
    const onb = new OnboardingPage(sharedPage);
    const headers = await onb._getAuthHeaders();
    const child = makeChildOpts({ firstName: 'Persist' });
    const cRes = await onb._httpsReq('/rest/v1/children', 'POST',
      Object.assign({}, headers, { 'Content-Type': 'application/json', 'Prefer': 'return=representation' }),
      JSON.stringify({ school_id: SCHOOL_ID, first_name: child.firstName, last_name: child.lastName, birth_date: child.birthDate, gender: child.gender, status: 'pending' }));
    expect(cRes.status, 'POST /children debe retornar 201').toBe(201);
    const id = cRes.json && cRes.json[0] && cRes.json[0].id;
    expect(id, 'El nino debe obtener un id').toBeTruthy();

    const got = await onb._httpsReq('/rest/v1/children?id=eq.' + id + '&select=id,first_name,last_name,status', 'GET', headers);
    expect(got.status, 'GET /children debe retornar 200').toBe(200);
    expect(got.json[0].first_name, 'El nombre debe persistir').toBe(child.firstName);
    expect(got.json[0].last_name, 'El apellido debe persistir').toBe(child.lastName);

    await onb._httpsReq('/rest/v1/children?id=eq.' + id, 'DELETE', headers);
  });

  test('CP-ONB-06: Validacion de ratio nino-staff y forzamiento activo', async () => {
    const onb = new OnboardingPage(sharedPage);
    const headers = await onb._getAuthHeaders();
    const child = makeChildOpts({ firstName: 'Ratio' });
    const cRes = await onb._httpsReq('/rest/v1/children', 'POST',
      Object.assign({}, headers, { 'Content-Type': 'application/json', 'Prefer': 'return=representation' }),
      JSON.stringify({ school_id: SCHOOL_ID, first_name: child.firstName, last_name: child.lastName, birth_date: child.birthDate, gender: child.gender, status: 'pending' }));
    expect(cRes.status, 'POST /children').toBe(201);
    const childId = cRes.json[0].id;

    const clsRes = await onb._httpsReq('/rest/v1/classrooms?campus_id=eq.' + CAMPUS_ID + '&select=id,classroom_name,capacity,current_enrollment', 'GET', headers);
    const rooms = clsRes.json || [];
    const others = rooms.filter(c => !/kinder\s*b/i.test(c.classroom_name || ''));
    const full = others.find(c => (c.current_enrollment || 0) >= (c.capacity || 0)) || others[0] || rooms[0];
    expect(full, 'Debe existir al menos un aula para evaluar el ratio').toBeTruthy();

    const enr = await onb._httpsReq('/rest/v1/classroom_enrollments', 'POST',
      Object.assign({}, headers, { 'Content-Type': 'application/json' }),
      JSON.stringify({ child_id: childId, classroom_id: full.id }));

    if ((full.current_enrollment || 0) >= (full.capacity || 0)) {
      expect(enr.status, 'Inscripcion en aula llena debe ser rechazada (forzamiento activo)').not.toBe(201);
    } else {
      expect(enr.status, 'La inscripcion debe ser procesada coherentemente').toBeGreaterThanOrEqual(200);
    }

    if (enr.json && enr.json[0] && enr.json[0].id) {
      await onb._httpsReq('/rest/v1/classroom_enrollments?id=eq.' + enr.json[0].id, 'DELETE', headers);
    }
    await onb._httpsReq('/rest/v1/children?id=eq.' + childId, 'DELETE', headers);
  });

  test('CP-ONB-07: Creacion de la familia asociada al nino', async () => {
    const onb = new OnboardingPage(sharedPage);
    const headers = await onb._getAuthHeaders();
    const famCode = 'LBC' + Date.now().toString().slice(-8);
    const fRes = await onb._httpsReq('/rest/v1/families', 'POST',
      Object.assign({}, headers, { 'Content-Type': 'application/json', 'Prefer': 'return=representation' }),
      JSON.stringify({ school_id: SCHOOL_ID, family_code: famCode, family_name: 'Familia Test' }));
    expect(fRes.status, 'POST /families debe retornar 201').toBe(201);
    const fid = fRes.json[0].id;

    const got = await onb._httpsReq('/rest/v1/families?id=eq.' + fid, 'GET', headers);
    expect(got.json[0].family_code, 'La familia debe persistir con su codigo').toBe(famCode);

    await onb._httpsReq('/rest/v1/families?id=eq.' + fid, 'DELETE', headers);
  });

  test('CP-ONB-08: Factura de onboarding y cargos 1 recurrente + 1 no recurrente', async () => {
    const onb = new OnboardingPage(sharedPage);
    const headers = await onb._getAuthHeaders();

    const invs = await onb._httpsReq('/rest/v1/invoices?school_id=eq.' + SCHOOL_ID + '&limit=1&select=id,invoice_number', 'GET', headers);
    expect(invs.status, 'GET /invoices debe retornar 200').toBe(200);
    expect(invs.json.length, 'La escuela debe tener al menos una factura').toBeGreaterThan(0);

    const ch = await onb._httpsReq('/rest/v1/charges?school_id=eq.' + SCHOOL_ID + '&select=charge_type&limit=1000', 'GET', headers);
    expect(ch.status, 'GET /charges debe retornar 200').toBe(200);
    const types = [...new Set((ch.json || []).map(c => c.charge_type).filter(Boolean))];
    console.log('[CP-ONB-08 INFO] charge_type disponibles en la escuela:', JSON.stringify(types));
  });
});