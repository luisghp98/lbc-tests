const { test, expect } = require('@playwright/test');
const { loginViaUI } = require('../../utils/auth');
const { OnboardingPage, SLOW } = require('../../pages/OnboardingPage');
const { asUser, rest, request } = require('../../utils/rest');
const { qaChild, qaEmail, QaCleanup } = require('../../utils/qa');
const { AulasQA } = require('../../utils/aulas');
const { png, desdeNavegador, archivo } = require('../../utils/imagen');

const MB = 1024 * 1024;
const enDias = (n) => new Date(Date.now() + n * 86400000);
const ymd = (d) => d.toLocaleDateString('en-CA');
const MESES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const etiquetaDia = (d) => `${MESES[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
const haceAnios = (n) => { const d = new Date(); d.setFullYear(d.getFullYear() - n); return d; };

test.describe('CP-ONB: Onboarding del niño (wizard)', { tag: '@onboarding' }, () => {
  test.setTimeout(900_000);

  const limpieza = new QaCleanup();
  const aulas = new AulasQA();
  let page;
  let headers;
  let aulaSinPersonal;
  let aulaConAsignacion;
  let fotoGuardada;
  let ultimoNinoId;

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
    await expect(page.getByText('QA-Medicina').first(), 'la medicación añadida debe aparecer en la lista del paso 3').toBeVisible();
    await onb.siguiente('Next: Enrollment');
    await onb.matricula({ aula: 'habilitada' });

    const envio = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().includes('/admin/children/new'), { timeout: SLOW });
    await onb.completar();
    await envio;
    await page.waitForURL(/\/admin\/children\/[0-9a-f-]{36}/, { timeout: 120_000 });
    const buscar = async () => (await rest('children', { headers, query: `last_name=eq.${nino.lastName}&select=id` })).json || [];
    await expect.poll(async () => (await buscar()).length, { timeout: SLOW, message: 'el niño debe crearse' }).toBe(1);
    const id = (await buscar())[0].id;
    limpieza.trackChild(id);
    console.log(`[CP-ONB-01] URL tras completar: ${page.url()}`);

    const hijo = await rest('children', { headers, query: `id=eq.${id}&select=id,first_name,last_name,status` });
    expect(hijo.json[0].last_name).toBe(nino.lastName);
    const leerMatriculas = async () => (await rest('enrollments', { headers, query: `child_id=eq.${id}&select=*` })).json || [];
    await expect.poll(async () => (await leerMatriculas()).length, { timeout: 60_000, message: 'el niño debe tener matrícula' }).toBeGreaterThan(0);
    const matriculas = { json: await leerMatriculas() };
    const facturas = async () => (await rest('invoices', { headers, query: `child_id=eq.${id}&select=id,status,total_amount,recurring_payment_method_id` })).json || [];
    await expect.poll(async () => (await facturas()).length, { timeout: 120_000, message: 'se crea la factura de onboarding' }).toBeGreaterThan(0);
    expect(Number((await facturas())[0].total_amount), 'la factura tiene importe').toBeGreaterThan(0);

    // Punto 1: el niño queda asociado al tipo de enrolamiento elegido (Full Time).
    const tipo = (await rest('enrollment_types', { headers, query: `name=eq.${encodeURIComponent('Full Time')}&deleted_at=is.null&select=id` })).json[0];
    expect(matriculas.json[0].enrollment_type_id, 'la matrícula debe quedar con el tipo de enrolamiento elegido').toBe(tipo.id);

    // Punto 2: la medicación registrada en el paso 3 se ve en el detalle del niño (la tabla `medications` no es legible con este rol).
    await expect(page.locator('main'), 'la medicación registrada debe verse en el detalle del niño').toContainText('QA-Medicina', { timeout: 60_000 });
    const detalle = (await page.locator('main').evaluate((el) => el.textContent)).replace(/\s+/g, ' ');
    const i = detalle.indexOf('QA-Medicina');
    console.log(`[CP-ONB-01] medicación en el detalle: ${detalle.slice(Math.max(0, i - 60), i + 220)}`);
    const filas = (await rest('medications', { headers, query: `child_id=eq.${id}&select=start_date,end_date` })).json || [];
    console.log(`[CP-ONB-01] filas en la tabla medications visibles para el rol: ${filas.length}`);

    // Punto 5: sin autorización de débito recurrente, la factura queda sin método de pago asociado.
    expect((await facturas())[0].recurring_payment_method_id, 'sin recurrencia, la factura no se asocia a un método de pago').toBeNull();
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

  test('CP-ONB-03: la foto admite JPEG, PNG y WebP hasta 5 MiB y rechaza el resto', async () => {
    const onb = new OnboardingPage(page);
    await onb.goto();
    const entrada = page.locator('input[type="file"]');
    const subir = async (f) => { await entrada.setInputFiles(f); };
    const validos = [
      archivo('foto.png', 'image/png', png(1 * MB)),
      archivo('foto.jpg', 'image/jpeg', await desdeNavegador(page, 'image/jpeg')),
      archivo('foto.webp', 'image/webp', await desdeNavegador(page, 'image/webp')),
      archivo('limite.png', 'image/png', png(4.9 * MB)),
    ];
    for (const f of validos) {
      await subir(f);
      await expect(onb.errorFoto(), `${f.name} debe aceptarse`).toHaveCount(0);
    }
    const invalidos = [
      [archivo('anim.gif', 'image/gif', Buffer.from('GIF89a-qa')), /File type not allowed/],
      [archivo('doc.pdf', 'application/pdf', Buffer.from('%PDF-1.4 qa')), /File type not allowed/],
      [archivo('texto.txt', 'text/plain', Buffer.from('qa')), /File type not allowed/],
      [archivo('grande.png', 'image/png', png(5.1 * MB)), /File size must be less than 5 MB/],
      [archivo('enorme.png', 'image/png', png(30 * MB)), /File size must be less than 5 MB/],
    ];
    for (const [f, mensaje] of invalidos) {
      await subir(f);
      await expect(onb.errorFoto(), `${f.name} debe rechazarse`).toContainText(mensaje);
    }
  });

  test('CP-ONB-04: registro con foto de 4,9 MiB: la foto se guarda en el servidor', async () => {
    test.fixme(!process.env.CI, 'Solo se ejecuta en CI: tras el registro el navegador automatizado pierde la renovación del token (POST /auth/v1/token abortado) y la foto no llega a guardarse; confirmar a mano.');
    const onb = new OnboardingPage(page);
    const nino = qaChild();
    onb.vigilar();
    await onb.goto();
    await onb.datosNino({ ...nino, nacimiento: haceAnios(4), foto: archivo('limite.png', 'image/png', png(4.9 * MB)) });
    await onb.siguiente('Next: Family Member');
    await onb.familiarNuevo(qaEmail());
    await onb.siguiente('Next: Medical Info');
    await onb.siguiente('Next: Enrollment');
    await onb.matricula({ aula: 'habilitada' });
    // El envío sube la foto y enlaza al familiar: hay que esperar su respuesta antes de navegar (si no, se cancela).
    const t0 = Date.now();
    const envio = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().includes('/admin/children/new'), { timeout: SLOW });
    await onb.completar();
    const respuesta = await envio;
    console.log(`[CP-ONB-04] respuesta del envío: ${respuesta.status()} en ${Math.round((Date.now() - t0) / 1000)} s`);
    const redirigio = await page.waitForURL(/\/admin\/children\/[0-9a-f-]{36}/, { timeout: 120_000 }).then(() => true, () => false);
    console.log(`[CP-ONB-04] redirección al detalle: ${redirigio ? 'sí' : 'no'}; URL: ${page.url()}; problemas: ${JSON.stringify(onb.problemas)}`);

    const buscar = async () => (await rest('children', { headers, query: `last_name=eq.${nino.lastName}&select=*` })).json || [];
    await expect.poll(async () => (await buscar()).length, { timeout: SLOW, message: 'el niño debe crearse' }).toBe(1);
    const hijo = (await buscar())[0];
    limpieza.trackChild(hijo.id);

    ultimoNinoId = hijo.id;

    const foto = async () => ((await rest('children', { headers, query: `id=eq.${hijo.id}&select=profile_picture_url` })).json || [{}])[0].profile_picture_url;
    await expect.poll(foto, { timeout: 120_000, message: 'la foto de 4,9 MiB debe guardarse en el servidor (profile_picture_url)' }).toBeTruthy();
    fotoGuardada = String(await foto());
  });

  // Seguridad: salta el tope del cliente y sube directo al almacenamiento, en la carpeta de la foto del niño (así se puede borrar).
  test('CP-ONB-05: el almacenamiento rechaza fotos de más de 5 MiB subidas directo', { tag: '@seguridad' }, async () => {
    test.skip(!fotoGuardada, 'Requiere la foto guardada por CP-ONB-04');
    const m = fotoGuardada.match(/\/storage\/v1\/object\/(?:public|sign|authenticated)?\/?([^/?]+)\/([^?]+)$/);
    test.skip(!m, 'No se pudo deducir el bucket de la URL de la foto');
    const [, bucket, ruta] = m;
    const carpeta = ruta.slice(0, ruta.lastIndexOf('/'));
    const subidos = [];
    const subir = async (bytes) => {
      const cuerpo = png(bytes);
      const nombre = `${carpeta}/qa-lbc1702-${Date.now()}.png`;
      const res = await request(`/storage/v1/object/${bucket}/${nombre}`, {
        method: 'POST', body: cuerpo, timeoutMs: 400_000,
        headers: { ...headers, 'Content-Type': 'image/png', 'x-upsert': 'false' },
      });
      if (res.status < 300) subidos.push(nombre);
      return res.status;
    };
    try {
      expect(await subir(1 * MB), 'control: una foto de 1 MiB debe poder subirse').toBeLessThan(300);
      const resultados = { '5,1 MiB': await subir(5.1 * MB), '6 MiB': await subir(6 * MB) };
      const aceptadas = Object.entries(resultados).filter(([, st]) => st < 300).map(([k]) => k);
      expect(aceptadas, 'el servidor debe rechazar fotos de más de 5 MiB').toEqual([]);
    } finally {
      if (subidos.length) await request(`/storage/v1/object/${bucket}`, { method: 'DELETE', headers: { ...headers, 'Content-Type': 'application/json' }, body: { prefixes: subidos } });
    }
  });

  test('CP-ONB-06: ACH queda disponible en el paso 2 cuando el colegio tiene NMI', async () => {
    const onb = new OnboardingPage(page);
    await onb.goto();
    await onb.datosNino({ ...qaChild(), nacimiento: haceAnios(4) });
    await onb.siguiente('Next: Family Member');
    await onb.familiarNuevo(qaEmail());
    await onb.metodoPago('ACH');
    await expect(page.getByText('ACH is not configured for this school')).toHaveCount(0);
    const marcos = await page.locator('iframe').evaluateAll((fs) => fs.map((f) => { try { return new URL(f.src).host; } catch { return f.src.slice(0, 40); } }));
    console.log(`[CP-ONB-06] iframes en el paso 2 con ACH: ${JSON.stringify(marcos)}`);
  });

  // El informe del punto 6 es el detalle del niño. Solo se ejecuta en CI: en local la sesión del navegador automatizado se cae.
  const seccionesDelDetalle = async () => {
    await page.goto(`/admin/children/${ultimoNinoId}`);
    await expect(page.locator('main'), 'el detalle del niño debe cargar').toContainText('QA-Lbc-', { timeout: SLOW });
    return (await page.locator('main h1, main h2, main h3, main h4').allInnerTexts()).map((t) => t.trim()).filter(Boolean);
  };

  test('CP-ONB-07: el detalle del niño muestra las secciones del informe', async () => {
    test.fixme(!process.env.CI, 'Solo se ejecuta en CI');
    test.skip(!ultimoNinoId, 'Requiere el niño creado por CP-ONB-04');
    const secciones = await seccionesDelDetalle();
    for (const s of ['Basic Information', 'Medical Information', 'Family Information', 'Enrollment Information', 'Billing Contact']) {
      expect(secciones, `falta la sección ${s}`).toContain(s);
    }
  });

  test('CP-ONB-08: el informe sigue el orden y el contenido pedidos en el ticket', async () => {
    test.fixme(!process.env.CI, 'Solo se ejecuta en CI');
    test.skip(!ultimoNinoId, 'Requiere el niño creado por CP-ONB-04');
    test.fail(true, 'Hallazgo 9 nov: el detalle no sigue el orden del ticket (básica, médica, padre, enrolamiento, facturación) ni muestra forzamiento, método de pago ni autorización de recurrencia');
    const secciones = await seccionesDelDetalle();
    const posiciones = ['Basic Information', 'Medical Information', 'Family Information', 'Enrollment Information'].map((t) => secciones.indexOf(t));
    expect(posiciones, 'orden de las secciones: básica, médica, padre, enrolamiento').toEqual([...posiciones].sort((a, b) => a - b));
    const texto = await page.locator('main').evaluate((el) => el.textContent);
    expect(texto, 'forzamiento activo/inactivo en el enrolamiento').toMatch(/forzamiento|enforce|enforcement/i);
    expect(texto, 'método de pago y autorización de recurrencia en la facturación').toMatch(/recurring payment|autorizaci/i);
  });

  test('CP-ONB-09: el selector de fechas de medicación no admite fechas pasadas ni un fin anterior al inicio', async () => {
    const onb = new OnboardingPage(page);
    await onb.goto();
    await onb.datosNino({ ...qaChild(), nacimiento: haceAnios(4) });
    await onb.siguiente('Next: Family Member');
    await onb.familiarNuevo(qaEmail());
    await onb.siguiente('Next: Medical Info');
    const dia = (d) => page.getByRole('button', { name: etiquetaDia(d), exact: true });
    const hoy = enDias(0);

    await page.locator('button', { hasText: 'Select date' }).nth(0).click();
    if (hoy.getDate() > 1) await expect(dia(enDias(-1)), 'ayer no se puede elegir como inicio').toBeDisabled();
    await expect(dia(hoy), 'hoy sí se puede elegir como inicio').toBeEnabled();
    await dia(enDias(3)).click();

    await page.locator('button', { hasText: 'Select date' }).first().click();
    await expect(dia(enDias(2)), 'un fin anterior al inicio no se puede elegir').toBeDisabled();
    await expect(dia(enDias(3)), 'fin igual al inicio sí es válido').toBeEnabled();
  });

  // Punto 5 con un método sin datos sensibles: autorización de recurrencia activa con Cash.
  test('CP-ONB-10: con la autorización de recurrencia activa, la factura queda asociada al método de pago', async () => {
    test.fixme(!process.env.CI, 'Solo se ejecuta en CI');
    test.fail(true, 'Hallazgo 11 nov: con Cash y la autorización de recurrencia activa no se guarda ningún método de pago y la factura no se asocia (a confirmar con desarrollo si Cash debería permitir la casilla)');
    const onb = new OnboardingPage(page);
    const nino = qaChild();
    await onb.goto();
    await onb.datosNino({ ...nino, nacimiento: haceAnios(4) });
    await onb.siguiente('Next: Family Member');
    await onb.familiarNuevo(qaEmail());
    await onb.metodoPago('Cash');
    await page.getByText('Recurring Payment Authorization').first().click();
    await onb.siguiente('Next: Medical Info');
    await onb.siguiente('Next: Enrollment');
    await onb.matricula({ aula: 'habilitada' });
    await onb.completar();

    const buscar = async () => (await rest('children', { headers, query: `last_name=eq.${nino.lastName}&select=id` })).json || [];
    await expect.poll(async () => (await buscar()).length, { timeout: SLOW }).toBe(1);
    const id = (await buscar())[0].id;
    limpieza.trackChild(id);

    const factura = async () => (await rest('invoices', { headers, query: `child_id=eq.${id}&select=id,recurring_payment_method_id,family_id` })).json || [];
    await expect.poll(async () => (await factura()).length, { timeout: 120_000, message: 'se crea la factura de onboarding' }).toBeGreaterThan(0);
    const f = (await factura())[0];
    const metodos = (await rest('payment_methods', { headers, query: `family_id=eq.${f.family_id}&select=id,type,is_recurring_enabled,is_active` })).json || [];
    console.log(`[CP-ONB-10] métodos de la familia: ${JSON.stringify(metodos)}; factura.recurring_payment_method_id: ${f.recurring_payment_method_id}`);
    expect(metodos.some((x) => x.is_recurring_enabled), 'el método guardado debe quedar con la recurrencia habilitada').toBeTruthy();
    expect(f.recurring_payment_method_id, 'la factura debe quedar asociada al método de pago').toBeTruthy();
  });
});
