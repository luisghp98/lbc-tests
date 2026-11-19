const { test } = require('@playwright/test');
const { asUser, rest } = require('../../utils/rest');
const { QaCleanup, QA_PREFIX, letters } = require('../../utils/qa');
const { AulasQA } = require('../../utils/aulas');
const { AsistenciaQA } = require('../../utils/asistencia');

// Exploración 2 de LBC-825: presencia de personal (fn_manual_check_in_staff) para provocar un exceso real de ratio. Se cierra al terminar.
test.describe('EXP-FORZ2', () => {
  test.setTimeout(600_000);
  const limpieza = new QaCleanup(); const aulas = new AulasQA();
  let headers; let a; let original; let staffAtt = null;

  test.beforeAll(async () => {
    headers = await asUser();
    await limpieza.sweep(headers); await aulas.sweep(headers);
    a = new AsistenciaQA(headers); await a.iniciar();
    original = (await rest('schools', { headers, query: `id=eq.${a.schoolId}&select=settings` })).json[0].settings;
  });
  test.afterAll(async () => {
    const h = await asUser();
    if (staffAtt) {
      const r = await rest('staff_attendance', { method: 'PATCH', headers: h, query: `id=eq.${staffAtt}`, body: { exit_time: new Date().toISOString() } });
      console.log(`[EXP] cierre de la presencia del personal: HTTP ${r.status} ${r.status >= 300 ? String(r.text).slice(0, 200) : ''}`);
    }
    if (original) await rest('schools', { method: 'PATCH', headers: h, query: `id=eq.${a.schoolId}`, body: { settings: original } });
    await limpieza.run(h); await aulas.limpiar(h);
  });

  test('EXP-FORZ2-01', async () => {
    test.fixme(!process.env.CI, 'Solo CI');
    const llamar = async (fn, body) => { const r = await rest(`rpc/${fn}`, { method: 'POST', headers, body }); return { r, txt: `HTTP ${r.status} ${String(r.text).slice(0, 520)}` }; };
    const ratio = (await rest('staff_ratios', { headers, query: 'ratio_name=eq.Small Infants&deleted_at=is.null&select=id,max_children' })).json[0];
    const destino = await aulas.crear(headers, { etiqueta: 'Destino', conPersonal: true, ratioId: ratio.id });
    const origen = await aulas.crear(headers, { etiqueta: 'Origen', conPersonal: true, ratioId: ratio.id });
    const hhmm = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}:00`;
    const nino = async (aula) => {
      const r = await rest('children', { method: 'POST', headers, body: { school_id: a.schoolId, first_name: 'QA-Child', last_name: `${QA_PREFIX}${letters()}`, birth_date: new Date(Date.now() - 400 * 86400000).toISOString().slice(0, 10), gender: 'Male', status: 'active' } });
      const id = r.json[0].id; limpieza.trackChild(id);
      await rest('classroom_enrollments', { method: 'POST', headers, body: { child_id: id, classroom_id: aula.id, enrolled_at: new Date().toISOString() } });
      return id;
    };
    const entrar = (id, aula, min) => rest('rpc/fn_manual_check_in_child', { method: 'POST', headers, body: {
      p_child_id: id, p_classroom_id: aula.id, p_school_id: a.schoolId, p_authorized_by: a.perfil, p_entry_method: 'manual_admin', p_exception_reason: 'QA automatizado', p_tutor_doc_verified: true,
      p_entry_time: `${a.hoy}T${hhmm(min)}${a.desfase}`, p_local_date: a.hoy, p_local_time: hhmm(min) } });

    const prueba = await nino(origen);
    const att = (await entrar(prueba, origen, 9 * 60)).json.data.id;
    for (let i = 0; i < 3; i++) await entrar(await nino(destino), destino, 9 * 60 + 5);

    const staffId = (await rest('staff', { headers, query: 'employment_status=eq.active&deleted_at=is.null&limit=1&select=id' })).json[0].id;
    const abiertas = (await rest('staff_attendance', { headers, query: `staff_id=eq.${staffId}&exit_time=is.null&select=id,classroom_id` })).json || [];
    console.log(`[EXP] filas abiertas previas del personal: ${abiertas.length}`);
    const ci = await llamar('fn_manual_check_in_staff', { p_staff_id: staffId, p_school_id: a.schoolId, p_classroom_id: destino.id, p_local_date: a.hoy, p_local_time: hhmm(9 * 60) });
    console.log(`[EXP] presencia del personal en el destino: ${ci.txt}`);
    staffAtt = ci.r.json && ci.r.json.data && ci.r.json.data.id;
    const validar = async (t) => console.log(`[EXP] validar (${t}): ${(await llamar('fn_validate_child_checkin', { p_child_id: prueba, p_classroom_id: destino.id, p_school_id: a.schoolId })).txt}`);
    await validar('3 niños + personal presente, ACTIVO');
    await entrar(await nino(destino), destino, 9 * 60 + 6);
    await validar('4 niños + personal presente, ACTIVO');
    const cambio = async (t, proceder) => console.log(`[EXP] cambio (${t}): ${(await llamar('fn_change_child_classroom', { p_attendance_id: att, p_school_id: a.schoolId, p_to_classroom_id: destino.id, p_reason: 'QA automatizado', p_local_date: a.hoy, p_local_time: '09:30:00', p_proceed_with_ratio_warning: proceder })).txt}`);
    await cambio('exceso real, ACTIVO', false);
    await rest('schools', { method: 'PATCH', headers, query: `id=eq.${a.schoolId}`, body: { settings: { ...original, enforce_child_ratio: false } } });
    await validar('4 niños + personal presente, INACTIVO');
    await cambio('exceso real, INACTIVO sin confirmar', false);
    await cambio('exceso real, INACTIVO confirmado', true);
    console.log(`[EXP] aula de la asistencia tras el cambio: ${((await rest('attendance', { headers, query: `id=eq.${att}&select=classroom_id` })).json[0] || {}).classroom_id === destino.id ? 'destino' : 'otra'}`);
    console.log(`[EXP] presencia del personal registrada en: ${JSON.stringify((await rest('staff_attendance', { headers, query: `id=eq.${staffAtt}&select=classroom_id,exit_time` })).json)}`);
  });
});
