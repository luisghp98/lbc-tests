const { test, expect } = require('@playwright/test');
const { loginViaUI } = require('../../utils/auth');
const { asUser, rest } = require('../../utils/rest');
const { QaCleanup, QA_PREFIX, letters } = require('../../utils/qa');
const { AulasQA } = require('../../utils/aulas');
const { AsistenciaQA } = require('../../utils/asistencia');
const { registrarNino } = require('../../utils/wizard');
const { informar } = require('../../utils/informe');

// LBC-825, bloques E (forzamiento activo/inactivo en el check-in), F (cambio de aula) y D-02 (la gracia usa el horario del niño).
// Aulas QA con ratio "Small Infants" (máx. 4 niños por personal) y personal asignado; 4 niños presentes en el aula destino.
// Sin personal presente el ratio no se cumple (no_staff_present): bloquea con el forzamiento activo y pide confirmación con el inactivo.
// El forzamiento (schools.settings.enforce_child_ratio) se cambia y se restaura al terminar. Solo en CI.
test.describe('ASIS: forzamiento y cambio de aula', { tag: '@asistencia' }, () => {
  test.setTimeout(600_000);
  test.describe.configure({ retries: 0 });
  test.skip(!process.env.CI, 'Solo se ejecuta en CI');

  const limpieza = new QaCleanup();
  const aulas = new AulasQA();
  let page; let headers; let a; let original; let origen; let destino; let nino; let staffAtt = null;
  const hhmm = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}:00`;
  const llamar = async (fn, body) => (await rest(`rpc/${fn}`, { method: 'POST', headers, body })).json;
  const forzamiento = async (activo) => {
    const r = await rest('schools', { method: 'PATCH', headers, query: `id=eq.${a.schoolId}`, body: { settings: { ...original, enforce_child_ratio: activo } } });
    expect(r.status, 'se debe poder cambiar el forzamiento').toBeLessThan(300);
  };
  const crearNino = async (aula) => {
    const r = await rest('children', { method: 'POST', headers, body: { school_id: a.schoolId, first_name: 'QA-Child', last_name: `${QA_PREFIX}${letters()}`, birth_date: new Date(Date.now() - 400 * 86400000).toISOString().slice(0, 10), gender: 'Male', status: 'active' } });
    const id = r.json && r.json[0] && r.json[0].id;
    expect(id, `crear niño: HTTP ${r.status}`).toBeTruthy();
    limpieza.trackChild(id);
    await rest('classroom_enrollments', { method: 'POST', headers, body: { child_id: id, classroom_id: aula.id, enrolled_at: new Date().toISOString() } });
    return id;
  };
  const entrar = (id, aula, min) => rest('rpc/fn_manual_check_in_child', { method: 'POST', headers, body: {
    p_child_id: id, p_classroom_id: aula.id, p_school_id: a.schoolId, p_authorized_by: a.perfil, p_entry_method: 'manual_admin', p_exception_reason: 'QA automatizado', p_tutor_doc_verified: true,
    p_entry_time: `${a.hoy}T${hhmm(min)}${a.desfase}`, p_local_date: a.hoy, p_local_time: hhmm(min) } });
  const cambiar = (attId, proceder) => llamar('fn_change_child_classroom', { p_attendance_id: attId, p_school_id: a.schoolId, p_to_classroom_id: destino.id, p_reason: 'QA automatizado', p_local_date: a.hoy, p_local_time: '09:30:00', p_proceed_with_ratio_warning: proceder });
  const validar = () => llamar('fn_validate_child_checkin', { p_child_id: nino, p_classroom_id: destino.id, p_school_id: a.schoolId });
  const asistenciaDe = async (id) => (await rest('attendance', { headers, query: `child_id=eq.${id}&select=id,entry_time,exit_time,classroom_id&order=created_at` })).json || [];

  /** Deja al niño de prueba con un check-in a las 09:00 en el aula origen y sin restos de casos anteriores. */
  const preparar = async () => {
    await rest('child_classroom_transitions', { method: 'DELETE', headers, query: `child_id=eq.${nino}` });
    await rest('attendance', { method: 'DELETE', headers, query: `child_id=eq.${nino}` });
    expect(await asistenciaDe(nino), 'sin asistencias previas del niño').toHaveLength(0);
    const r = await entrar(nino, origen, 9 * 60);
    expect(r.status, `check-in en el origen: ${r.text}`).toBeLessThan(300);
    return r.json.data.id;
  };

  test.beforeAll(async ({ browser }) => {
    page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
    await loginViaUI(page);
    headers = await asUser();
    await limpieza.sweep(headers); await aulas.sweep(headers);
    a = new AsistenciaQA(headers); await a.iniciar();
    original = (await rest('schools', { headers, query: `id=eq.${a.schoolId}&select=settings` })).json[0].settings;
    const ratio = (await rest('staff_ratios', { headers, query: 'ratio_name=eq.Small Infants&deleted_at=is.null&select=id,max_children' })).json[0];
    origen = await aulas.crear(headers, { etiqueta: 'Origen', conPersonal: true, ratioId: ratio.id });
    destino = await aulas.crear(headers, { etiqueta: 'Destino', conPersonal: true, ratioId: ratio.id });
    nino = await crearNino(origen);
    for (let i = 0; i < ratio.max_children; i++) expect((await entrar(await crearNino(destino), destino, 9 * 60 + 5)).status).toBeLessThan(300);
    // Niño registrado por el wizard (horario contratado) para E-03 y D-02
    const { id } = await registrarNino(page, limpieza);
    await a.usarNino(id);
  });

  test.afterAll(async () => {
    headers = await asUser(); a.headers = headers;
    if (staffAtt) {
      // No se puede cerrar (el aula tiene su registro de asistencia pendiente): se borra la fila de presencia de prueba, como hacía la suite anterior.
      const r = await rest('staff_attendance', { method: 'DELETE', headers, query: `id=eq.${staffAtt}` });
      console.log(`[ASIS] presencia del personal de prueba borrada: HTTP ${r.status}`);
    }
    await rest('schools', { method: 'PATCH', headers, query: `id=eq.${a.schoolId}`, body: { settings: original } });
    await a.restaurar();
    await limpieza.run(headers); await aulas.limpiar(headers);
    await page.context().close();
  });

  // ---------- E. Forzamiento activo / inactivo en el check-in ----------
  test('E-01: con el forzamiento activo y el ratio incumplido el check-in se bloquea', async () => {
    await forzamiento(true);
    const v = await validar();
    informar('ASIS-E-01', `forzamiento activo=${v.enforce_active}; acción=${v.validation_action}; permitido=${v.allowed}; razón=${v.reason}`);
    expect(v.enforce_active).toBe(true);
    expect(v.allowed).toBe(false);
    expect(v.validation_action).toBe('block');
    expect(['no_staff_present', 'ratio_exceeded']).toContain(v.reason);
  });

  test('E-02: con el forzamiento inactivo y el ratio incumplido se pide confirmación', async () => {
    await forzamiento(false);
    const v = await validar();
    informar('ASIS-E-02', `forzamiento activo=${v.enforce_active}; acción=${v.validation_action}; requiere confirmación=${v.requires_confirmation}; razón=${v.reason}`);
    expect(v.enforce_active).toBe(false);
    expect(v.validation_action).toBe('confirm');
    expect(v.requires_confirmation).toBe(true);
  });

  test('E-03: el cargo por tardanza es el mismo con el forzamiento activo e inactivo', async () => {
    const montos = {};
    for (const [estado, valor] of [['activo', true], ['inactivo', false]]) {
      await forzamiento(valor);
      await a.limpiarDia();
      await a.politica({ attendance_late_check_in_flat_fee_enabled: true, attendance_late_check_in_fee_amount: 10 });
      const ent = await a.entrar(a.inicio + 6);
      expect(ent.status, ent.error).toBeLessThan(300);
      const c = (await a.cargos()).filter((x) => x.source_event === 'late_check_in');
      expect(c, `forzamiento ${estado}: se genera un cargo`).toHaveLength(1);
      montos[estado] = Number(c[0].amount);
    }
    informar('ASIS-E-03', `cargo con forzamiento activo=$${montos.activo}; inactivo=$${montos.inactivo}`);
    expect(montos.activo).toBe(10);
    expect(montos.inactivo).toBe(montos.activo);
  });

  // ---------- F. Cambio de aula ----------
  // Los casos F-01 a F-04 usan el forzamiento inactivo y la confirmación: sin personal presente el destino incumple el ratio.
  test('F-01..F-04: el cambio de aula no crea otro check-in, conserva la hora, la asignación estructural y el check-out va al aula nueva', async () => {
    await forzamiento(false);
    const attId = await preparar();
    const antes = (await asistenciaDe(nino))[0];
    const cambio = await cambiar(attId, true);
    expect(cambio.success, `cambio de aula: ${JSON.stringify(cambio).slice(0, 300)}`).not.toBe(false);
    const despues = await asistenciaDe(nino);
    expect(despues, 'F-01: sigue habiendo una sola asistencia del día').toHaveLength(1);
    expect(despues[0].entry_time, 'F-02: la hora original de check-in no cambia').toBe(antes.entry_time);
    expect(despues[0].classroom_id, 'la asistencia pasa al aula nueva').toBe(destino.id);
    const matr = (await rest('classroom_enrollments', { headers, query: `child_id=eq.${nino}&select=classroom_id,status` })).json;
    expect(matr, 'F-03: la asignación estructural no se modifica').toEqual([{ classroom_id: origen.id, status: 'active' }]);
    const tr = (await rest('child_classroom_transitions', { headers, query: `child_id=eq.${nino}&select=transition_type,from_classroom_id,to_classroom_id,ratio_enforced,ratio_warning` })).json;
    expect(tr, 'queda la trazabilidad del cambio').toEqual([{ transition_type: 'classroom_change', from_classroom_id: origen.id, to_classroom_id: destino.id, ratio_enforced: false, ratio_warning: true }]);
    const sal = await rest('rpc/fn_manual_check_out_child', { method: 'POST', headers, body: { p_attendance_id: attId, p_authorized_by: a.perfil, p_exit_method: 'manual_admin', p_exception_reason: 'QA automatizado', p_tutor_doc_verified: true, p_exit_time: `${a.hoy}T${hhmm(15 * 60)}${a.desfase}`, p_local_time: hhmm(15 * 60) } });
    expect(sal.status, `check-out: ${sal.text}`).toBeLessThan(300);
    const fin = (await asistenciaDe(nino))[0];
    informar('ASIS-F-01..F-04', `una sola asistencia: sí; hora de entrada conservada: sí; asignación estructural en el origen: sí; check-out en el aula nueva: ${fin.classroom_id === destino.id ? 'sí' : 'no'}; transición registrada: sí`);
    expect(fin.exit_time, 'F-04: el check-out queda registrado').toBeTruthy();
    expect(fin.classroom_id, 'F-04: el check-out se registra en el aula nueva').toBe(destino.id);
  });

  test('F-05: con el forzamiento activo y el ratio incumplido el cambio se bloquea y nada cambia', async () => {
    await forzamiento(true);
    const attId = await preparar();
    const cambio = await cambiar(attId, false);
    informar('ASIS-F-05', `respuesta=${cambio.error}; éxito=${cambio.success}`);
    expect(cambio.success).toBe(false);
    expect(cambio.error).toBe('ratio_exceeded');
    expect((await asistenciaDe(nino))[0].classroom_id, 'la asistencia sigue en el origen').toBe(origen.id);
    expect((await rest('child_classroom_transitions', { headers, query: `child_id=eq.${nino}&select=id` })).json, 'no se registra transición').toHaveLength(0);
    // con confirmar no se salta el bloqueo
    const forzado = await cambiar(attId, true);
    expect(forzado.success, 'confirmar no basta con el forzamiento activo').toBe(false);
  });

  test('F-06: con el forzamiento inactivo y el ratio incumplido el cambio pide confirmación y, confirmado, se completa', async () => {
    await forzamiento(false);
    const attId = await preparar();
    const sin = await cambiar(attId, false);
    expect(sin.success).toBe(false);
    expect(sin.error).toBe('ratio_confirmation_required');
    expect((await asistenciaDe(nino))[0].classroom_id, 'sin confirmar la asistencia sigue en el origen').toBe(origen.id);
    const con = await cambiar(attId, true);
    expect(con.success, JSON.stringify(con).slice(0, 300)).not.toBe(false);
    expect((await asistenciaDe(nino))[0].classroom_id, 'confirmado, la asistencia pasa al destino').toBe(destino.id);
    informar('ASIS-F-06', `sin confirmar: ${sin.error}; confirmado: cambio completado`);
  });

  // ---------- Exceso real de ratio con personal presente (solo dentro del horario escolar) ----------
  test('E-04: con personal presente y más niños que el máximo el ratio se excede (activo bloquea, inactivo confirma)', async () => {
    const ahoraNY = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
    const min = ahoraNY.getHours() * 60 + ahoraNY.getMinutes();
    test.skip(min < 7 * 60 + 5 || min > 17 * 60 + 55, 'La presencia del personal solo se puede marcar de 07:00 a 18:00 (hora del colegio)');
    const staffId = (await rest('staff', { headers, query: 'employment_status=eq.active&deleted_at=is.null&limit=1&select=id' })).json[0].id;
    const ci = await rest('rpc/fn_manual_check_in_staff', { method: 'POST', headers, body: { p_staff_id: staffId, p_school_id: a.schoolId, p_classroom_id: destino.id, p_local_date: a.hoy, p_local_time: hhmm(min) } });
    expect(ci.status, `presencia del personal: ${ci.text}`).toBeLessThan(300);
    staffAtt = ci.json && ci.json.data && ci.json.data.id;
    await forzamiento(true);
    const activo = await validar();
    await forzamiento(false);
    const inactivo = await validar();
    informar('ASIS-E-04', `personal presente=${activo.staff_present}; niños=${activo.current_children}/${activo.max_children}; activo: ${activo.validation_action} (${activo.reason}); inactivo: ${inactivo.validation_action}`);
    expect(activo.staff_present).toBeGreaterThanOrEqual(1);
    expect(activo.reason).toBe('ratio_exceeded');
    expect(activo.validation_action).toBe('block');
    expect(inactivo.validation_action).toBe('confirm');
  });

  // ---------- D-02. La gracia se aplica sobre el horario contratado del niño, no sobre el del aula ----------
  test('D-02: la tardanza se cuenta desde el horario del niño aunque el aula abra más tarde', async () => {
    // Aula de prueba que abre una hora después del horario del niño: si la tardanza se midiera con el horario del aula, el check-in no sería tardío.
    const abre = a.inicio + 60;
    const h24 = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
    const horario = Object.fromEntries(['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'].map((d) => [d, { open: h24(abre), close: '18:00' }]));
    const cambio = await rest('classrooms', { method: 'PATCH', headers, query: `id=eq.${origen.id}`, body: { operating_hours: horario } });
    expect(cambio.status, 'se debe poder fijar el horario operativo del aula de prueba').toBeLessThan(300);
    await forzamiento(true);
    await a.limpiarDia();
    await a.politica({ attendance_late_check_in_flat_fee_enabled: true, attendance_late_check_in_fee_amount: 10 });
    const ent = await a.entrar(a.inicio + 6, origen.id);
    expect(ent.status, `check-in en el aula de prueba: ${ent.error}`).toBeLessThan(300);
    const c = (await a.cargos()).filter((x) => x.source_event === 'late_check_in');
    informar('ASIS-D-02', `el niño empieza a las ${h24(a.inicio)} y el aula abre a las ${h24(abre)}; check-in a las ${h24(a.inicio + 6)}: ${c.length ? `cargo de $${c[0].amount}` : 'sin cargo'}`);
    expect(c, 'con la gracia sobre el horario del niño, 6 min tarde genera cargo').toHaveLength(1);
    expect(Number(c[0].amount)).toBe(10);
  });
});
