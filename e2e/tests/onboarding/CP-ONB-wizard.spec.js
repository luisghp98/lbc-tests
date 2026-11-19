const { test, expect } = require('@playwright/test');
const { loginViaUI } = require('../../utils/auth');
const { OnboardingPage, SLOW } = require('../../pages/OnboardingPage');
const { asUser, rest } = require('../../utils/rest');
const { qaChild, qaEmail, QaCleanup } = require('../../utils/qa');
const { AulasQA } = require('../../utils/aulas');
const { png, desdeNavegador, archivo } = require('../../utils/imagen');
const { informar, ficha } = require('../../utils/informe');
const pago = require('../../utils/datos-pago');

// LBC-1702 amplía la automatización del onboarding de Ariel (LBC-365). Numeración: CP-ONB-01 a 07 son los casos de Ariel
// (registro completo, solo obligatorios, campos obligatorios, persistencia, ratio y forzamiento, familia y factura);
// del 08 en adelante están los ajustes de la 1702 (fechas de medicación, foto, aulas, método de pago, recurrencia, sesión y forzamiento).
const MB = 1024 * 1024;
const enDias = (n) => new Date(Date.now() + n * 86400000);
const ymd = (d) => d.toLocaleDateString('en-CA');
const MESES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const etiquetaDia = (d) => `${MESES[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
const haceAnios = (n) => { const d = new Date(); d.setFullYear(d.getFullYear() - n); return d; };
// Datos médicos del paso 3, que se buscan después en el detalle del niño.
const MED = {
  alergia: 'QA-Alergia', condicion: 'QA-Asma', severidad: 'Moderate', notasCondicion: 'QA-Notas-condicion',
  medicamento: 'QA-Medicina', dosis: 'QA-5-ml', frecuencia: 'QA-Cada-8-horas', instrucciones: 'QA-Instrucciones', necesidades: 'QA-Necesidad-especial',
};
const FAMILIAR = { parentesco: 'Mother', principal: true, recoger: true, medico: true, actividades: true };

test.describe('CP-ONB: Onboarding del niño (wizard)', { tag: '@onboarding' }, () => {
  test.setTimeout(900_000);

  const limpieza = new QaCleanup();
  const aulas = new AulasQA();
  let page; let headers; let escuelaId; let originalEscuela;
  let aulaSinPersonal; let aulaConAsignacion; let aulaDestino;
  let principal = null; // niño del CP-ONB-01, lo usan los casos 04, 05 y 06
  let ajustesPago = null; // valores originales de payment_method_*_enabled mientras el CP-ONB-19 los cambia; afterAll los restaura si algo falla

  // Devuelve a la escuela los ajustes de métodos de pago que cambia el CP-ONB-19. Reintenta porque, si falla, la escuela quedaría con un método deshabilitado.
  async function restaurarPago() {
    if (!ajustesPago) return;
    for (let intento = 1; intento <= 5; intento++) {
      try {
        const r = await rest('school_settings', { method: 'PATCH', headers: await asUser(), query: `school_id=eq.${escuelaId}&deleted_at=is.null`, body: ajustesPago });
        if (r.status < 300) return;
      } catch (e) { /* se reintenta */ }
      await new Promise((resolver) => setTimeout(resolver, 4000 * intento));
    }
    console.log('[CP-ONB-19] ATENCIÓN: no se pudieron restaurar los ajustes de métodos de pago; comprobar que Card y ACH sigan habilitados en la escuela');
  }

  test.beforeAll(async ({ browser }) => {
    page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
    await loginViaUI(page);
    headers = await asUser();
    await limpieza.sweep(headers);
    await aulas.sweep(headers);
    escuelaId = (await rest('staff', { headers, query: 'limit=1&select=school_id' })).json[0].school_id;
    originalEscuela = (await rest('schools', { headers, query: `id=eq.${escuelaId}&select=settings` })).json[0].settings;
    // Precondición: tiene que haber un aula habilitada en el paso 4 (hoy la habilita el personal presente; la 1702 no pide crear ratios ni personal).
    const disp = await rest('rpc/fn_get_enrollment_classroom_availability', { method: 'POST', headers, body: { p_school_id: escuelaId, p_child_birth_date: ymd(haceAnios(4)), p_start_date: ymd(enDias(0)) } });
    const habilitadas = (disp.json || []).filter((c) => c.can_enroll && !/^QA-/.test(c.classroom_name));
    if (!habilitadas.length) throw new Error('Precondición: no hay ningún aula habilitada para inscribir (hace falta un aula con ratio y personal presente); sin ella el paso 4 no se puede completar');
    const ratio = (await rest('staff_ratios', { headers, query: 'ratio_name=eq.Small Infants&deleted_at=is.null&select=id' })).json[0];
    aulaSinPersonal = await aulas.crear(headers, { etiqueta: 'SinPersonal', conPersonal: false });
    aulaConAsignacion = await aulas.crear(headers, { etiqueta: 'ConAsignacion', conPersonal: true });
    aulaDestino = await aulas.crear(headers, { etiqueta: 'Destino', conPersonal: true, ratioId: ratio.id });
  });

  test.afterAll(async () => {
    headers = await asUser();
    await rest('schools', { method: 'PATCH', headers, query: `id=eq.${escuelaId}`, body: { settings: originalEscuela } });
    await restaurarPago();
    await limpieza.run(headers);
    await aulas.limpiar(headers);
    await page.context().close();
  });

  const forzamiento = async (activo) => {
    const r = await rest('schools', { method: 'PATCH', headers, query: `id=eq.${escuelaId}`, body: { settings: { ...originalEscuela, enforce_child_ratio: activo } } });
    expect(r.status, 'se debe poder cambiar el forzamiento').toBeLessThan(300);
  };
  const facturasDe = async (id) => (await rest('invoices', { headers, query: `child_id=eq.${id}&select=id,invoice_number,status,subtotal,tax_amount,total_amount,family_id,recurring_payment_method_id` })).json || [];

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

  // Ficha del niño registrado en el orden del punto 6 del ticket: la leen el informe y su "Resultado Real".
  const fichaDelNino = async (id, { cp, caso, medica, metodo, recurrente }) => {
    const nf = (await rest('children', { headers, query: `id=eq.${id}&select=first_name,last_name,birth_date,gender,status,school_id,profile_picture_url` })).json[0];
    const familias = (await rest('child_families', { headers, query: `child_id=eq.${id}&select=family_id` })).json || [];
    const responsables = (await rest('child_financial_responsibles', { headers, query: `child_id=eq.${id}&select=id` })).json || [];
    const miembros = familias[0] ? (await rest('family_members', { headers, query: `family_id=eq.${familias[0].family_id}&select=relationship,is_primary_contact,can_pickup,can_authorize_medical,can_authorize_activities` })).json || [] : [];
    const m0 = miembros[0] || {};
    const metodos = familias[0] ? (await rest('payment_methods', { headers, query: `family_id=eq.${familias[0].family_id}&select=type,is_recurring_enabled` })).json || [] : [];
    const matricula = (await rest('enrollments', { headers, query: `child_id=eq.${id}&select=enrollment_type_id` })).json[0] || {};
    const tipo = matricula.enrollment_type_id ? (await rest('enrollment_types', { headers, query: `id=eq.${matricula.enrollment_type_id}&select=name` })).json[0] : null;
    const asignacion = (await rest('classroom_enrollments', { headers, query: `child_id=eq.${id}&status=eq.active&select=classroom:classrooms(classroom_name)` })).json || [];
    const ajustes = ((await rest('schools', { headers, query: `id=eq.${nf.school_id}&select=settings` })).json[0] || {}).settings || {};
    const f0 = (await facturasDe(id))[0] || {};
    ficha({
      cp, caso, estado: 'completado',
      basica: { nombre: nf.first_name, apellido: nf.last_name, nacimiento: nf.birth_date, genero: nf.gender, estado: nf.status, foto: !!nf.profile_picture_url },
      medica,
      familiar: {
        nombre: 'QA-Parent QA-Familiar', parentesco: m0.relationship || null, contactoPrincipal: !!m0.is_primary_contact, autorizadoRecoger: !!m0.can_pickup,
        autorizaTratamientoMedico: !!m0.can_authorize_medical, autorizaActividades: !!m0.can_authorize_activities, familiaAsociada: familias.length > 0, responsableFinanciero: responsables.length > 0,
      },
      enrolamiento: {
        tipo: tipo ? tipo.name : null, aula: asignacion[0] && asignacion[0].classroom ? asignacion[0].classroom.classroom_name : null,
        forzamientoRatioNino: ajustes.enforce_child_ratio ? 'ACTIVO' : 'INACTIVO', forzamientoRatioStaff: ajustes.enforce_staff_ratio ? 'ACTIVO' : 'INACTIVO',
      },
      facturacion: {
        metodoDePago: metodo || 'No seleccionado', autorizacionRecurrente: recurrente ? 'Marcada' : 'No marcada',
        metodoGuardado: metodos.length ? metodos.map((x) => `${x.type}${x.is_recurring_enabled ? ' (recurrencia habilitada)' : ''}`).join(', ') : 'ninguno',
        factura: f0.invoice_number || null, estadoFactura: f0.status || null, total: Number(f0.total_amount), asociadaAMetodoDePago: !!f0.recurring_payment_method_id,
      },
    });
    return f0;
  };

  /**
   * Registro por el wizard con datos en las cinco partes del informe. Devuelve { avanza, id, nino }.
   * metodo: 'Card' | 'ACH' | null. datos: 'validos' | 'invalidos' | null (los escribe e2e/utils/datos-pago.js, que completa una persona).
   */
  async function registro({ cp, caso, completo = true, foto = 0, metodo = null, datos = null, recurrente = false, tipo = /Full Time —/, productoExtra = null, aulaCerrada = null }) {
    const onb = new OnboardingPage(page);
    const nino = qaChild();
    await onb.goto();
    await onb.datosNino({ ...nino, nacimiento: haceAnios(4), foto: foto ? archivo('foto-qa.png', 'image/png', png(foto * MB)) : undefined });
    if (foto) await expect(onb.errorFoto()).toHaveCount(0);
    await onb.siguiente('Next: Family Member');
    await onb.familiarNuevo(qaEmail(), completo ? FAMILIAR : {});
    if (metodo) {
      await onb.metodoPago(metodo);
      if (datos) {
        const motivo = pago.pendiente(metodo);
        if (motivo) { ficha({ cp, caso, estado: 'pendiente', motivo, facturacion: { metodoDePago: metodo, autorizacionRecurrente: recurrente ? 'Marcada' : 'No marcada' } }); return { pendiente: motivo, nino }; }
        await (metodo === 'Card' ? pago.llenarTarjeta(page, pago.datosTarjeta(datos === 'invalidos')) : pago.llenarACH(page, pago.datosACH(datos === 'invalidos')));
      }
    }
    if (recurrente) {
      const casilla = page.getByRole('checkbox', { name: /Recurring Payment Authorization/i }).first();
      await casilla.check();
      expect(await casilla.isChecked(), 'la casilla de recurrencia queda marcada').toBeTruthy();
    }
    await onb.siguiente('Next: Medical Info');
    const avanza = await page.getByText('Step 3 of 4').waitFor({ timeout: 10_000 }).then(() => true, () => false);
    if (!avanza) {
      const creados = (await rest('children', { headers, query: `last_name=eq.${nino.lastName}&select=id` })).json || [];
      expect(creados, 'si el wizard no avanza no se crea el niño').toHaveLength(0);
      ficha({
        cp, caso, estado: 'noAvanza',
        basica: { nombre: nino.firstName, apellido: nino.lastName, nacimiento: ymd(haceAnios(4)), genero: 'male', foto: false },
        familiar: { nombre: 'QA-Parent QA-Familiar', parentesco: completo ? 'mother' : null },
        facturacion: { metodoDePago: metodo || 'No seleccionado', autorizacionRecurrente: recurrente ? 'Marcada' : 'No marcada' },
      });
      return { avanza: false, nino };
    }
    if (completo) {
      await onb.alergia(MED.alergia);
      await onb.condicion({ nombre: MED.condicion, severidad: MED.severidad, notas: MED.notasCondicion });
      await onb.medicacion({ nombre: MED.medicamento, dosis: MED.dosis, frecuencia: MED.frecuencia, instrucciones: MED.instrucciones, inicio: enDias(0), fin: enDias(1) });
      await expect(page.getByText(MED.medicamento).first(), 'la medicación añadida aparece en la lista del paso 3').toBeVisible();
      await onb.necesidades(MED.necesidades);
    }
    await onb.siguiente('Next: Enrollment');
    if (aulaCerrada) {
      await onb.matricula({ tipo, aula: null });
      await expect(await onb.opcionAula(aulaCerrada), 'un aula sin personal ni ratio sigue cerrada').toBeDisabled();
      await page.keyboard.press('Escape');
      await onb.primeraHabilitada(/Classroom/);
    } else {
      await onb.matricula({ tipo, aula: 'habilitada' });
    }
    if (productoExtra) await onb.agregarProducto(productoExtra);
    if (metodo && datos) await pago.alCompletar(page, metodo);
    const envio = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().includes('/admin/children/new'), { timeout: SLOW });
    await onb.completar();
    await envio;
    await page.waitForURL(/\/admin\/children\/[0-9a-f-]{36}/, { timeout: 120_000 });
    const buscar = async () => (await rest('children', { headers, query: `last_name=eq.${nino.lastName}&select=id` })).json || [];
    await expect.poll(async () => (await buscar()).length, { timeout: SLOW, message: 'el niño debe crearse' }).toBe(1);
    const id = (await buscar())[0].id;
    limpieza.trackChild(id);
    await expect.poll(async () => (await facturasDe(id)).length, { timeout: 120_000, message: 'se crea la factura de onboarding' }).toBeGreaterThan(0);
    let medica = null;
    if (completo) {
      const detalle = await textoDelDetalle();
      const visibles = Object.fromEntries(Object.entries(MED).map(([k, v]) => [k, detalle.includes(v)]));
      expect(visibles, 'los datos médicos registrados se ven en el detalle del niño').toEqual(expect.objectContaining({ alergia: true, condicion: true, medicamento: true, necesidades: true }));
      medica = { ...MED, inicio: ymd(enDias(0)), fin: ymd(enDias(1)), visibles };
    }
    const f = await fichaDelNino(id, { cp, caso, medica, metodo, recurrente });
    return { avanza: true, id, nino, factura: f };
  }

  // ───────────────────────────── Casos de Ariel (LBC-365) ─────────────────────────────
  test('CP-ONB-01: registro completo por el wizard de 4 pasos (foto, datos médicos y familiar)', async () => {
    const r = await registro({ cp: 'CP-ONB-01', caso: 'Registro completo con foto, datos médicos y familiar', completo: true, foto: 1 });
    expect(r.avanza).toBe(true);
    expect(r.factura.status, 'la factura de onboarding queda pendiente').toBe('pending');
    expect(Number(r.factura.total_amount), 'la factura tiene importe').toBeGreaterThan(0);
    principal = r;
    informar('CP-ONB-01', 'ver los cinco pasos');
  });

  test('CP-ONB-02: registro con solo los campos obligatorios', async () => {
    const r = await registro({ cp: 'CP-ONB-02', caso: 'Registro con solo los campos obligatorios (sin foto ni datos médicos)', completo: false });
    expect(r.avanza).toBe(true);
    expect(r.factura.status).toBe('pending');
    informar('CP-ONB-02', 'ver los cinco pasos');
  });

  test('CP-ONB-03: regla de negocio: campos obligatorios y aceptación de políticas; sin ellos no registra', async () => {
    const onb = new OnboardingPage(page);
    await onb.goto();
    await onb.siguiente('Next: Family Member'); // sin datos
    const vacioAvanza = await page.getByText('Step 2 of 4').waitFor({ timeout: 5_000 }).then(() => true, () => false);
    expect(vacioAvanza, 'con el formulario vacío no se puede continuar').toBe(false);
    await onb.goto();
    await onb.datosNino({ ...qaChild(), nacimiento: haceAnios(4), politicas: false });
    await onb.siguiente('Next: Family Member');
    const sinPoliticas = await page.getByText('Step 2 of 4').waitFor({ timeout: 5_000 }).then(() => true, () => false);
    expect(sinPoliticas, 'sin aceptar las políticas no se puede continuar').toBe(false);
    await page.getByRole('checkbox', { name: /Acceptance of Policies/ }).check();
    await onb.siguiente('Next: Family Member');
    await expect(page.getByText('Step 2 of 4'), 'control positivo: aceptando las políticas sí avanza').toBeVisible({ timeout: 30_000 });
    informar('CP-ONB-03', 'formulario vacío: no avanza; sin aceptar políticas: no avanza; aceptando las políticas: avanza al paso 2; no se crea ningún niño');
  });

  test('CP-ONB-04: persistencia y roundtrip del niño registrado (API)', async () => {
    test.skip(!principal, 'Requiere el niño de CP-ONB-01');
    const id = principal.id;
    const hijo = (await rest('children', { headers, query: `id=eq.${id}&select=id,first_name,last_name,status,deleted_at` })).json[0];
    const matricula = (await rest('enrollments', { headers, query: `child_id=eq.${id}&select=enrollment_type_id` })).json[0];
    const tipo = (await rest('enrollment_types', { headers, query: `name=eq.${encodeURIComponent('Full Time')}&deleted_at=is.null&select=id` })).json[0];
    const aula = (await rest('classroom_enrollments', { headers, query: `child_id=eq.${id}&status=eq.active&select=classroom_id` })).json[0];
    const factura = (await facturasDe(id))[0];
    expect(hijo.last_name, 'el apellido persiste').toBe(principal.nino.lastName);
    expect(hijo.deleted_at, 'el niño no está dado de baja').toBeNull();
    expect(hijo.status, 'el estado final del niño es Pending').toBe('pending');
    expect(matricula.enrollment_type_id, 'la matrícula queda con el tipo de enrolamiento elegido').toBe(tipo.id);
    expect(aula, 'el niño queda asignado a un aula').toBeTruthy();
    expect(factura.status, 'el estado de pago es Pending').toBe('pending');
    informar('CP-ONB-04', `niño persistido: sí; nombre correcto: sí; no eliminado: sí; estado=${hijo.status}; tipo de enrolamiento=Full Time; aula asignada: sí; factura ${factura.invoice_number} ${factura.status}`);
  });

  test('CP-ONB-05: validación de ratio y forzamiento activo e inactivo (RPC)', async () => {
    test.skip(!principal, 'Requiere el niño de CP-ONB-01');
    const validar = async () => (await rest('rpc/fn_validate_child_checkin', { method: 'POST', headers, body: { p_child_id: principal.id, p_classroom_id: aulaDestino.id, p_school_id: escuelaId } })).json;
    try {
      await forzamiento(true);
      const activo = await validar();
      await forzamiento(false);
      const inactivo = await validar();
      informar('CP-ONB-05', `forzamiento activo: acción=${activo.validation_action}, permitido=${activo.allowed}, razón=${activo.reason}; forzamiento inactivo: acción=${inactivo.validation_action}, requiere confirmación=${inactivo.requires_confirmation}`);
      expect(activo.enforce_active).toBe(true);
      expect(activo.allowed).toBe(false);
      expect(activo.validation_action, 'activo: bloquea').toBe('block');
      expect(inactivo.enforce_active).toBe(false);
      expect(inactivo.validation_action, 'inactivo: pide confirmación').toBe('confirm');
      expect(inactivo.requires_confirmation).toBe(true);
    } finally { await forzamiento(true); }
  });

  test('CP-ONB-06: familia: el niño queda asociado a una familia con su familiar y responsable financiero', async () => {
    test.skip(!principal, 'Requiere el niño de CP-ONB-01');
    const familias = (await rest('child_families', { headers, query: `child_id=eq.${principal.id}&select=family_id` })).json || [];
    expect(familias, 'el niño queda asociado a una familia').toHaveLength(1);
    const familia = (await rest('families', { headers, query: `id=eq.${familias[0].family_id}&select=id` })).json || [];
    const miembros = (await rest('family_members', { headers, query: `family_id=eq.${familias[0].family_id}&select=relationship,is_primary_contact,is_financial_responsible,can_pickup` })).json || [];
    const responsables = (await rest('child_financial_responsibles', { headers, query: `child_id=eq.${principal.id}&select=id` })).json || [];
    expect(familia, 'la familia existe en el catálogo').toHaveLength(1);
    expect(miembros[0], 'el familiar queda registrado con el parentesco elegido').toMatchObject({ relationship: 'mother', is_primary_contact: true, can_pickup: true });
    expect(responsables, 'queda un responsable financiero').not.toHaveLength(0);
    informar('CP-ONB-06', `familia creada y asociada: sí; familiares: ${miembros.length} (parentesco ${miembros[0].relationship}, contacto principal sí); responsable financiero: sí`);
  });

  test('CP-ONB-07: factura de onboarding con un concepto recurrente y uno de pago único', async () => {
    const r = await registro({ cp: 'CP-ONB-07', caso: 'Registro con un servicio recurrente y un producto de pago único', completo: false, productoExtra: /Matricula Anual/ });
    expect(r.avanza).toBe(true);
    const factura = (await facturasDe(r.id))[0];
    const items = (await rest('invoice_items', { headers, query: `invoice_id=eq.${factura.id}&select=description,line_total,is_recurring,billing_frequency` })).json || [];
    const recurrentes = items.filter((x) => x.is_recurring); const unicos = items.filter((x) => !x.is_recurring);
    expect(recurrentes, 'un concepto recurrente').toHaveLength(1);
    expect(unicos, 'un concepto de pago único').toHaveLength(1);
    const suma = items.reduce((t, x) => t + Number(x.line_total), 0);
    expect(suma, 'la suma de los conceptos es el total de la factura').toBeCloseTo(Number(factura.total_amount), 2);
    informar('CP-ONB-07', `factura ${factura.invoice_number} ${factura.status}: ${recurrentes[0].description} $${Number(recurrentes[0].line_total).toFixed(2)} (recurrente) + ${unicos[0].description} $${Number(unicos[0].line_total).toFixed(2)} (pago único) = $${Number(factura.total_amount).toFixed(2)}; diferencia con la suma de conceptos $${(Number(factura.total_amount) - suma).toFixed(2)}`);
  });

  // ───────────────────────────── Ajustes de la 1702 ─────────────────────────────
  test('CP-ONB-08: el selector de fechas de medicación no admite fechas pasadas ni un fin anterior al inicio', async () => {
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
    informar('CP-ONB-08', 'ayer no seleccionable como inicio; hoy seleccionable; fin anterior al inicio no seleccionable; fin igual al inicio seleccionable');
  });

  test('CP-ONB-09: la foto admite JPEG, PNG y WebP hasta 5 MiB y rechaza el resto', async () => {
    const onb = new OnboardingPage(page);
    await onb.goto();
    const entrada = page.locator('input[type="file"]');
    const validos = [
      archivo('foto.png', 'image/png', png(1 * MB)), archivo('foto.jpg', 'image/jpeg', await desdeNavegador(page, 'image/jpeg')),
      archivo('foto.webp', 'image/webp', await desdeNavegador(page, 'image/webp')), archivo('limite.png', 'image/png', png(4.9 * MB)),
    ];
    for (const f of validos) { await entrada.setInputFiles(f); await expect(onb.errorFoto(), `${f.name} debe aceptarse`).toHaveCount(0); }
    const invalidos = [
      [archivo('anim.gif', 'image/gif', Buffer.from('GIF89a-qa')), /File type not allowed/], [archivo('doc.pdf', 'application/pdf', Buffer.from('%PDF-1.4 qa')), /File type not allowed/],
      [archivo('texto.txt', 'text/plain', Buffer.from('qa')), /File type not allowed/], [archivo('grande.png', 'image/png', png(5.1 * MB)), /File size must be less than 5 MB/],
      [archivo('enorme.png', 'image/png', png(30 * MB)), /File size must be less than 5 MB/],
    ];
    for (const [f, mensaje] of invalidos) { await entrada.setInputFiles(f); await expect(onb.errorFoto(), `${f.name} debe rechazarse`).toContainText(mensaje); }
    informar('CP-ONB-09', `aceptadas: ${validos.map((f) => f.name).join(', ')}; rechazadas: ${invalidos.map(([f]) => f.name).join(', ')}`);
  });

  test('CP-ONB-10: registro con una foto de 4,9 MiB: la foto se guarda en el servidor', async () => {
    test.fixme(!process.env.CI, 'Solo se ejecuta en CI: tras el registro el navegador automatizado pierde la renovación del token y la foto no llega a guardarse; confirmar a mano.');
    const r = await registro({ cp: 'CP-ONB-10', caso: 'Registro con foto de 4,9 MiB', completo: false, foto: 4.9 });
    expect(r.avanza).toBe(true);
    const foto = async () => ((await rest('children', { headers, query: `id=eq.${r.id}&select=profile_picture_url` })).json || [{}])[0].profile_picture_url;
    await expect.poll(foto, { timeout: 120_000, message: 'la foto de 4,9 MiB se guarda en el servidor (profile_picture_url)' }).toBeTruthy();
    informar('CP-ONB-10', 'foto de 4,9 MiB guardada en el servidor: sí');
  });

  test('CP-ONB-11: aulas sin personal o con personal sin presencia no se pueden elegir en el paso 4', async () => {
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
    const conAsignacion = await onb.opcionAula(aulaConAsignacion.nombre);
    const seleccionable = (await conAsignacion.count()) > 0 && (await conAsignacion.isEnabled());
    expect(seleccionable, 'un aula sin personal presente no debe poder elegirse').toBeFalsy();
    const oculta = (await conAsignacion.count()) === 0;
    informar('CP-ONB-11', `aula sin personal: deshabilitada con [NO STAFF]; aula con personal asignado y sin presencia: ${oculta ? 'no aparece en la lista' : 'aparece cerrada'}`);
  });

  test('CP-ONB-12: ACH queda disponible en el paso 2 cuando el colegio tiene NMI', async () => {
    const onb = new OnboardingPage(page);
    await onb.goto();
    await onb.datosNino({ ...qaChild(), nacimiento: haceAnios(4) });
    await onb.siguiente('Next: Family Member');
    await onb.familiarNuevo(qaEmail());
    await onb.metodoPago('ACH');
    await expect(page.getByText('ACH is not configured for this school')).toHaveCount(0);
    const marcos = await page.locator('iframe').evaluateAll((fs) => fs.length);
    informar('CP-ONB-12', `ACH disponible en el paso 2; formularios de pago cargados: ${marcos}`);
  });

  test('CP-ONB-13: la casilla de autorización recurrente solo se muestra con Card y ACH', async () => {
    const onb = new OnboardingPage(page);
    await onb.goto();
    await onb.datosNino({ ...qaChild(), nacimiento: haceAnios(4) });
    await onb.siguiente('Next: Family Member');
    await onb.familiarNuevo(qaEmail());
    const opciones = await onb.opcionesDeMetodoDePago();
    const casilla = page.getByText('Recurring Payment Authorization').first();
    const visibles = {};
    for (const opcion of opciones) {
      await onb.metodoPago(new RegExp(`^${opcion.replace(/[()]/g, '\\$&')}$`));
      visibles[opcion] = await casilla.isVisible();
    }
    informar('CP-ONB-13', `métodos que ofrece la lista: ${opciones.join(', ')}; casilla visible: ${Object.entries(visibles).map(([k, v]) => `${k}=${v ? 'sí' : 'no'}`).join(', ')}`);
    expect(opciones.some((o) => /^Card/.test(o)) && opciones.some((o) => /^ACH/.test(o)), 'la lista ofrece Card y ACH').toBeTruthy();
    for (const [opcion, visible] of Object.entries(visibles)) expect(visible, `casilla con ${opcion}`).toBe(/^(Card|ACH)/.test(opcion));
  });

  // LBC-1822 y LBC-1936: el paso 2 ofrece solo los métodos recurrentes (Card y ACH) y solo los que la escuela tiene habilitados
  // (school_settings.payment_method_*_enabled). El caso cambia esos ajustes un momento y los restaura al terminar.
  test('CP-ONB-19: el wizard ofrece solo los métodos de pago recurrentes que la escuela tiene habilitados', async () => {
    const filtro = `school_id=eq.${escuelaId}&deleted_at=is.null`;
    const CLAVES = ['payment_method_card_enabled', 'payment_method_ach_enabled', 'payment_method_cash_enabled', 'payment_method_check_enabled', 'payment_method_bank_transfer_enabled'];
    const fila = (await rest('school_settings', { headers, query: `${filtro}&select=${CLAVES.join(',')}` })).json[0];
    expect(fila, 'la escuela tiene su fila de school_settings').toBeTruthy();
    ajustesPago = Object.fromEntries(CLAVES.map((k) => [k, fila[k]]));
    const listar = async () => {
      const onb = new OnboardingPage(page);
      await onb.goto();
      await onb.datosNino({ ...qaChild(), nacimiento: haceAnios(4) });
      await onb.siguiente('Next: Family Member');
      await onb.familiarNuevo(qaEmail());
      return onb.opcionesDeMetodoDePago();
    };
    // Cambia los ajustes solo mientras se lista y los restaura enseguida, para que la escuela no quede modificada si algo falla después.
    const conAjustes = async (cambios) => {
      const r = await rest('school_settings', { method: 'PATCH', headers, query: filtro, body: cambios });
      expect(r.status, 'se debe poder cambiar el ajuste').toBeLessThan(300);
      try { return await listar(); } finally { await restaurarPago(); }
    };
    const texto = (l) => (l.length ? l.join(', ') : 'ninguno');
    const todos = await conAjustes({ payment_method_card_enabled: true, payment_method_ach_enabled: true, payment_method_cash_enabled: true, payment_method_check_enabled: true, payment_method_bank_transfer_enabled: true });
    const sinAch = await conAjustes({ payment_method_card_enabled: true, payment_method_ach_enabled: false });
    const sinCard = await conAjustes({ payment_method_card_enabled: false, payment_method_ach_enabled: true });
    const despues = (await rest('school_settings', { headers, query: `${filtro}&select=${CLAVES.join(',')}` })).json[0];
    const restaurado = CLAVES.every((k) => despues[k] === ajustesPago[k]);
    if (restaurado) ajustesPago = null;
    informar('CP-ONB-19', `con los cinco métodos habilitados en la escuela la lista ofrece: ${texto(todos)}; con ACH deshabilitado: ${texto(sinAch)}; con Card deshabilitado: ${texto(sinCard)}`);
    expect(restaurado, 'los ajustes de métodos de pago quedan como estaban').toBeTruthy();
    expect(todos.every((o) => /^(Card|ACH)/.test(o)) && todos.some((o) => /^Card/.test(o)) && todos.some((o) => /^ACH/.test(o)), 'habilitados todos, el wizard ofrece solo Card y ACH (LBC-1822)').toBeTruthy();
    expect(sinAch.some((o) => /^ACH/.test(o)), 'con ACH deshabilitado no se ofrece ACH').toBeFalsy();
    expect(sinAch.some((o) => /^Card/.test(o)), 'con ACH deshabilitado sigue ofreciéndose Card').toBeTruthy();
    expect(sinCard.some((o) => /^Card/.test(o)), 'con Card deshabilitado no se ofrece Card').toBeFalsy();
    expect(sinCard.some((o) => /^ACH/.test(o)), 'con Card deshabilitado sigue ofreciéndose ACH').toBeTruthy();
  });

  // Card y ACH piden datos de pago que escribe una persona en e2e/utils/datos-pago.js. Sin eso solo se comprueba que el wizard no avanza.
  for (const [num, metodo, nombre] of [['14', 'Card', 'tarjeta'], ['15', 'ACH', 'cuenta bancaria']]) {
    test(`CP-ONB-${num}: enrolamiento con ${metodo}: sin datos no avanza; con datos se completa y la factura queda según la autorización de recurrencia`, async () => {
      const cp = `CP-ONB-${num}`;
      const sin = await registro({ cp: `${cp}.1`, caso: `${metodo} sin datos de ${nombre}, recurrencia sin marcar`, metodo });
      expect(sin.avanza, `${metodo}: sin datos de pago el wizard no avanza`).toBe(false);
      const resumen = [`${metodo} sin datos: no avanza y no se crea el niño`];
      const escenarios = [
        ['.2', `${metodo} con datos válidos, recurrencia sin marcar`, 'validos', false],
        ['.3', `${metodo} con datos válidos, recurrencia marcada`, 'validos', true],
        ['.4', `${metodo} con datos inválidos`, 'invalidos', false],
      ];
      for (const [sufijo, caso, datos, recurrente] of escenarios) {
        const r = await registro({ cp: `${cp}${sufijo}`, caso, metodo, datos, recurrente });
        if (r.pendiente) { resumen.push(`${sufijo}: pendiente (${r.pendiente})`); continue; }
        if (datos === 'invalidos') { expect(r.avanza, `${metodo} con datos inválidos no avanza`).toBe(false); resumen.push(`${sufijo}: no avanza`); continue; }
        expect(r.avanza, `${metodo} con datos válidos avanza`).toBe(true);
        // Soft: un fallo de la factura no debe impedir ejecutar los escenarios que siguen (el .4 de datos inválidos).
        expect.soft(r.factura.status).toBe('pending');
        if (recurrente) expect.soft(r.factura.recurring_payment_method_id, 'con la recurrencia marcada la factura queda asociada al método de pago').toBeTruthy();
        else expect.soft(r.factura.recurring_payment_method_id, 'sin recurrencia la factura no se asocia al método').toBeNull();
        resumen.push(`${sufijo}: factura ${r.factura.status}, ${recurrente ? 'asociada' : 'sin asociar'} al método`);
      }
      informar(cp, resumen.join(' | '));
    });
  }

  test('CP-ONB-16: recuperación de la sesión: al volver al wizard se conservan los datos, el método y las casillas', async () => {
    const p2 = await page.context().newPage(); // pestaña nueva: no lleva el script que borra el borrador
    try {
      await p2.goto('/admin/children/new');
      await p2.getByRole('heading', { name: 'Add New Child' }).waitFor({ timeout: SLOW });
      const onb = new OnboardingPage(p2);
      const nino = qaChild();
      await onb.datosNino({ ...nino, nacimiento: haceAnios(4) });
      await onb.siguiente('Next: Family Member');
      await onb.familiarNuevo(qaEmail());
      await onb.metodoPago('Card');
      await p2.getByRole('checkbox', { name: /Recurring Payment Authorization/i }).first().check();
      await p2.reload();
      await p2.getByRole('heading', { name: 'Add New Child' }).waitFor({ timeout: SLOW });
      const paso = await p2.getByText(/Step \d of 4/).first().innerText().catch(() => 'sin paso');
      await p2.waitForTimeout(2000);
      // Paso 2 (donde se recupera el wizard): método y recurrencia.
      const metodo = /Card/.test(await p2.getByRole('combobox', { name: /Register a payment method/ }).innerText().catch(() => ''));
      const recurrencia = await p2.getByRole('checkbox', { name: /Recurring Payment Authorization/i }).first().isChecked().catch(() => null);
      // Paso 1: nombre y aceptación de políticas.
      await p2.getByRole('button', { name: 'Back' }).click();
      await p2.getByRole('textbox', { name: 'First Name *' }).waitFor({ timeout: 30_000 });
      const estado = {
        paso, metodo, recurrencia,
        nombre: (await p2.getByRole('textbox', { name: 'First Name *' }).inputValue().catch(() => null)) === nino.firstName,
        politicas: await p2.getByRole('checkbox', { name: /Acceptance of Policies/ }).isChecked().catch(() => null),
      };
      informar('CP-ONB-16', `tras recargar el wizard vuelve al ${estado.paso.replace('Step ', 'paso ').replace(' of 4', '')}; nombre del niño conservado: ${estado.nombre ? 'sí' : 'no'}; aceptación de políticas conservada: ${estado.politicas ? 'sí' : 'no'}; método de pago Card conservado: ${estado.metodo ? 'sí' : 'no'}; autorización de recurrencia conservada: ${estado.recurrencia ? 'sí' : 'no'}`);
      expect(estado.nombre, 'el nombre del niño se conserva').toBe(true);
      expect(estado.politicas, 'la aceptación de políticas se conserva').toBe(true);
      expect(estado.metodo, 'el método de pago se conserva').toBe(true);
      expect(estado.recurrencia, 'la autorización de recurrencia se conserva').toBe(true);
    } finally { await p2.close(); }
  });

  for (const [num, estado, valor] of [['17', 'ACTIVO', true], ['18', 'INACTIVO', false]]) {
    test(`CP-ONB-${num}: registro con el forzamiento de ratio ${estado.toLowerCase()}: se completa y un aula sin personal ni ratio sigue cerrada`, async () => {
      try {
        await forzamiento(valor);
        const r = await registro({ cp: `CP-ONB-${num}`, caso: `Registro con el forzamiento de ratio ${estado}`, completo: false, aulaCerrada: aulaSinPersonal.nombre });
        expect(r.avanza).toBe(true);
        informar(`CP-ONB-${num}`, 'ver los cinco pasos');
      } finally { await forzamiento(true); }
    });
  }
});
