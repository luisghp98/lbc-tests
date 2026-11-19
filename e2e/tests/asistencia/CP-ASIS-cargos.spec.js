const { test, expect } = require('@playwright/test');
const { loginViaUI } = require('../../utils/auth');
const { asUser, rest } = require('../../utils/rest');
const { QaCleanup } = require('../../utils/qa');
const { registrarNino } = require('../../utils/wizard');
const { AsistenciaQA } = require('../../utils/asistencia');
const { informar } = require('../../utils/informe');

// LBC-825, bloques A (late check-in), B (early check-in), C (late check-out) y D-01 (día fuera del tipo de enrolamiento).
// Un solo niño QA: antes de cada caso se borra su asistencia del día y se aplica la política del caso.
// Solo en CI (red estable). Al terminar se restaura la configuración del colegio y se retira al niño.
// Las horas se simulan con p_entry_time / p_exit_time, relativas al horario contratado de hoy.
test.describe('ASIS: cargos por asistencia (late/early check-in, late check-out)', { tag: '@asistencia' }, () => {
  test.setTimeout(600_000);
  test.describe.configure({ retries: 0 }); // cada reintento volvería a registrar al niño
  test.skip(!process.env.CI, 'Solo se ejecuta en CI');

  const limpieza = new QaCleanup();
  let page; let headers; let a; let principal;

  test.beforeAll(async ({ browser }) => {
    page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
    await loginViaUI(page);
    headers = await asUser();
    await limpieza.sweep(headers);
    a = new AsistenciaQA(headers);
    await a.iniciar();
    const { id } = await registrarNino(page, limpieza);
    principal = id;
    await a.usarNino(id);
    console.log(`[ASIS] hoy ${a.hoy} (día ${a.diaSemana}), horario de hoy: ${a.hayHorario ? `${a.inicio}-${a.fin} min` : 'sin horario'}`);
  });

  test.afterAll(async () => {
    headers = await asUser();
    a.headers = headers;
    await a.restaurar();
    await limpieza.run(headers);
    await page.context().close();
  });

  test.beforeEach(async () => { await a.limpiarDia(); });

  const conHorario = () => test.skip(!a.hayHorario, 'Hoy el niño no tiene horario contratado (se prueba de lunes a sábado)');

  /** Check-in y, si se pide, check-out; devuelve asistencia y cargos. */
  async function correr({ politica, entrada, salida }) {
    await a.politica(politica);
    const ent = await a.entrar(entrada);
    expect(ent.status, `check-in: ${ent.error}`).toBeLessThan(300);
    if (salida !== undefined) {
      const sal = await a.salir(ent.asistencia.id, salida);
      expect(sal.status, `check-out: ${sal.error}`).toBeLessThan(300);
    }
    const asistencia = (await a.asistencia())[0];
    const cargos = await a.cargos();
    // Resultado real del caso para el informe: la hora respecto al horario contratado y los cargos generados.
    const hm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
    const rel = (m, base) => `${m - base >= 0 ? '+' : ''}${m - base} min`;
    const partes = [`check-in a las ${hm(entrada)} (${rel(entrada, a.inicio)} del inicio ${hm(a.inicio)})`];
    if (salida !== undefined) partes.push(`check-out a las ${hm(salida)} (${rel(salida, a.fin)} del fin ${hm(a.fin)})`);
    partes.push(cargos.length ? `cargos: ${cargos.map((c) => `${c.source_event} $${Number(c.amount).toFixed(2)}`).join(', ')}` : 'sin cargos');
    informar(`ASIS-${test.info().title.split(':')[0]}`, partes.join('; '));
    return { asistencia, cargos };
  }
  const deTipo = (cargos, evento) => cargos.filter((c) => c.source_event === evento);

  // ---------- A. Late check-in ----------
  const FIJA = { attendance_late_check_in_flat_fee_enabled: true, attendance_late_check_in_fee_amount: 10 };
  const SIN_GRACIA = { attendance_grace_period_minutes: 0 };
  const MIN2 = { attendance_late_check_in_per_minute_enabled: true, attendance_late_check_in_per_minute_rate: 2 };

  test('A-01: a la hora exacta no hay cargo ni retraso', async () => {
    conHorario();
    const r = await correr({ politica: FIJA, entrada: a.inicio });
    expect(r.asistencia.is_late).toBe(false);
    expect(r.cargos).toEqual([]);
  });

  test('A-02: justo en el límite de la gracia (5 min) no hay cargo', async () => {
    conHorario();
    const r = await correr({ politica: FIJA, entrada: a.inicio + 5 });
    console.log(`[A-02] asistencia: ${JSON.stringify(r.asistencia)} cargos: ${r.cargos.length}`);
    expect(deTipo(r.cargos, 'late_check_in')).toEqual([]);
  });

  test('A-03: pasada la gracia con tarifa fija se cobra $10 con su desglose', async () => {
    conHorario();
    const r = await correr({ politica: FIJA, entrada: a.inicio + 6 });
    expect(r.asistencia.is_late).toBe(true);
    const c = deTipo(r.cargos, 'late_check_in');
    expect(c).toHaveLength(1);
    expect(Number(c[0].amount)).toBe(10);
    expect(c[0].fee_breakdown).toMatchObject({ total: 10, flat_fee: 10, flat_fee_enabled: true, grace_minutes: 5, minutes_late: 6, exceeded_minutes: 1 });
  });

  test('A-04: por minuto ($2) a los 10 min de retraso, sin gracia (ejemplo de LBC-1310)', async () => {
    conHorario();
    const r = await correr({ politica: { ...MIN2, ...SIN_GRACIA }, entrada: a.inicio + 10 });
    const c = deTipo(r.cargos, 'late_check_in');
    console.log(`[A-04] cargo: ${JSON.stringify(c)}`);
    expect(c).toHaveLength(1);
    expect(Number(c[0].amount), 'LBC-1310: 10 min x $2').toBe(20);
  });

  test('A-05: tarifa fija + por minuto a los 10 min de retraso, sin gracia (ejemplo de LBC-1310)', async () => {
    conHorario();
    const r = await correr({ politica: { ...FIJA, ...MIN2, ...SIN_GRACIA }, entrada: a.inicio + 10 });
    const c = deTipo(r.cargos, 'late_check_in');
    console.log(`[A-05] cargo: ${JSON.stringify(c)}`);
    expect(c).toHaveLength(1);
    expect(Number(c[0].amount), 'LBC-1310: $10 + 10 min x $2').toBe(30);
  });

  test('A-06: con la política desactivada no hay cargo aunque llegue tarde', async () => {
    conHorario();
    const r = await correr({ politica: {}, entrada: a.inicio + 30 });
    expect(r.asistencia.is_late).toBe(true);
    expect(r.cargos).toEqual([]);
  });

  test('A-07: una penalización de $0 no genera cargo (si el sistema deja configurarla)', async () => {
    const intentos = [
      ['tarifa fija $0', { attendance_late_check_in_flat_fee_enabled: true, attendance_late_check_in_fee_amount: 0 }],
      ['por minuto $0', { attendance_late_check_in_per_minute_enabled: true, attendance_late_check_in_per_minute_rate: 0 }],
    ];
    const rechazos = [];
    for (const [nombre, cfg] of intentos) {
      await a.limpiarDia();
      const conf = await a.intentarPolitica(cfg);
      if (conf.status >= 300) { console.log(`[A-07] ${nombre}: el sistema rechaza esa configuración (HTTP ${conf.status} ${String(conf.text).slice(0, 200)})`); rechazos.push(nombre); continue; }
      const ent = await a.entrar(a.inicio + 30);
      expect(ent.status, ent.error).toBeLessThan(300);
      expect(await a.cargos(), `${nombre}: no debe haber cargo`).toEqual([]);
      console.log(`[A-07] ${nombre}: configuración aceptada y sin cargo`);
    }
    informar('ASIS-A-07', `el sistema rechaza activar una tarifa en $0 (restricción de la base de datos): ${rechazos.join(' y ')}`);
  });

  test('A-08: el cargo detalla su cálculo (fee_breakdown)', async () => {
    conHorario();
    const r = await correr({ politica: { ...FIJA, ...MIN2 }, entrada: a.inicio + 10 });
    const c = deTipo(r.cargos, 'late_check_in')[0];
    expect(c, 'debe existir el cargo').toBeTruthy();
    expect(Object.keys(c.fee_breakdown)).toEqual(expect.arrayContaining(['total', 'flat_fee', 'per_minute_rate', 'per_minute_subtotal', 'grace_minutes', 'minutes_late', 'exceeded_minutes']));
    expect(c.fee_breakdown.total).toBe(Number(c.amount));
  });

  // ---------- B. Early check-in ----------
  const EARLY_FIJA = { early_drop_off_flat_fee_enabled: true, early_drop_off_fee_amount: 5 };
  const EARLY_MIN = { early_drop_off_per_minute_enabled: true, early_drop_off_per_minute_rate: 1 };
  const tempranos = (cargos) => cargos.filter((c) => !['late_check_in', 'late_check_out'].includes(c.source_event));

  test('B-01: dentro de la gracia de early (5 min) no hay cargo', async () => {
    conHorario();
    const r = await correr({ politica: EARLY_FIJA, entrada: a.inicio - 2 });
    expect(tempranos(r.cargos)).toEqual([]);
  });

  test('B-02: antes de la gracia con tarifa fija se cobra $5', async () => {
    conHorario();
    const r = await correr({ politica: EARLY_FIJA, entrada: a.inicio - 10 });
    const c = tempranos(r.cargos);
    console.log(`[B-02] cargo: ${JSON.stringify(c)}`);
    expect(c).toHaveLength(1);
    expect(Number(c[0].amount)).toBe(5);
  });

  test('B-03: por minuto ($1) a los 10 min de anticipación, sin gracia', async () => {
    conHorario();
    const r = await correr({ politica: { ...EARLY_MIN, early_check_in_grace_period_minutes: 0 }, entrada: a.inicio - 10 });
    const c = tempranos(r.cargos);
    console.log(`[B-03] cargo: ${JSON.stringify(c)}`);
    expect(c).toHaveLength(1);
    expect(Number(c[0].amount)).toBe(10);
  });

  test('B-04: con la política desactivada no hay cargo aunque llegue temprano', async () => {
    conHorario();
    const r = await correr({ politica: {}, entrada: a.inicio - 30 });
    expect(tempranos(r.cargos)).toEqual([]);
  });

  // ---------- C. Late check-out ----------
  const OUT_FIJA = { attendance_late_check_out_flat_fee_enabled: true, attendance_late_check_out_fee_amount: 10 };
  const OUT_MIN = { attendance_late_check_out_per_minute_enabled: true, attendance_late_check_out_per_minute_rate: 2 };

  test('C-01: salida dentro de la gracia (3 min) no genera cargo', async () => {
    conHorario();
    const r = await correr({ politica: OUT_FIJA, entrada: a.inicio, salida: a.fin + 3 });
    expect(deTipo(r.cargos, 'late_check_out')).toEqual([]);
  });

  test('C-02: salida 15 min tarde con tarifa fija se cobra $10', async () => {
    conHorario();
    const r = await correr({ politica: OUT_FIJA, entrada: a.inicio, salida: a.fin + 15 });
    expect(r.asistencia.is_late_checkout).toBe(true);
    const c = deTipo(r.cargos, 'late_check_out');
    expect(c).toHaveLength(1);
    expect(Number(c[0].amount)).toBe(10);
    expect(c[0].fee_breakdown).toMatchObject({ minutes_late: 15, grace_minutes: 5, exceeded_minutes: 10 });
  });

  test('C-03: salida 15 min tarde por minuto ($2), sin gracia', async () => {
    conHorario();
    const r = await correr({ politica: { ...OUT_MIN, ...SIN_GRACIA }, entrada: a.inicio, salida: a.fin + 15 });
    const c = deTipo(r.cargos, 'late_check_out');
    console.log(`[C-03] cargo: ${JSON.stringify(c)}`);
    expect(c).toHaveLength(1);
    expect(Number(c[0].amount), '15 min x $2').toBe(30);
  });

  test('C-04: salida 15 min tarde con tarifa fija + por minuto, sin gracia', async () => {
    conHorario();
    const r = await correr({ politica: { ...OUT_FIJA, ...OUT_MIN, ...SIN_GRACIA }, entrada: a.inicio, salida: a.fin + 15 });
    const c = deTipo(r.cargos, 'late_check_out');
    console.log(`[C-04] cargo: ${JSON.stringify(c)}`);
    expect(c).toHaveLength(1);
    expect(Number(c[0].amount), '$10 + 15 min x $2').toBe(40);
  });

  test('C-05: salida antes de la hora fin no genera cargo', async () => {
    conHorario();
    const r = await correr({ politica: { ...OUT_FIJA, ...OUT_MIN }, entrada: a.inicio, salida: a.fin - 5 });
    expect(r.asistencia.is_late_checkout).toBe(false);
    expect(deTipo(r.cargos, 'late_check_out')).toEqual([]);
  });

  // ---------- G. Gracia y tarifa por minuto ----------
  test('G-01: con gracia 5, la tarifa por minuto se cuenta desde que termina la gracia (duda para el PO)', async () => {
    test.info().annotations.push({ type: 'duda', description: 'LBC-1310 no aclara si los "minutos de retraso" de la tarifa por minuto incluyen la gracia. El sistema cobra solo los minutos que la exceden.' });
    const r = await correr({ politica: { ...MIN2, ...OUT_MIN }, entrada: a.inicio + 10, salida: a.fin + 15 });
    for (const [evento, tarde] of [['late_check_in', 10], ['late_check_out', 15]]) {
      const c = deTipo(r.cargos, evento);
      expect(c, evento).toHaveLength(1);
      const d = c[0].fee_breakdown;
      console.log(`[G-01] ${evento}: ${tarde} min tarde, gracia ${d.grace_minutes}, excedido ${d.exceeded_minutes}, monto ${c[0].amount}`);
      expect(d.exceeded_minutes, `${evento}: minutos excedidos = retraso - gracia`).toBe(tarde - d.grace_minutes);
      expect(Number(c[0].amount), `${evento}: monto = minutos excedidos x tarifa`).toBe(d.exceeded_minutes * 2);
    }
    informar('ASIS-G-01', `gracia 5: entrada ${r.cargos.find((x) => x.source_event === 'late_check_in').fee_breakdown.minutes_late} min tarde cobra ${r.cargos.find((x) => x.source_event === 'late_check_in').fee_breakdown.exceeded_minutes} min x $2; salida ${r.cargos.find((x) => x.source_event === 'late_check_out').fee_breakdown.minutes_late} min tarde cobra ${r.cargos.find((x) => x.source_event === 'late_check_out').fee_breakdown.exceeded_minutes} min x $2`);
  });

  // ---------- D-01. Día que no está en el tipo de enrolamiento ----------
  // Regla 1 de la HU. Se registra por el wizard un niño con un tipo de enrolamiento que no incluye el día de hoy y se intenta el check-in.
  // Según desarrollo, con matrícula vigente y horario el sistema rechaza el ingreso sin cargo.
  // Solo sirven los tipos que ofrece el wizard (el resto, como "Par Time", no aparece en el paso 4) y la cuenta de pruebas no puede modificar matrículas:
  // con los tipos actuales solo corre sábados y domingos, y de día. Creada de noche, la matrícula queda con la fecha de mañana (no vigente) y el ingreso se acepta: ese no es este caso.
  test('D-01: el check-in en un día que no está en el tipo de enrolamiento se rechaza sin cargo', async () => {
    const tipos = (await rest('enrollment_types', { headers, query: 'select=id,name&order=name' })).json || [];
    const dias = (await rest('enrollment_type_schedules', { headers, query: 'is_attending=eq.true&deleted_at=is.null&select=enrollment_type_id,day_of_week' })).json || [];
    const DEL_WIZARD = /^(Full Time|Full Time \(DropIn\)|Full Time Matricula|Solo Mañana)$/;
    const sinHoy = tipos.filter((t) => { const d = dias.filter((x) => x.enrollment_type_id === t.id).map((x) => x.day_of_week); return DEL_WIZARD.test(t.name) && d.length > 0 && !d.includes(a.diaSemana); });
    test.skip(!sinHoy.length, 'Ningún tipo de enrolamiento que ofrece el wizard excluye el día de hoy (este caso corre sábados y domingos)');
    const tipo = sinHoy[0];
    const escapar = tipo.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    try {
      const { id } = await registrarNino(page, limpieza, { tipo: new RegExp(`${escapar} —`) });
      const matricula = (await rest('enrollments', { headers, query: `child_id=eq.${id}&select=status,start_date,end_date` })).json[0] || {};
      console.log(`[D-01] tipo "${tipo.name}"; matrícula: estado ${matricula.status}, inicio ${matricula.start_date}, fin ${matricula.end_date}`);
      test.skip(matricula.status !== 'active' || String(matricula.start_date) > a.hoy, 'La matrícula del niño no está vigente hoy (creada de noche, start_date sale con la fecha de mañana)');
      await a.usarNino(id);
      expect(a.hayHorario, 'hoy el tipo de enrolamiento del niño no tiene horario').toBe(false);
      await a.limpiarDia();
      await a.politica(FIJA);
      const ent = await a.entrar(8 * 60 + 6);
      const cargos = await a.cargos();
      const rechazado = ent.status >= 300 || !(ent.asistencia && ent.asistencia.id) || (ent.respuesta && ent.respuesta.success === false);
      const dato = `tipo ${tipo.name} (días ${dias.filter((x) => x.enrollment_type_id === tipo.id).map((x) => x.day_of_week).sort().join(',')}), hoy es el día ${a.diaSemana}; matrícula vigente desde ${matricula.start_date}`;
      informar('ASIS-D-01', `${dato}; check-in a las 08:06: ${rechazado ? 'rechazado' : 'aceptado'}${ent.error ? ` (${String(ent.error).slice(0, 120)})` : ''}; cargos: ${cargos.length ? cargos.map((c) => `${c.source_event} $${Number(c.amount).toFixed(2)}`).join(', ') : 'ninguno'}`);
      expect(rechazado, 'con matrícula vigente, el check-in en un día fuera del tipo de enrolamiento se rechaza').toBe(true);
      expect(cargos, 'el check-in rechazado no genera cargos').toEqual([]);
    } finally {
      await a.usarNino(principal);
    }
  });

  // Informativo: si el sistema rechaza horas futuras, los casos de la tarde solo pueden correr a partir de esa hora.
  test('INFO: check-in con una hora posterior a la actual', async () => {
    const ahora = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
    const min = ahora.getHours() * 60 + ahora.getMinutes() + 90;
    test.skip(min >= 24 * 60, 'Demasiado cerca de la medianoche');
    await a.politica({});
    const ent = await a.entrar(min);
    console.log(`[INFO] hora futura (${Math.floor(min / 60)}:${String(min % 60).padStart(2, '0')}): HTTP ${ent.status} ${ent.error ? ent.error.slice(0, 250) : 'aceptado'}`);
  });
});
