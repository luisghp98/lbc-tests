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
  const CLAVES = ['attendance_grace_period_minutes', 'attendance_late_check_in_fee_amount', 'attendance_late_check_in_flat_fee_enabled',
    'attendance_late_check_in_per_minute_enabled', 'attendance_late_check_in_per_minute_rate'];

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
    const dia = horarios[0];
    expect(dia, 'el tipo de enrolamiento debe tener horario').toBeTruthy();

    // última fecha pasada que cae en un día con horario
    const fecha = new Date();
    do { fecha.setDate(fecha.getDate() - 1); } while (fecha.getDay() !== dia.day_of_week % 7);
    const ymd = fecha.toLocaleDateString('en-CA');
    const [hh, mm] = dia.start_time.split(':').map(Number);
    const hora = (min) => { const t = hh * 60 + mm + min; return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}:00`; };

    await rest('school_settings', { method: 'PATCH', headers, query: `school_id=eq.${schoolId}&deleted_at=is.null`, body: {
      attendance_grace_period_minutes: 5, attendance_late_check_in_flat_fee_enabled: true, attendance_late_check_in_fee_amount: 10,
      attendance_late_check_in_per_minute_enabled: false, attendance_late_check_in_per_minute_rate: 0,
    } });

    const aula = (await rest('classroom_enrollments', { headers, query: `child_id=eq.${id}&select=classroom_id` })).json[0].classroom_id;
    const yo = (await request('/auth/v1/user', { headers })).json;
    const entrar = async (fechaYmd, extra) => {
      const r = await rest('rpc/fn_manual_check_in_child', { method: 'POST', headers, body: {
        p_child_id: id, p_classroom_id: aula, p_school_id: schoolId, p_authorized_by: yo.id, p_entry_method: 'manual_admin',
        p_exception_reason: 'QA automatizado', p_tutor_doc_verified: true, ...extra(fechaYmd),
      } });
      console.log(`[ASIS] check-in ${JSON.stringify(extra(fechaYmd))}: HTTP ${r.status} ${String(r.text).slice(0, 300)}`);
    };
    // Dos días distintos para saber qué parámetro calcula el retraso: la fecha/hora local o p_entry_time.
    const otraFecha = new Date(fecha); otraFecha.setDate(otraFecha.getDate() - 7);
    await entrar(ymd, (d) => ({ p_local_date: d, p_local_time: hora(6) }));
    await entrar(otraFecha.toLocaleDateString('en-CA'), (d) => ({ p_entry_time: `${d}T${hora(6)}` }));

    const asistencia = (await rest('attendance', { headers, query: `child_id=eq.${id}&select=attendance_date,entry_time,exit_time,status,minutes_late,is_late,entry_method` })).json;
    console.log(`[ASIS] asistencia: ${JSON.stringify(asistencia)}`);
    await expect.poll(async () => ((await rest('charges', { headers, query: `child_id=eq.${id}&select=id` })).json || []).length, { timeout: 30_000 }).toBeGreaterThanOrEqual(0);
    const cargos = (await rest('charges', { headers, query: `child_id=eq.${id}&select=charge_type,amount,status,source_event,fee_breakdown,description` })).json;
    console.log(`[ASIS] cargos: ${JSON.stringify(cargos)}`);
  });
});
