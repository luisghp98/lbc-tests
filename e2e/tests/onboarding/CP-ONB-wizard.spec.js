const { test, expect } = require('@playwright/test');
const { loginViaUI } = require('../../utils/auth');
const { OnboardingPage, SLOW } = require('../../pages/OnboardingPage');
const { asUser, rest, request } = require('../../utils/rest');
const { qaChild, qaEmail, QaCleanup } = require('../../utils/qa');
const { AulasQA } = require('../../utils/aulas');
const { png, desdeNavegador, archivo } = require('../../utils/imagen');
const { informar, ficha, pagos, recurrencia } = require('../../utils/informe');

const MB = 1024 * 1024;
const enDias = (n) => new Date(Date.now() + n * 86400000);
const ymd = (d) => d.toLocaleDateString('en-CA');
const MESES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const etiquetaDia = (d) => `${MESES[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
// Datos médicos que se registran en el paso 3 y se buscan después en el detalle del niño.
const MED = {
  alergia: 'QA-Alergia', condicion: 'QA-Asma', severidad: 'Moderate', notasCondicion: 'QA-Notas-condicion',
  medicamento: 'QA-Medicina', dosis: 'QA-5-ml', frecuencia: 'QA-Cada-8-horas', instrucciones: 'QA-Instrucciones', necesidades: 'QA-Necesidad-especial',
};
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


  // Texto del detalle del niño con sus tres pestañas abiertas (el contenido de las no abiertas puede no estar en el DOM).
  const textoDelDetalle = async () => {
    let todo = '';
    for (const pestana of ['General information', 'Family & billing', 'Medical & attendance']) {
      await page.getByText(pestana, { exact: true }).first().click();
      await expect(page.locator('main')).not.toContainText('Loading', { timeout: 60_000 }).catch(() => {});
      todo += ' ' + (await page.locator('main').evaluate((el) => el.textContent));
    }
    return todo.replace(/\s+/g, ' ');
  };

  // Ficha del niño registrado, en el orden del punto 6 del ticket. Devuelve la factura de onboarding.
  const fichaDelNino = async (id, { escenario, medica }) => {
    const nf = (await rest('children', { headers, query: `id=eq.${id}&select=first_name,last_name,birth_date,gender,status,school_id,profile_picture_url` })).json[0];
    const familias = (await rest('child_families', { headers, query: `child_id=eq.${id}&select=family_id` })).json || [];
    const responsables = (await rest('child_financial_responsibles', { headers, query: `child_id=eq.${id}&select=id` })).json || [];
    const miembros = familias[0] ? (await rest('family_members', { headers, query: `family_id=eq.${familias[0].family_id}&select=relationship,is_primary_contact,can_pickup,can_authorize_medical,can_authorize_activities,payment_method_preference` })).json || [] : [];
    const m0 = miembros[0] || {};
    const asignacion = (await rest('classroom_enrollments', { headers, query: `child_id=eq.${id}&status=eq.active&select=classroom:classrooms(classroom_name)` })).json || [];
    const ajustes = ((await rest('schools', { headers, query: `id=eq.${nf.school_id}&select=settings` })).json[0] || {}).settings || {};
    const f0 = ((await rest('invoices', { headers, query: `child_id=eq.${id}&select=status,total_amount,recurring_payment_method_id` })).json || [])[0] || {};
    ficha({
      escenario,
      basica: { nombre: nf.first_name, apellido: nf.last_name, nacimiento: nf.birth_date, genero: nf.gender, estado: nf.status, foto: !!nf.profile_picture_url },
      medica,
      familiar: {
        nombre: 'QA-Parent QA-Familiar', documento: 'Passport', parentesco: m0.relationship || null, contactoPrincipal: !!m0.is_primary_contact,
        autorizadoRecoger: !!m0.can_pickup, autorizaTratamientoMedico: !!m0.can_authorize_medical, autorizaActividades: !!m0.can_authorize_activities,
        familiaAsociada: familias.length > 0, responsableFinanciero: responsables.length > 0,
      },
      enrolamiento: {
        tipo: 'Full Time', aula: asignacion[0] && asignacion[0].classroom ? asignacion[0].classroom.classroom_name : null,
        forzamientoRatioNino: ajustes.enforce_child_ratio ? 'ACTIVO' : 'INACTIVO', forzamientoRatioStaff: ajustes.enforce_staff_ratio ? 'ACTIVO' : 'INACTIVO',
      },
      facturacion: {
        metodoDePago: 'No seleccionado', metodoGuardadoEnLaFamilia: m0.payment_method_preference || null, autorizacionRecurrente: 'No marcada',
        factura: f0.status, total: Number(f0.total_amount), asociadaAMetodoDePago: !!f0.recurring_payment_method_id,
      },
    });
    return f0;
  };

  test('CP-ONB-01: registro completo con foto, medicación y primera aula habilitada', async () => {
    const onb = new OnboardingPage(page);
    const nino = qaChild();
    await onb.goto();
    await onb.datosNino({ ...nino, nacimiento: haceAnios(4), foto: archivo('foto-qa.png', 'image/png', png(1 * MB)) });
    await expect(onb.errorFoto()).toHaveCount(0);
    await onb.siguiente('Next: Family Member');
    await onb.familiarNuevo(qaEmail(), { parentesco: 'Mother', principal: true, recoger: true, medico: true, actividades: true });
    await onb.siguiente('Next: Medical Info');
    await onb.alergia(MED.alergia);
    await expect(page.getByText(MED.alergia).first(), 'la alergia añadida debe aparecer en la lista del paso 3').toBeVisible();
    await onb.condicion({ nombre: MED.condicion, severidad: MED.severidad, notas: MED.notasCondicion });
    await expect(page.getByText(MED.condicion).first(), 'la condición añadida debe aparecer en la lista del paso 3').toBeVisible();
    await onb.medicacion({ nombre: MED.medicamento, dosis: MED.dosis, frecuencia: MED.frecuencia, instrucciones: MED.instrucciones, inicio: enDias(0), fin: enDias(1) });
    await expect(page.getByText(MED.medicamento).first(), 'la medicación añadida debe aparecer en la lista del paso 3').toBeVisible();
    await onb.necesidades(MED.necesidades);
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

    // Punto 2: los datos médicos del paso 3 se ven en el detalle del niño (la tabla `medications` no es legible con este rol).
    await expect(page.locator('main'), 'la medicación registrada debe verse en el detalle del niño').toContainText(MED.medicamento, { timeout: 60_000 });
    const detalle = await textoDelDetalle();
    const guardado = {
      alergia: detalle.includes(MED.alergia), condicion: detalle.includes(MED.condicion), severidad: detalle.includes(MED.severidad),
      notasCondicion: detalle.includes(MED.notasCondicion), medicamento: detalle.includes(MED.medicamento), dosis: detalle.includes(MED.dosis),
      frecuencia: detalle.includes(MED.frecuencia), instrucciones: detalle.includes(MED.instrucciones), necesidades: detalle.includes(MED.necesidades),
    };
    console.log(`[CP-ONB-01] datos médicos visibles en el detalle: ${JSON.stringify(guardado)}`);
    expect(guardado, 'los datos médicos registrados deben verse en el detalle del niño').toEqual(expect.objectContaining({ alergia: true, condicion: true, medicamento: true, necesidades: true }));

    // Punto 5: sin autorización de débito recurrente, la factura queda sin método de pago asociado.
    expect((await facturas())[0].recurring_payment_method_id, 'sin recurrencia, la factura no se asocia a un método de pago').toBeNull();

    // Punto 6: ficha del niño registrado, en el orden del ticket (básica, médica, padre/guardian, enrolamiento, facturación).
    const f0 = await fichaDelNino(id, {
      escenario: 'Registro completo con foto, datos médicos y familiar',
      medica: {
        alergia: MED.alergia, condicion: MED.condicion, severidad: MED.severidad, notasCondicion: MED.notasCondicion,
        medicamento: MED.medicamento, dosis: MED.dosis, frecuencia: MED.frecuencia, instrucciones: MED.instrucciones, inicio: ymd(enDias(0)), fin: ymd(enDias(1)),
        necesidades: MED.necesidades, visiblesEnElDetalle: guardado,
      },
    });
    informar('CP-ONB-01', `niño creado: sí; matrícula con tipo Full Time: sí; factura ${f0.status} por $${Number(f0.total_amount).toFixed(2)}; datos médicos visibles en el detalle: sí; sin recurrencia la factura queda sin método de pago: sí`);
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
    const oculta = (await conAsignacion.count()) === 0;
    informar('CP-ONB-02', `aula sin personal: deshabilitada con [NO STAFF]; aula con personal asignado y sin presencia: ${seleccionable ? 'seleccionable' : oculta ? 'no aparece en la lista' : 'aparece cerrada'}`);
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
        filas.push({ metodo, registro: 'No avanza sin datos de pago', factura: '—', total: null, estado: '—', metodoAsociado: '—', guardadoEnLaFamilia: '—', nota: 'La verificación con datos de pago es manual (la automatización no escribe datos de pago)' });
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
      const guardadoEnLaFamilia = async (familia) => ((await rest('family_members', { headers, query: `family_id=eq.${familia}&select=payment_method_preference` })).json || [{}])[0].payment_method_preference || 'ninguno';
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
      const guardado = await guardadoEnLaFamilia(f.family_id);
      filas.push({ metodo, registro: 'Completado', factura: f.invoice_number, total: n(f.total_amount), estado: f.status, metodoAsociado: 'No', guardadoEnLaFamilia: guardado, nota: 'Sin datos de pago no se registra un método de pago; la factura no se asocia a ninguno' });
    }
    pagos(filas);
    informar('CP-ONB-09', filas.map((x) => x.total === null ? `${x.metodo}: no avanza sin datos de pago` : `${x.metodo}: factura ${x.estado} por $${x.total.toFixed(2)}`).join(' | '));
  });

  // Punto 6 (enrolamiento): forzamiento de ratio activo e inactivo (LBC-366). El estado se cambia en la escuela y se restaura al terminar.
  test('CP-ONB-10: forzamiento de ratio activo e inactivo: el registro se completa y el informe refleja el estado', async () => {
    const onb = new OnboardingPage(page);
    const escuelaId = (await rest('staff', { headers, query: 'limit=1&select=school_id' })).json[0].school_id;
    const original = (await rest('schools', { headers, query: `id=eq.${escuelaId}&select=settings` })).json[0].settings;
    const filas = [];
    try {
      for (const [estado, valor] of [['ACTIVO', true], ['INACTIVO', false]]) {
        const cambio = await rest('schools', { method: 'PATCH', headers, query: `id=eq.${escuelaId}`, body: { settings: { ...original, enforce_child_ratio: valor } } });
        expect(cambio.status, `se debe poder poner el forzamiento ${estado}`).toBeLessThan(300);
        await onb.goto();
        await onb.datosNino({ ...qaChild(), nacimiento: haceAnios(4) });
        await onb.siguiente('Next: Family Member');
        await onb.familiarNuevo(qaEmail());
        await onb.siguiente('Next: Medical Info');
        await onb.siguiente('Next: Enrollment');
        await onb.matricula({ aula: null });
        // LBC-366: en cualquier estado del forzamiento, un aula sin personal ni ratio sigue cerrada.
        await expect(await onb.opcionAula(aulaSinPersonal.nombre), `con el forzamiento ${estado} un aula sin personal ni ratio sigue cerrada`).toBeDisabled();
        await page.keyboard.press('Escape');
        await onb.primeraHabilitada(/Classroom/);
        const envio = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().includes('/admin/children/new'), { timeout: SLOW });
        await onb.completar();
        await envio;
        await page.waitForURL(/\/admin\/children\/[0-9a-f-]{36}/, { timeout: 120_000 });
        const id = page.url().match(/children\/([0-9a-f-]{36})/)[1];
        limpieza.trackChild(id);
        await expect.poll(async () => ((await rest('invoices', { headers, query: `child_id=eq.${id}&select=id` })).json || []).length, { timeout: 120_000, message: 'se genera la factura de onboarding' }).toBeGreaterThan(0);
        const f = await fichaDelNino(id, { escenario: `Forzamiento de ratio ${estado}`, medica: null });
        filas.push(`${estado}: registro completado, factura ${f.status}; aula sin personal ni ratio cerrada`);
      }
    } finally {
      await rest('schools', { method: 'PATCH', headers, query: `id=eq.${escuelaId}`, body: { settings: original } });
    }
    informar('CP-ONB-10', filas.join(' | '));
  });

  // Punto 5 del ticket con los métodos que no piden datos de pago: la autorización de recurrencia se marca y se revisa la factura.
  test('CP-ONB-11: autorización de recurrencia marcada con Cash, Check y Bank Transfer: la factura se genera', async () => {
    const onb = new OnboardingPage(page);
    const filas = [];
    for (const metodo of ['Cash', 'Check', 'Bank Transfer']) {
      await onb.goto();
      await onb.datosNino({ ...qaChild(), nacimiento: haceAnios(4) });
      await onb.siguiente('Next: Family Member');
      await onb.familiarNuevo(qaEmail());
      await onb.metodoPago(metodo);
      const casilla = page.getByRole('checkbox', { name: /Recurring Payment Authorization/i });
      await casilla.first().check();
      expect(await casilla.first().isChecked(), `${metodo}: la casilla queda marcada`).toBeTruthy();
      await onb.siguiente('Next: Medical Info');
      await page.getByText('Step 3 of 4').waitFor({ timeout: 30_000 });
      await onb.siguiente('Next: Enrollment');
      await onb.matricula({ aula: 'habilitada' });
      const envio = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().includes('/admin/children/new'), { timeout: SLOW });
      await onb.completar();
      await envio;
      await page.waitForURL(/\/admin\/children\/[0-9a-f-]{36}/, { timeout: 120_000 });
      const id = page.url().match(/children\/([0-9a-f-]{36})/)[1];
      limpieza.trackChild(id);
      const leer = async () => (await rest('invoices', { headers, query: `child_id=eq.${id}&select=invoice_number,status,total_amount,family_id,recurring_payment_method_id` })).json || [];
      await expect.poll(async () => (await leer()).length, { timeout: 120_000, message: `${metodo}: se genera la factura de onboarding` }).toBeGreaterThan(0);
      const f = (await leer())[0];
      expect(f.status, `${metodo}: la factura queda pendiente`).toBe('pending');
      expect(Number(f.total_amount), `${metodo}: la factura tiene importe`).toBeGreaterThan(0);
      const metodos = (await rest('payment_methods', { headers, query: `family_id=eq.${f.family_id}&select=type` })).json || [];
      const pref = ((await rest('family_members', { headers, query: `family_id=eq.${f.family_id}&select=payment_method_preference` })).json || [{}])[0].payment_method_preference || 'ninguno';
      filas.push({ metodo, casilla: 'Marcada', registro: 'Completado', factura: f.invoice_number, total: Number(f.total_amount), estado: f.status, asociada: f.recurring_payment_method_id ? 'Sí' : 'No', metodosGuardados: metodos.length, preferencia: pref });
    }
    recurrencia(filas);
    informar('CP-ONB-11', filas.map((x) => `${x.metodo}: casilla marcada, factura ${x.estado} por $${x.total.toFixed(2)}, asociada a un método: ${x.asociada.toLowerCase()}`).join(' | '));
  });
});
