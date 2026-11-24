const { rest } = require('./rest');
const { QA_PREFIX, letters } = require('./qa');

const ZONA = 'America/New_York';
// Docente de prueba (tipo teacher, sin horario de trabajo propio): se le fija un horario temporal y se restaura al terminar.
const STAFF_QA_ID = process.env.STAFF_QA_ID || '3fd488ed-74c3-4437-9dff-ebc95ff25ffb';

const aHora = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}:00`;
const aMin = (hhmm) => { const [h, m] = String(hhmm).split(':').map(Number); return h * 60 + m; };

/**
 * Prepara al docente QA para probar la asistencia del staff: horario de trabajo temporal, eventos con la hora simulada
 * (p_local_time / p_entry_time; el registro real solo acepta el día de hoy en la zona del colegio) y limpieza de lo que crea.
 */
class StaffQA {
  constructor(headers, id = STAFF_QA_ID) {
    this.headers = headers;
    this.staffId = id;
    this.asistencias = new Set();
    this.breaks = new Set();
  }

  async iniciar() {
    const h = this.headers;
    const s = (await rest('staff', { headers: h, query: `id=eq.${this.staffId}&deleted_at=is.null&select=school_id,staff_type,employment_status` })).json[0];
    if (!s) throw new Error('No se encuentra el docente de prueba');
    this.schoolId = s.school_id;
    this.tipo = s.staff_type;
    this.hoy = new Date().toLocaleDateString('en-CA', { timeZone: ZONA });
    this.diaSemana = new Date(`${this.hoy}T12:00:00Z`).getUTCDay();
    const gmt = new Intl.DateTimeFormat('en-US', { timeZone: ZONA, timeZoneName: 'shortOffset' })
      .formatToParts(new Date(`${this.hoy}T12:00:00Z`)).find((x) => x.type === 'timeZoneName').value.match(/GMT([+-])(\d+)/);
    this.desfase = `${gmt[1]}${gmt[2].padStart(2, '0')}:00`;
    this.perfil = (await rest('profiles', { headers: h, query: `user_id=eq.${(await require('./rest').request('/auth/v1/user', { headers: h })).json.id}&select=id` })).json[0].id;
    this.ajustes = (await rest('schools', { headers: h, query: `id=eq.${this.schoolId}&select=settings` })).json[0].settings;
  }

  // ---------- horario de trabajo ----------
  async filasHorario() {
    return (await rest('staff_work_schedules', { headers: this.headers, query: `staff_id=eq.${this.staffId}&deleted_at=is.null&select=id,day_of_week,is_working,start_time,end_time` })).json || [];
  }

  /** Ventana de la escuela hoy (minutos) leída con la validación de un staff sin horario propio; null si la escuela está cerrada. */
  async ventanaEscuela() {
    const v = await this.validarHorario('clock_in', '12:00:00');
    return v.windowStart ? { abre: aMin(v.windowStart), cierra: aMin(v.windowEnd), fuente: v.source } : null;
  }

  /** Semana completa para fn_save_staff_work_schedule: solo hoy trabaja (si trabaja) en la ventana indicada, con un almuerzo en el medio. */
  semana(hoyTrabaja, ini, fin) {
    return [0, 1, 2, 3, 4, 5, 6].map((d) => {
      if (d !== this.diaSemana || !hoyTrabaja) return { day_of_week: d, is_working: false, start_time: null, end_time: null, breaks: [] };
      const medio = Math.floor((ini + fin) / 2);
      return {
        day_of_week: d, is_working: true, start_time: aHora(ini).slice(0, 5), end_time: aHora(fin).slice(0, 5),
        breaks: [{ break_type: 'lunch', custom_label: null, start_time: aHora(medio - 15).slice(0, 5), end_time: aHora(medio + 15).slice(0, 5) }],
      };
    });
  }

  async guardarHorario(week) {
    const r = await rest('rpc/fn_save_staff_work_schedule', { method: 'POST', headers: this.headers, body: { p_staff_id: this.staffId, p_school_id: this.schoolId, p_week: week } });
    return { status: r.status, json: r.json, ok: r.status < 300 && r.json && r.json.success !== false };
  }

  /** Deja al docente sin horario propio (borrado lógico de sus filas y descansos), como estaba antes de las pruebas. */
  async quitarHorario() {
    const filas = (await rest('staff_work_schedules', { headers: this.headers, query: `staff_id=eq.${this.staffId}&deleted_at=is.null&select=id` })).json || [];
    if (!filas.length) return 0;
    const ids = filas.map((f) => f.id).join(',');
    const ahora = new Date().toISOString();
    await rest('staff_schedule_breaks', { method: 'PATCH', headers: this.headers, query: `work_schedule_id=in.(${ids})&deleted_at=is.null`, body: { deleted_at: ahora } });
    await rest('staff_work_schedules', { method: 'PATCH', headers: this.headers, query: `id=in.(${ids})`, body: { deleted_at: ahora } });
    return filas.length;
  }

  // ---------- validaciones ----------
  async validarHorario(evento, hora, fecha = this.hoy) {
    const r = await rest('rpc/fn_validate_staff_schedule_event', { method: 'POST', headers: this.headers, body: { p_staff_id: this.staffId, p_school_id: this.schoolId, p_event_type: evento, p_local_date: fecha, p_local_time: hora } });
    return r.json || {};
  }

  async validarRatio(aulaId, evento) {
    const r = await rest('rpc/fn_validate_staff_event', { method: 'POST', headers: this.headers, body: { p_school_id: this.schoolId, p_classroom_id: aulaId, p_event_type: evento } });
    return r.json || {};
  }

  // ---------- eventos ----------
  /** Clock-in a la hora indicada (minutos desde medianoche, hora del colegio). Devuelve { status, json, id, error }. */
  async entrar(min, aulaId) {
    const r = await rest('rpc/fn_manual_check_in_staff', { method: 'POST', headers: this.headers, body: {
      p_staff_id: this.staffId, p_school_id: this.schoolId, p_classroom_id: aulaId || null, p_local_date: this.hoy, p_local_time: aHora(min),
      p_entry_time: `${this.hoy}T${aHora(min)}${this.desfase}`, p_notes: 'QA automatizado',
    } });
    const id = r.json && r.json.data && r.json.data.id;
    if (id) this.asistencias.add(id);
    return { status: r.status, json: r.json, id, ok: r.status < 300 && !!(r.json && r.json.success !== false && id), error: r.status >= 300 ? r.text : (r.json && r.json.error) || null };
  }

  async salir(asistenciaId, min) {
    const r = await rest('rpc/fn_manual_check_out_staff', { method: 'POST', headers: this.headers, body: {
      p_attendance_id: asistenciaId, p_local_time: aHora(min), p_exit_time: `${this.hoy}T${aHora(min)}${this.desfase}`, p_notes: 'QA automatizado',
    } });
    return { status: r.status, json: r.json, ok: r.status < 300 && !!(r.json && r.json.success !== false), error: r.status >= 300 ? r.text : (r.json && r.json.error) || null };
  }

  /** Break-in: la aplicación lo guarda en staff_breaks (inicio) y lo cierra con break_end. */
  async iniciarBreak(asistenciaId, aulaId, tipo = 'lunch', min) {
    const r = await rest('staff_breaks', { method: 'POST', headers: this.headers, body: {
      staff_id: this.staffId, staff_attendance_id: asistenciaId, break_type: tipo, from_classroom_id: aulaId || null,
      break_start: `${this.hoy}T${aHora(min)}${this.desfase}`,
    } });
    const id = r.json && r.json[0] && r.json[0].id;
    if (id) this.breaks.add(id);
    return { status: r.status, json: r.json, id, ok: r.status < 300 && !!id, error: r.status >= 300 ? r.text : null };
  }

  async terminarBreak(id, min) {
    const r = await rest('staff_breaks', { method: 'PATCH', headers: this.headers, query: `id=eq.${id}&break_end=is.null`, body: { break_end: `${this.hoy}T${aHora(min)}${this.desfase}`, updated_at: new Date().toISOString() } });
    return { status: r.status, json: r.json, ok: r.status < 300 && Array.isArray(r.json) && r.json.length === 1, error: r.status >= 300 ? r.text : null };
  }

  async filaAsistencia(id) {
    return ((await rest('staff_attendance', { headers: this.headers, query: `id=eq.${id}&select=id,staff_id,attendance_date,entry_time,exit_time,status,minutes_late,classroom_id,minutes_late_checkout,is_late_checkout,deleted_at` })).json || [])[0];
  }

  /** Asistencias de hoy del docente; con soloQA solo las que registró la suite (notas "QA automatizado"). */
  async asistenciasDeHoy({ soloQA = false } = {}) {
    return (await rest('staff_attendance', { headers: this.headers, query: `staff_id=eq.${this.staffId}&attendance_date=eq.${this.hoy}&deleted_at=is.null${soloQA ? '&notes=eq.QA%20automatizado' : ''}&select=id,entry_time,exit_time,status,classroom_id,notes` })).json || [];
  }

  async breaksDe(asistenciaId) {
    return (await rest('staff_breaks', { headers: this.headers, query: `staff_attendance_id=eq.${asistenciaId}&select=id,break_type,break_start,break_end,from_classroom_id` })).json || [];
  }

  // ---------- cambio de aula ----------
  async opcionesCambio(asistenciaId) {
    const r = await rest('rpc/fn_get_staff_classroom_change_options', { method: 'POST', headers: this.headers, body: { p_staff_attendance_id: asistenciaId, p_school_id: this.schoolId, p_local_time: aHora(9 * 60) } });
    return r.json || {};
  }

  async cambiarAula(asistenciaId, destinoId, { confirmar = false, min = 9 * 60 + 30 } = {}) {
    const r = await rest('rpc/fn_change_staff_classroom', { method: 'POST', headers: this.headers, body: {
      p_staff_attendance_id: asistenciaId, p_to_classroom_id: destinoId, p_school_id: this.schoolId, p_reason: 'QA automatizado',
      p_proceed_with_ratio_warning: confirmar, p_local_date: this.hoy, p_local_time: aHora(min),
    } });
    return { status: r.status, json: r.json || {}, error: r.status >= 300 ? r.text : null };
  }

  async transiciones() {
    const r = await rest('rpc/fn_get_staff_classroom_transitions', { method: 'POST', headers: this.headers, body: { p_school_id: this.schoolId, p_date_from: this.hoy, p_date_to: this.hoy } });
    return (r.json && r.json.transitions) || [];
  }

  async asignaciones() {
    return (await rest('classroom_staff_assignments', { headers: this.headers, query: `staff_id=eq.${this.staffId}&deleted_at=is.null&select=id,classroom_id,role,is_active,is_primary&order=created_at,id` })).json || [];
  }

  // ---------- ajustes de la escuela ----------
  async forzamiento({ staff, ninos }) {
    const nuevo = { ...this.ajustes };
    if (staff !== undefined) nuevo.enforce_staff_ratio = staff;
    if (ninos !== undefined) nuevo.enforce_child_ratio = ninos;
    const r = await rest('schools', { method: 'PATCH', headers: this.headers, query: `id=eq.${this.schoolId}`, body: { settings: nuevo } });
    if (r.status >= 300) throw new Error(`No se pudo cambiar el forzamiento: HTTP ${r.status} ${String(r.text).slice(0, 200)}`);
  }

  async restaurarAjustes() {
    const r = await rest('schools', { method: 'PATCH', headers: this.headers, query: `id=eq.${this.schoolId}`, body: { settings: this.ajustes } });
    console.log(`[STAFF] ajustes de la escuela restaurados: HTTP ${r.status}`);
  }

  // ---------- limpieza ----------
  /** Borra las asistencias de hoy que registró la suite (con sus breaks y transiciones); nunca una asistencia real del docente. */
  async limpiarDia() {
    const hoy = await this.asistenciasDeHoy({ soloQA: true });
    const ids = [...new Set([...hoy.map((a) => a.id), ...this.asistencias])];
    for (const id of ids) {
      await rest('staff_breaks', { method: 'DELETE', headers: this.headers, query: `staff_attendance_id=eq.${id}` });
      await rest('staff_classroom_transitions', { method: 'DELETE', headers: this.headers, query: `staff_attendance_id=eq.${id}` });
      const r = await rest('staff_attendance', { method: 'DELETE', headers: this.headers, query: `id=eq.${id}` });
      if (r.status >= 300) console.log(`[STAFF] no se pudo borrar la asistencia ${id}: HTTP ${r.status} ${String(r.text).slice(0, 120)}`);
    }
    this.asistencias.clear();
    this.breaks.clear();
    return ids.length;
  }
}

/** Niños QA presentes en un aula (para que el ratio tenga niños que cubrir). Se retiran con QaCleanup. */
async function ninoPresente(headers, a, limpieza, aulaId, min) {
  const r = await rest('children', { method: 'POST', headers, body: { school_id: a.schoolId, first_name: 'QA-Child', last_name: `${QA_PREFIX}${letters()}`, birth_date: new Date(Date.now() - 400 * 86400000).toISOString().slice(0, 10), gender: 'Male', status: 'active' } });
  const id = r.json && r.json[0] && r.json[0].id;
  if (!id) throw new Error(`crear niño QA: HTTP ${r.status} ${String(r.text).slice(0, 200)}`);
  limpieza.trackChild(id);
  await rest('classroom_enrollments', { method: 'POST', headers, body: { child_id: id, classroom_id: aulaId, enrolled_at: new Date().toISOString() } });
  const t = aHora(min);
  const e = await rest('rpc/fn_manual_check_in_child', { method: 'POST', headers, body: {
    p_child_id: id, p_classroom_id: aulaId, p_school_id: a.schoolId, p_authorized_by: a.perfil, p_entry_method: 'manual_admin', p_exception_reason: 'QA automatizado', p_tutor_doc_verified: true,
    p_entry_time: `${a.hoy}T${t}${a.desfase}`, p_local_date: a.hoy, p_local_time: t } });
  if (e.status >= 300 || (e.json && e.json.success === false)) throw new Error(`check-in del niño QA: HTTP ${e.status} ${String(e.text).slice(0, 200)}`);
  return id;
}

module.exports = { StaffQA, ninoPresente, STAFF_QA_ID, aHora, aMin };
