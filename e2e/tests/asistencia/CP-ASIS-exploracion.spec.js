const { test, expect } = require('@playwright/test');
const { loginViaUI } = require('../../utils/auth');
const { asUser, rest, request } = require('../../utils/rest');
const { QaCleanup } = require('../../utils/qa');
const { registrarNino } = require('../../utils/wizard');

// Exploración de LBC-825: cómo calcula el sistema el retraso y los cargos. Solo en CI (red estable). Restaura la configuración al terminar.
test.describe('ASIS: exploración de check-in tardío', { tag: '@asistencia' }, () => {
  test.setTimeout(600_000);
  const limpieza = new QaCleanup();
  let page; let headers; let schoolId; let original;
  const CLAVES = ['attendance_grace_period_minutes', 'attendance_late_fee_amount', 'early_check_in_grace_period_minutes',
    'attendance_late_check_in_fee_amount', 'attendance_late_check_in_flat_fee_enabled', 'attendance_late_check_in_per_minute_enabled', 'attendance_late_check_in_per_minute_rate',
    'attendance_late_check_out_fee_amount', 'attendance_late_check_out_flat_fee_enabled', 'attendance_late_check_out_per_minute_enabled', 'attendance_late_check_out_per_minute_rate',
    'early_drop_off_fee_amount', 'early_drop_off_flat_fee_enabled', 'early_drop_off_per_minute_enabled', 'early_drop_off_per_minute_rate'];

  test.beforeAll(async ({ browser }) => {
    page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
    await loginViaUI(page);
    headers = await asUser();
    await limpieza.sweep(headers);
    schoolId = (await rest('staff', { headers, query: 'limit=1&select=school_id' })).json[0].school_id;
    original = (await rest('school_settings', { headers, query: `school_id=eq.${schoolId}&deleted_at=is.null&select=${CLAVES.join(',')}` })).json[0];
    console.log(`[ASIS] configuración original: ${JSON.stringify(original)}`);
  });

  test.afterAll(async () => {
    headers = await asUser();
    const r = await rest('school_settings', { method: 'PATCH', headers, query: `school_id=eq.${schoolId}&deleted_at=is.null`, body: original });
    console.log(`[ASIS] configuración restaurada: HTTP ${r.status}`);
    await limpieza.run(headers);
    await page.context().close();
  });

  test('ASIS-EXP-01: late check-in con tarifa fija de 10 USD', async () => {
    test.fixme(!process.env.CI, 'Solo se ejecuta en CI');
    const { id } = await registrarNino(page, limpieza);
    const mat = (await rest('enrollments', { headers, query: `child_id=eq.${id}&select=enrollment_type_id` })).json[0];
    const horarios = (await rest('enrollment_type_schedules', { headers, query: `enrollment_type_id=eq.${mat.enrollment_type_id}&deleted_at=is.null&is_attending=eq.true&select=day_of_week,start_time,end_time&order=day_of_week` })).json || [];
    console.log(`[ASIS] horario contratado: ${JSON.stringify(horarios)}`);
    // El RPC solo acepta la fecha local de hoy (zona del colegio): el horario que cuenta es el de hoy.
    const ymd = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    const dow = new Date(`${ymd}T12:00:00Z`).getUTCDay();
    // Desfase de Nueva York ese día (cambia con el horario de verano)
    const gmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', timeZoneName: 'shortOffset' }).formatToParts(new Date(`${ymd}T12:00:00Z`)).find((x) => x.type === 'timeZoneName').value.match(/GMT([+-])(\d+)/);
    const desfase = `${gmt[1]}${gmt[2].padStart(2, '0')}:00`;
    const hoy = horarios.find((h) => h.day_of_week === dow);
    console.log(`[ASIS] hoy (NY) ${ymd}, día ${dow}, horario de hoy: ${JSON.stringify(hoy || 'sin horario')}`);
    const dia = hoy || horarios[0];
    const [hh, mm] = dia.start_time.split(':').map(Number);
    const hora = (min) => { const t = hh * 60 + mm + min; return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}:00`; };

    await rest('school_settings', { method: 'PATCH', headers, query: `school_id=eq.${schoolId}&deleted_at=is.null`, body: {
      attendance_grace_period_minutes: 5, attendance_late_check_in_flat_fee_enabled: true, attendance_late_check_in_fee_amount: 10,
      attendance_late_check_in_per_minute_enabled: false, attendance_late_check_in_per_minute_rate: 0,
      attendance_late_check_out_flat_fee_enabled: true, attendance_late_check_out_fee_amount: 10,
    } });

    const aula = (await rest('classroom_enrollments', { headers, query: `child_id=eq.${id}&select=classroom_id` })).json[0].classroom_id;
    const yo = (await request('/auth/v1/user', { headers })).json;
    const perfil = (await rest('profiles', { headers, query: `user_id=eq.${yo.id}&select=id` })).json[0].id;
    const entrada = await rest('rpc/fn_manual_check_in_child', { method: 'POST', headers, body: {
      p_child_id: id, p_classroom_id: aula, p_school_id: schoolId, p_authorized_by: perfil, p_entry_method: 'manual_admin',
      p_exception_reason: 'QA automatizado', p_tutor_doc_verified: true, p_entry_time: `${ymd}T${hora(6)}${desfase}`, p_local_date: ymd, p_local_time: hora(6),
    } });
    console.log(`[ASIS] check-in ${ymd} ${hora(6)} (inicio ${dia.start_time}): HTTP ${entrada.status} ${String(entrada.text).slice(0, 400)}`);
    const asistencia = (await rest('attendance', { headers, query: `child_id=eq.${id}&select=id,attendance_date,entry_time,exit_time,status,minutes_late,is_late,entry_method` })).json;
    console.log(`[ASIS] asistencia tras check-in: ${JSON.stringify(asistencia)}`);

    if (asistencia && asistencia[0]) {
      const [h2, m2] = dia.end_time.split(':').map(Number);
      const tarde = `${String(h2).padStart(2, '0')}:${String(m2 + 15).padStart(2, '0')}:00`;
      const salida = await rest('rpc/fn_manual_check_out_child', { method: 'POST', headers, body: {
        p_attendance_id: asistencia[0].id, p_authorized_by: perfil, p_exit_method: 'manual_admin', p_exception_reason: 'QA automatizado',
        p_tutor_doc_verified: true, p_exit_time: `${ymd}T${tarde}${desfase}`, p_local_time: tarde,
      } });
      console.log(`[ASIS] check-out ${tarde} (fin ${dia.end_time}): HTTP ${salida.status} ${String(salida.text).slice(0, 400)}`);
      const tras = (await rest('attendance', { headers, query: `child_id=eq.${id}&select=exit_time,minutes_late_checkout,is_late_checkout` })).json;
      console.log(`[ASIS] asistencia tras check-out: ${JSON.stringify(tras)}`);
    }
    await expect.poll(async () => ((await rest('charges', { headers, query: `child_id=eq.${id}&select=id` })).json || []).length, { timeout: 30_000 }).toBeGreaterThanOrEqual(0);
    const cargos = (await rest('charges', { headers, query: `child_id=eq.${id}&select=charge_type,amount,status,source_event,fee_breakdown,description` })).json;
    console.log(`[ASIS] cargos: ${JSON.stringify(cargos)}`);
  });
});

// Lee el esquema de la API: dónde vive el enforzamiento y qué parámetros tienen las funciones de cambio de aula.
test('ASIS-EXP-02: esquema de enforzamiento y cambio de aula', { tag: '@asistencia' }, async () => {
  const headers = await asUser();
  const spec = (await request('/rest/v1/', { headers })).json || {};
  const defs = spec.definitions || {};
  const cols = [];
  for (const [t, d] of Object.entries(defs)) for (const k of Object.keys(d.properties || {})) if (/enforc|strict|block|compliance/i.test(k)) cols.push(`${t}.${k}`);
  console.log(`[ASIS] columnas con enforce/strict/block/compliance: ${cols.join(', ')}`);
  for (const n of ['fn_change_child_classroom', 'fn_get_child_classroom_change_options', 'fn_get_child_classroom_transitions', 'fn_validate_child_checkin', 'fn_is_child_allowed_in_classroom', 'fn_log_ratio_event_attempt']) {
    const post = ((spec.paths || {})[`/rpc/${n}`] || {}).post || {};
    let props = [];
    for (const x of post.parameters || []) {
      const sc = x.schema || {};
      const d = sc.$ref ? defs[sc.$ref.split('/').pop()] : sc;
      const k = Object.keys((d && d.properties) || {});
      if (k.length) props = k;
    }
    console.log(`[ASIS] ${n}(${props.join(', ')})`);
  }
  const ratio = [];
  for (const [t, d] of Object.entries(defs)) if (!/log|audit|attempt|transition|event/i.test(t)) for (const k of Object.keys(d.properties || {})) if (/ratio/i.test(k)) ratio.push(`${t}.${k}`);
  console.log(`[ASIS] columnas de ratio (sin logs): ${ratio.join(', ')}`);
  for (const t of ['attendance_attempt_logs', 'ratio_event_attempt_logs', 'child_classroom_transitions']) {
    const f = await rest(t, { headers, query: 'order=created_at.desc&limit=4' });
    for (const r of f.json || []) console.log(`[ASIS] ${t}: ${JSON.stringify({ enforce_active: r.enforce_active, ratio_enforced: r.ratio_enforced, ratio_warning: r.ratio_warning, event_type: r.event_type, transition_type: r.transition_type, outcome: r.outcome, reason: r.reason, payload: Object.keys(r.validation_payload || {}) })}`);
  }
  for (const t of ['child_classroom_transitions', 'classroom_schedules', 'ratio_event_attempt_logs']) console.log(`[ASIS] ${t}: ${Object.keys((defs[t] || {}).properties || {}).join(', ')}`);
  console.log(`[ASIS] classrooms.operating_hours: ${JSON.stringify((await rest('classrooms', { headers, query: 'select=name,operating_hours,ratio_compliance_status&limit=3' })).json)}`);
});
