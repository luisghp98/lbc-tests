const { test } = require('@playwright/test');
const { asUser, rest } = require('../../utils/rest');
const { QaCleanup, QA_PREFIX, letters } = require('../../utils/qa');
const { AulasQA } = require('../../utils/aulas');
const { AsistenciaQA } = require('../../utils/asistencia');

// Exploración de LBC-825 (forzamiento y cambio de aula): aulas QA con ratio y personal asignado, niños presentes y respuestas de las funciones.
test.describe('EXP-FORZ', () => {
  test.setTimeout(600_000);
  const limpieza = new QaCleanup(); const aulas = new AulasQA();
  let headers; let a; let original;

  test.beforeAll(async () => {
    headers = await asUser();
    await limpieza.sweep(headers); await aulas.sweep(headers);
    a = new AsistenciaQA(headers); await a.iniciar();
    original = (await rest('schools', { headers, query: `id=eq.${a.schoolId}&select=settings` })).json[0].settings;
  });
  test.afterAll(async () => {
    const h = await asUser();
    if (original) await rest('schools', { method: 'PATCH', headers: h, query: `id=eq.${a.schoolId}`, body: { settings: original } });
    await limpieza.run(h); await aulas.limpiar(h);
  });

  test('EXP-FORZ-01', async () => {
    test.fixme(!process.env.CI, 'Solo CI');
    const llamar = async (fn, body) => { const r = await rest(`rpc/${fn}`, { method: 'POST', headers, body }); return `HTTP ${r.status} ${String(r.text).slice(0, 700)}`; };
    const ratio = (await rest('staff_ratios', { headers, query: 'ratio_name=eq.Small Infants&deleted_at=is.null&select=id,max_children,required_staff_count,min_age_months,max_age_months' })).json[0];
    console.log(`[EXP] ratio Small Infants: ${JSON.stringify(ratio)}`);
    const origen = await aulas.crear(headers, { etiqueta: 'Origen', conPersonal: true, ratioId: ratio.id });
    const destino = await aulas.crear(headers, { etiqueta: 'Destino', conPersonal: true, ratioId: ratio.id });
    const cl = (await rest('classrooms', { headers, query: `id=in.(${origen.id},${destino.id})&select=classroom_name,operating_hours,assigned_ratio_id,capacity,ratio_compliance_status` })).json;
    console.log(`[EXP] aulas creadas: ${JSON.stringify(cl.map((c) => ({ ...c, classroom_name: c.classroom_name.replace(/-[a-z]{4}$/, '') })))}`);

    const nino = async (aula) => {
      const r = await rest('children', { method: 'POST', headers, body: { school_id: a.schoolId, first_name: 'QA-Child', last_name: `${QA_PREFIX}${letters()}`, birth_date: new Date(Date.now() - 400 * 86400000).toISOString().slice(0, 10), gender: 'Male', status: 'active' } });
      const id = r.json && r.json[0] && r.json[0].id;
      if (!id) throw new Error(`crear niño: ${r.status} ${String(r.text).slice(0, 200)}`);
      limpieza.trackChild(id);
      const m = await rest('classroom_enrollments', { method: 'POST', headers, body: { child_id: id, classroom_id: aula.id, enrolled_at: new Date().toISOString() } });
      if (m.status >= 300) console.log(`[EXP] matrícula en aula: HTTP ${m.status} ${String(m.text).slice(0, 200)}`);
      return id;
    };
    const hhmm = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}:00`;
    const entrar = (id, aula, min) => rest('rpc/fn_manual_check_in_child', { method: 'POST', headers, body: {
      p_child_id: id, p_classroom_id: aula.id, p_school_id: a.schoolId, p_authorized_by: a.perfil, p_entry_method: 'manual_admin', p_exception_reason: 'QA automatizado', p_tutor_doc_verified: true,
      p_entry_time: `${a.hoy}T${hhmm(min)}${a.desfase}`, p_local_date: a.hoy, p_local_time: hhmm(min) } });

    const prueba = await nino(origen);
    const r1 = await entrar(prueba, origen, 9 * 60);
    console.log(`[EXP] check-in del niño de prueba en el origen: HTTP ${r1.status} ${String(r1.text).slice(0, 200)}`);
    const attId = r1.json && r1.json.data && r1.json.data.id;

    console.log(`[EXP] validar destino vacío (activo): ${await llamar('fn_validate_child_checkin', { p_child_id: prueba, p_classroom_id: destino.id, p_school_id: a.schoolId })}`);

    let presentes = 0;
    for (let i = 0; i < ratio.max_children; i++) { const id = await nino(destino); const r = await entrar(id, destino, 9 * 60 + 5); if (r.status === 200) presentes++; }
    console.log(`[EXP] niños presentes sembrados en el destino: ${presentes} de ${ratio.max_children}`);
    console.log(`[EXP] validar destino lleno (forzamiento ACTIVO): ${await llamar('fn_validate_child_checkin', { p_child_id: prueba, p_classroom_id: destino.id, p_school_id: a.schoolId })}`);
    console.log(`[EXP] opciones de cambio (ACTIVO): ${await llamar('fn_get_child_classroom_change_options', { p_attendance_id: attId, p_local_time: '09:30:00', p_school_id: a.schoolId })}`);
    const cambio = (proceder) => llamar('fn_change_child_classroom', { p_attendance_id: attId, p_school_id: a.schoolId, p_to_classroom_id: destino.id, p_reason: 'QA automatizado', p_local_date: a.hoy, p_local_time: '09:30:00', p_proceed_with_ratio_warning: proceder });
    console.log(`[EXP] cambio al destino lleno (ACTIVO, sin confirmar): ${await cambio(false)}`);

    const apagado = await rest('schools', { method: 'PATCH', headers, query: `id=eq.${a.schoolId}`, body: { settings: { ...original, enforce_child_ratio: false } } });
    console.log(`[EXP] apagar forzamiento: HTTP ${apagado.status}`);
    console.log(`[EXP] validar destino lleno (forzamiento INACTIVO): ${await llamar('fn_validate_child_checkin', { p_child_id: prueba, p_classroom_id: destino.id, p_school_id: a.schoolId })}`);
    console.log(`[EXP] cambio al destino lleno (INACTIVO, sin confirmar): ${await cambio(false)}`);
    console.log(`[EXP] cambio al destino lleno (INACTIVO, confirmado): ${await cambio(true)}`);
    const asist = (await rest('attendance', { headers, query: `id=eq.${attId}&select=id,entry_time,exit_time,classroom_id` })).json;
    console.log(`[EXP] asistencia tras el cambio: ${JSON.stringify(asist)}; en el origen=${origen.id === (asist[0] || {}).classroom_id}, en el destino=${destino.id === (asist[0] || {}).classroom_id}`);
    console.log(`[EXP] asistencias del niño: ${((await rest('attendance', { headers, query: `child_id=eq.${prueba}&select=id` })).json || []).length}`);
    console.log(`[EXP] matrícula estructural: ${JSON.stringify(((await rest('classroom_enrollments', { headers, query: `child_id=eq.${prueba}&select=classroom_id,status` })).json || []).map((x) => ({ aula: x.classroom_id === origen.id ? 'origen' : x.classroom_id === destino.id ? 'destino' : 'otra', estado: x.status })))}`);
    console.log(`[EXP] transiciones: ${JSON.stringify((await rest('child_classroom_transitions', { headers, query: `child_id=eq.${prueba}&select=transition_type,reason,ratio_enforced,ratio_warning,from_classroom_id,to_classroom_id` })).json)}`);
    console.log(`[EXP] check-out tras el cambio: ${await llamar('fn_manual_check_out_child', { p_attendance_id: attId, p_authorized_by: a.perfil, p_exit_method: 'manual_admin', p_exception_reason: 'QA automatizado', p_tutor_doc_verified: true, p_exit_time: `${a.hoy}T15:00:00${a.desfase}`, p_local_time: '15:00:00' })}`);
    console.log(`[EXP] asistencia tras el check-out: ${JSON.stringify((await rest('attendance', { headers, query: `id=eq.${attId}&select=exit_time,classroom_id` })).json)}`);
  });
});
