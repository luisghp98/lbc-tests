const { test, expect } = require('@playwright/test');
const { loginViaUI } = require('../../utils/auth');
const { OnboardingPage, SLOW } = require('../../pages/OnboardingPage');
const { asUser, rest, request } = require('../../utils/rest');
const { qaChild, qaEmail, QaCleanup } = require('../../utils/qa');
const { AulasQA } = require('../../utils/aulas');
const { png, desdeNavegador, archivo } = require('../../utils/imagen');
const { informar, ficha, pagos } = require('../../utils/informe');

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

    // Punto 6: ficha del niño registrado, en el orden del ticket (básica, médica, padre/guardian, enrolamiento, facturación).
    const nf = (await rest('children', { headers, query: `id=eq.${id}&select=first_name,last_name,birth_date,gender,status,school_id,profile_picture_url` })).json[0];
    const familias = (await rest('child_families', { headers, query: `child_id=eq.${id}&select=family_id` })).json || [];
    const responsables = (await rest('child_financial_responsibles', { headers, query: `child_id=eq.${id}&select=id` })).json || [];
    const asignacion = (await rest('classroom_enrollments', { headers, query: `child_id=eq.${id}&status=eq.active&select=classroom:classrooms(classroom_name)` })).json || [];
    const ajustes = ((await rest('schools', { headers, query: `id=eq.${nf.school_id}&select=settings` })).json[0] || {}).settings || {};
    const f0 = (await facturas())[0];
    ficha({
      basica: { nombre: nf.first_name, apellido: nf.last_name, nacimiento: nf.birth_date, genero: nf.gender, estado: nf.status, foto: !!nf.profile_picture_url },
      medica: { medicamento: 'QA-Medicina', inicio: ymd(enDias(0)), fin: ymd(enDias(1)), visibleEnElDetalle: true },
      familiar: { nombre: 'QA-Parent QA-Familiar', documento: 'Passport', familiaAsociada: familias.length > 0, responsableFinanciero: responsables.length > 0 },
      enrolamiento: {
        tipo: 'Full Time', aula: asignacion[0] && asignacion[0].classroom ? asignacion[0].classroom.classroom_name : null,
        forzamientoRatioNino: ajustes.enforce_child_ratio ? 'ACTIVO' : 'INACTIVO', forzamientoRatioStaff: ajustes.enforce_staff_ratio ? 'ACTIVO' : 'INACTIVO',
      },
      facturacion: { metodoDePago: 'No seleccionado', autorizacionRecurrente: 'No marcada', factura: f0.status, total: Number(f0.total_amount), asociadaAMetodoDePago: !!f0.recurring_payment_method_id },
    });
    informar('CP-ONB-01', `niño creado: sí; matrícula con tipo Full Time: sí; factura ${f0.status} por $${Number(f0.total_amount).toFixed(2)}; medicación visible en el detalle: sí; sin recurrencia la factura queda sin método de pago: sí`);
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
    informar('CP-ONB-02', `aula sin personal: deshabilitada con [NO STAFF]; aula con personal sin presencia: ${seleccionable ? 'seleccionable' : 'no seleccionable'}`);
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
    informar('CP-ONB-03', `aceptadas: ${validos.map((f) => f.name).join(', ')}; rechazadas: ${invalidos.map(([f]) => f.name).join(', ')}`);
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

    const foto = async () => ((await rest('children', { headers, query: `id=eq.${hijo.id}&select=profile_picture_url` })).json || [{}])[0].profile_picture_url;
    await expect.poll(foto, { timeout: 120_000, message: 'la foto de 4,9 MiB debe guardarse en el servidor (profile_picture_url)' }).toBeTruthy();
    fotoGuardada = String(await foto());
    informar('CP-ONB-04', `envío ${respuesta.status()}; redirección al detalle: ${redirigio ? 'sí' : 'no'}; foto de 4,9 MiB guardada en el servidor: sí`);
  });

  // Seguridad: salta el tope del cliente y sube directo al almacenamiento, en la carpeta de la foto del niño (así se puede borrar).
  test('CP-ONB-05: el almacenamiento rechaza fotos de más de 5 MiB subidas directo', { tag: '@seguridad' }, async () => {
    test.skip(!fotoGuardada, 'Requiere la foto guardada por CP-ONB-04');
    test.fail(true, 'Hallazgo 11 nov: el servidor acepta fotos de 5,1 y 6 MiB subidas directo; el tope de 5 MB solo existe en el formulario');
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
    informar('CP-ONB-06', `ACH disponible en el paso 2; formularios de pago cargados: ${marcos.length}`);
  });

  test('CP-ONB-07: el selector de fechas de medicación no admite fechas pasadas ni un fin anterior al inicio', async () => {
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
    informar('CP-ONB-07', 'ayer no seleccionable como inicio; hoy seleccionable; fin anterior al inicio no seleccionable; fin igual al inicio seleccionable');
  });

  // Punto 5: la autorización de débito recurrente solo tiene sentido con Card y ACH. Solo se elige el método, no se escribe ningún dato.
  test('CP-ONB-08: la casilla de autorización recurrente solo se muestra con Card y ACH', async () => {
    test.fail(true, 'Hallazgo 12 nov: la casilla también se muestra con Cash, Check y Bank Transfer');
    const onb = new OnboardingPage(page);
    await onb.goto();
    await onb.datosNino({ ...qaChild(), nacimiento: haceAnios(4) });
    await onb.siguiente('Next: Family Member');
    await onb.familiarNuevo(qaEmail());
    const casilla = page.getByText('Recurring Payment Authorization').first();
    const visibles = {};
    for (const metodo of ['Card', 'ACH', 'Cash', 'Check', 'Bank Transfer']) {
      await onb.metodoPago(metodo);
      visibles[metodo] = await casilla.isVisible();
    }
    informar('CP-ONB-08', `casilla visible por método: ${JSON.stringify(visibles)}`);
    expect(visibles.Card && visibles.ACH, 'con Card y ACH debe mostrarse').toBeTruthy();
    expect([visibles.Cash, visibles.Check, visibles['Bank Transfer']], 'con Cash, Check y Bank Transfer no debe mostrarse').toEqual([false, false, false]);
  });

  // Punto 6 (facturación) y puntos 4 y 5: cada método de pago. Con Card y ACH el wizard pide datos de pago, que la automatización no escribe:
  // solo se comprueba que no avanza sin ellos. Con Cash, Check y Bank Transfer se completa el registro y se revisa la factura.
  test('CP-ONB-09: cada método de pago: el registro avanza (o pide datos de pago) y la factura se genera bien', async () => {
    const onb = new OnboardingPage(page);
    const filas = [];
    for (const metodo of ['Card', 'ACH', 'Cash', 'Check', 'Bank Transfer']) {
      const nino = qaChild();
      await onb.goto();
      await onb.datosNino({ ...nino, nacimiento: haceAnios(4) });
      await onb.siguiente('Next: Family Member');
      await onb.familiarNuevo(qaEmail());
      await onb.metodoPago(metodo);
      await onb.siguiente('Next: Medical Info');
      const avanza = await page.getByText('Step 3 of 4').waitFor({ timeout: 10_000 }).then(() => true, () => false);

      if (['Card', 'ACH'].includes(metodo)) {
        expect(avanza, `${metodo}: el wizard no debe avanzar sin datos de pago`).toBeFalsy();
        const creados = (await rest('children', { headers, query: `last_name=eq.${nino.lastName}&select=id` })).json || [];
        expect(creados, `${metodo}: sin datos de pago no se crea el niño`).toHaveLength(0);
        filas.push({ metodo, registro: 'No avanza sin datos de pago', factura: '—', total: null, estado: '—', metodoAsociado: '—', nota: 'La verificación con datos de pago es manual (la automatización no escribe datos de pago)' });
        continue;
      }

      expect(avanza, `${metodo}: no requiere datos de pago, el wizard debe avanzar`).toBeTruthy();
      await onb.siguiente('Next: Enrollment');
      await onb.matricula({ aula: 'habilitada' });
      const envio = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().includes('/admin/children/new'), { timeout: SLOW });
      await onb.completar();
      await envio;
      await page.waitForURL(/\/admin\/children\/[0-9a-f-]{36}/, { timeout: 120_000 });
      const id = page.url().match(/children\/([0-9a-f-]{36})/)[1];
      limpieza.trackChild(id);

      const leer = async () => (await rest('invoices', { headers, query: `child_id=eq.${id}&select=invoice_number,status,subtotal,tax_amount,discount_amount,total_amount,amount_paid,balance_due,issue_date,due_date,family_id,recurring_payment_method_id` })).json || [];
      await expect.poll(async () => (await leer()).length, { timeout: 120_000, message: `${metodo}: se genera la factura de onboarding` }).toBeGreaterThan(0);
      const f = (await leer())[0];
      const n = (x) => Number(x);
      expect(f.status, `${metodo}: la factura queda pendiente`).toBe('pending');
      expect(n(f.total_amount), `${metodo}: la factura tiene importe`).toBeGreaterThan(0);
      expect(n(f.total_amount), `${metodo}: total = subtotal + impuesto - descuento`).toBeCloseTo(n(f.subtotal) + n(f.tax_amount) - n(f.discount_amount), 2);
      expect(n(f.balance_due), `${metodo}: saldo = total - pagado`).toBeCloseTo(n(f.total_amount) - n(f.amount_paid), 2);
      expect(f.due_date > f.issue_date, `${metodo}: el vencimiento es posterior a la emisión`).toBeTruthy();
      expect(f.family_id, `${metodo}: la factura queda asociada a la familia`).toBeTruthy();
      expect(f.recurring_payment_method_id, `${metodo}: sin recurrencia la factura no se asocia a un método de pago`).toBeNull();
      filas.push({ metodo, registro: 'Completado', factura: f.invoice_number, total: n(f.total_amount), estado: f.status, metodoAsociado: 'No', nota: 'El método elegido no se guarda (no hay datos de pago que registrar)' });
    }
    pagos(filas);
    informar('CP-ONB-09', filas.map((x) => x.total === null ? `${x.metodo}: no avanza sin datos de pago` : `${x.metodo}: factura ${x.estado} por $${x.total.toFixed(2)}`).join(' | '));
  });
});
