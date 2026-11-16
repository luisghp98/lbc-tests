const { test, expect } = require('@playwright/test');
const { loginViaUI } = require('../../utils/auth');
const { asUser } = require('../../utils/rest');
const { QaCleanup } = require('../../utils/qa');
const { registrarNino } = require('../../utils/wizard');
const { AsistenciaQA, TIPO_QA } = require('../../utils/asistencia');

// LBC-825, bloques A (late check-in), B (early check-in), C (late check-out) y D-01 (día sin horario).
// Un solo niño QA: antes de cada caso se borra su asistencia del día y se aplica la política del caso.
// Solo en CI (red estable). Al terminar se restaura la configuración del colegio y se retira al niño.
// Las horas se simulan con p_entry_time / p_exit_time, relativas al horario contratado de hoy.
test.describe('ASIS: cargos por asistencia (late/early check-in, late check-out)', { tag: '@asistencia' }, () => {
  test.setTimeout(600_000);
  test.skip(!process.env.CI, 'Solo se ejecuta en CI');

  const limpieza = new QaCleanup();
  let page; let headers; let a;

  test.beforeAll(async ({ browser }) => {
    page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
    await loginViaUI(page);
    headers = await asUser();
    await limpieza.sweep(headers);
    a = new AsistenciaQA(headers);
    await a.iniciar();
    await a.quitarTipos();
    await a.crearTipo();
    const { id } = await registrarNino(page, limpieza, { tipo: new RegExp(TIPO_QA) });
    await a.usarNino(id);
    expect(a.hayHorario, 'el tipo QA tiene horario todos los días').toBe(true);
    console.log(`[ASIS] hoy ${a.hoy} (día ${a.diaSemana}), horario de hoy: ${a.hayHorario ? `${a.inicio}-${a.fin} min` : 'sin horario'}`);
  });

  test.afterAll(async () => {
    headers = await asUser();
    a.headers = headers;
    await a.restaurar();
    await limpieza.run(headers);
    await a.quitarTipos();
    await page.context().close();
  });

  test.beforeEach(async () => { await a.limpiarDia(); });

  /** Check-in y, si se pide, check-out; devuelve asistencia y cargos. */
  async function correr({ politica, entrada, salida }) {
    await a.politica(politica);
    const ent = await a.entrar(entrada);
    expect(ent.status, `check-in: ${ent.error}`).toBeLessThan(300);
    if (salida !== undefined) {
      const sal = await a.salir(ent.asistencia.id, salida);
      expect(sal.status, `check-out: ${sal.error}`).toBeLessThan(300);
    }
    return { asistencia: (await a.asistencia())[0], cargos: await a.cargos() };
  }
  const deTipo = (cargos, evento) => cargos.filter((c) => c.source_event === evento);

  // ---------- A. Late check-in ----------
  const FIJA = { attendance_late_check_in_flat_fee_enabled: true, attendance_late_check_in_fee_amount: 10 };
  const MIN2 = { attendance_late_check_in_per_minute_enabled: true, attendance_late_check_in_per_minute_rate: 2 };

  test('A-01: a la hora exacta no hay cargo ni retraso', async () => {
    const r = await correr({ politica: FIJA, entrada: a.inicio });
    expect(r.asistencia.is_late).toBe(false);
    expect(r.cargos).toEqual([]);
  });

  test('A-02: justo en el límite de la gracia (5 min) no hay cargo', async () => {
    const r = await correr({ politica: FIJA, entrada: a.inicio + 5 });
    console.log(`[A-02] asistencia: ${JSON.stringify(r.asistencia)} cargos: ${r.cargos.length}`);
    expect(deTipo(r.cargos, 'late_check_in')).toEqual([]);
  });

  test('A-03: pasada la gracia con tarifa fija se cobra $10 con su desglose', async () => {
    const r = await correr({ politica: FIJA, entrada: a.inicio + 6 });
    expect(r.asistencia.is_late).toBe(true);
    const c = deTipo(r.cargos, 'late_check_in');
    expect(c).toHaveLength(1);
    expect(Number(c[0].amount)).toBe(10);
    expect(c[0].fee_breakdown).toMatchObject({ total: 10, flat_fee: 10, flat_fee_enabled: true, grace_minutes: 5, minutes_late: 6, exceeded_minutes: 1 });
  });

  test('A-04: por minuto ($2) a los 10 min de retraso', async () => {
    const r = await correr({ politica: MIN2, entrada: a.inicio + 10 });
    const c = deTipo(r.cargos, 'late_check_in');
    console.log(`[A-04] cargo: ${JSON.stringify(c)}`);
    expect(c).toHaveLength(1);
    expect(Number(c[0].amount), 'LBC-1310: 10 min x $2').toBe(20);
  });

  test('A-05: tarifa fija + por minuto a los 10 min de retraso', async () => {
    const r = await correr({ politica: { ...FIJA, ...MIN2 }, entrada: a.inicio + 10 });
    const c = deTipo(r.cargos, 'late_check_in');
    console.log(`[A-05] cargo: ${JSON.stringify(c)}`);
    expect(c).toHaveLength(1);
    expect(Number(c[0].amount), 'LBC-1310: $10 + 10 min x $2').toBe(30);
  });

  test('A-06: con la política desactivada no hay cargo aunque llegue tarde', async () => {
    const r = await correr({ politica: {}, entrada: a.inicio + 30 });
    expect(r.asistencia.is_late).toBe(true);
    expect(r.cargos).toEqual([]);
  });

  test('A-07: tarifa fija en $0 no genera cargo', async () => {
    const r = await correr({ politica: { attendance_late_check_in_flat_fee_enabled: true, attendance_late_check_in_fee_amount: 0 }, entrada: a.inicio + 30 });
    expect(r.cargos).toEqual([]);
  });

  test('A-08: el cargo detalla su cálculo (fee_breakdown)', async () => {
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
    const r = await correr({ politica: EARLY_FIJA, entrada: a.inicio - 2 });
    expect(tempranos(r.cargos)).toEqual([]);
  });

  test('B-02: antes de la gracia con tarifa fija se cobra $5', async () => {
    const r = await correr({ politica: EARLY_FIJA, entrada: a.inicio - 10 });
    const c = tempranos(r.cargos);
    console.log(`[B-02] cargo: ${JSON.stringify(c)}`);
    expect(c).toHaveLength(1);
    expect(Number(c[0].amount)).toBe(5);
  });

  test('B-03: antes de la gracia por minuto ($1) a los 10 min de anticipación', async () => {
    const r = await correr({ politica: EARLY_MIN, entrada: a.inicio - 10 });
    const c = tempranos(r.cargos);
    console.log(`[B-03] cargo: ${JSON.stringify(c)}`);
    expect(c).toHaveLength(1);
    expect(Number(c[0].amount)).toBe(10);
  });

  test('B-04: con la política desactivada no hay cargo aunque llegue temprano', async () => {
    const r = await correr({ politica: {}, entrada: a.inicio - 30 });
    expect(tempranos(r.cargos)).toEqual([]);
  });

  // ---------- C. Late check-out ----------
  const OUT_FIJA = { attendance_late_check_out_flat_fee_enabled: true, attendance_late_check_out_fee_amount: 10 };
  const OUT_MIN = { attendance_late_check_out_per_minute_enabled: true, attendance_late_check_out_per_minute_rate: 2 };

  test('C-01: salida dentro de la gracia (3 min) no genera cargo', async () => {
    const r = await correr({ politica: OUT_FIJA, entrada: a.inicio, salida: a.fin + 3 });
    expect(deTipo(r.cargos, 'late_check_out')).toEqual([]);
  });

  test('C-02: salida 15 min tarde con tarifa fija se cobra $10', async () => {
    const r = await correr({ politica: OUT_FIJA, entrada: a.inicio, salida: a.fin + 15 });
    expect(r.asistencia.is_late_checkout).toBe(true);
    const c = deTipo(r.cargos, 'late_check_out');
    expect(c).toHaveLength(1);
    expect(Number(c[0].amount)).toBe(10);
    expect(c[0].fee_breakdown).toMatchObject({ minutes_late: 15, grace_minutes: 5, exceeded_minutes: 10 });
  });

  test('C-03: salida 15 min tarde por minuto ($2)', async () => {
    const r = await correr({ politica: OUT_MIN, entrada: a.inicio, salida: a.fin + 15 });
    const c = deTipo(r.cargos, 'late_check_out');
    console.log(`[C-03] cargo: ${JSON.stringify(c)}`);
    expect(c).toHaveLength(1);
    expect(Number(c[0].amount), '15 min x $2').toBe(30);
  });

  test('C-04: salida 15 min tarde con tarifa fija + por minuto', async () => {
    const r = await correr({ politica: { ...OUT_FIJA, ...OUT_MIN }, entrada: a.inicio, salida: a.fin + 15 });
    const c = deTipo(r.cargos, 'late_check_out');
    console.log(`[C-04] cargo: ${JSON.stringify(c)}`);
    expect(c).toHaveLength(1);
    expect(Number(c[0].amount), '$10 + 15 min x $2').toBe(40);
  });

  test('C-05: salida antes de la hora fin no genera cargo', async () => {
    const r = await correr({ politica: { ...OUT_FIJA, ...OUT_MIN }, entrada: a.inicio, salida: a.fin - 5 });
    expect(r.asistencia.is_late_checkout).toBe(false);
    expect(deTipo(r.cargos, 'late_check_out')).toEqual([]);
  });

  // ---------- D-01. Día sin horario contratado: se quita el horario de hoy del tipo QA durante el caso ----------
  test('D-01: check-in en un día sin horario contratado (informativo)', async () => {
    test.info().annotations.push({ type: 'duda', description: 'Qué debe pasar con un check-in en un día no incluido en el tipo de enrolamiento (bloquear, permitir sin cargo o cobrar)' });
    await a.horarioDeHoy(false);
    try {
      const r = await correr({ politica: FIJA, entrada: 8 * 60 + 6 });
      console.log(`[D-01] sin horario: asistencia=${JSON.stringify(r.asistencia)} cargos=${JSON.stringify(r.cargos.map((c) => ({ evento: c.source_event, monto: c.amount, minutos: c.fee_breakdown && c.fee_breakdown.minutes_late })))}`);
    } finally {
      await a.horarioDeHoy(true);
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
