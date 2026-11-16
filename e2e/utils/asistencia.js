const { rest, request } = require('./rest');

const ZONA = 'America/New_York';

// Políticas de asistencia de school_settings. Todas apagadas = el estado "sin cargos" que se restaura al terminar.
const CLAVES = [
  'attendance_grace_period_minutes', 'attendance_late_fee_amount', 'early_check_in_grace_period_minutes',
  'attendance_late_check_in_fee_amount', 'attendance_late_check_in_flat_fee_enabled', 'attendance_late_check_in_per_minute_enabled', 'attendance_late_check_in_per_minute_rate',
  'attendance_late_check_out_fee_amount', 'attendance_late_check_out_flat_fee_enabled', 'attendance_late_check_out_per_minute_enabled', 'attendance_late_check_out_per_minute_rate',
  'early_drop_off_fee_amount', 'early_drop_off_flat_fee_enabled', 'early_drop_off_per_minute_enabled', 'early_drop_off_per_minute_rate',
];
const APAGADAS = {
  attendance_grace_period_minutes: 5, early_check_in_grace_period_minutes: 5,
  attendance_late_check_in_fee_amount: 0, attendance_late_check_in_flat_fee_enabled: false, attendance_late_check_in_per_minute_enabled: false, attendance_late_check_in_per_minute_rate: 0,
  attendance_late_check_out_fee_amount: 0, attendance_late_check_out_flat_fee_enabled: false, attendance_late_check_out_per_minute_enabled: false, attendance_late_check_out_per_minute_rate: 0,
  early_drop_off_fee_amount: 0, early_drop_off_flat_fee_enabled: false, early_drop_off_per_minute_enabled: false, early_drop_off_per_minute_rate: 0,
};

// Tipo de matrícula propio de la prueba: 08:00-18:00 los siete días, para no depender del día en que se ejecute.
const TIPO_QA = 'QA-825 Horario fijo';

const aMinutos = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };
const aHora = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}:00`;

/**
 * Prepara un niño QA para probar asistencia: lee su horario de hoy, simula la hora con p_entry_time / p_exit_time
 * (el RPC solo acepta el día de hoy en la zona del colegio) y guarda/restaura la configuración del colegio.
 */
class AsistenciaQA {
  constructor(headers) { this.headers = headers; }

  async iniciar() {
    const h = this.headers;
    this.schoolId = (await rest('staff', { headers: h, query: 'limit=1&select=school_id' })).json[0].school_id;
    const yo = (await request('/auth/v1/user', { headers: h })).json;
    this.perfil = (await rest('profiles', { headers: h, query: `user_id=eq.${yo.id}&select=id` })).json[0].id;
    this.original = (await rest('school_settings', { headers: h, query: `school_id=eq.${this.schoolId}&deleted_at=is.null&select=${CLAVES.join(',')}` })).json[0];
    this.hoy = new Date().toLocaleDateString('en-CA', { timeZone: ZONA });
    this.diaSemana = new Date(`${this.hoy}T12:00:00Z`).getUTCDay();
    const gmt = new Intl.DateTimeFormat('en-US', { timeZone: ZONA, timeZoneName: 'shortOffset' })
      .formatToParts(new Date(`${this.hoy}T12:00:00Z`)).find((x) => x.type === 'timeZoneName').value.match(/GMT([+-])(\d+)/);
    this.desfase = `${gmt[1]}${gmt[2].padStart(2, '0')}:00`;
  }

  /** Crea el tipo de matrícula QA (mismo producto que Full Time) con horario 08:00-18:00 todos los días. */
  async crearTipo() {
    const h = this.headers;
    const base = (await rest('enrollment_types', { headers: h, query: 'name=eq.Full Time&deleted_at=is.null&select=product_service_id&limit=1' })).json[0];
    const t = await rest('enrollment_types', { method: 'POST', headers: h, body: {
      school_id: this.schoolId, product_service_id: base.product_service_id, name: TIPO_QA, description: 'QA automatizado: 08:00-18:00 todos los días', status: 'active', is_dropin: false,
    } });
    if (t.status >= 300) throw new Error(`No se pudo crear el tipo de matrícula QA: HTTP ${t.status} ${t.text}`);
    this.tipoId = t.json[0].id;
    const dias = [0, 1, 2, 3, 4, 5, 6].map((d) => ({ school_id: this.schoolId, enrollment_type_id: this.tipoId, day_of_week: d, is_attending: true, start_time: '08:00:00', end_time: '18:00:00' }));
    const s = await rest('enrollment_type_schedules', { method: 'POST', headers: h, body: dias });
    if (s.status >= 300) throw new Error(`No se pudieron crear los horarios del tipo QA: HTTP ${s.status} ${s.text}`);
  }

  /** Da de baja (deleted_at) los tipos QA, incluidos los restos de corridas interrumpidas. */
  async quitarTipos() {
    const h = this.headers;
    const ahora = new Date().toISOString();
    const tipos = (await rest('enrollment_types', { headers: h, query: `name=eq.${encodeURIComponent(TIPO_QA)}&deleted_at=is.null&select=id` })).json || [];
    for (const t of tipos) {
      await rest('enrollment_type_schedules', { method: 'PATCH', headers: h, query: `enrollment_type_id=eq.${t.id}&deleted_at=is.null`, body: { deleted_at: ahora } });
      await rest('enrollment_types', { method: 'PATCH', headers: h, query: `id=eq.${t.id}`, body: { deleted_at: ahora } });
    }
    console.log(`[ASIS] tipos QA dados de baja: ${tipos.length}`);
  }

  /** Quita (o devuelve) el horario de hoy del tipo QA: sirve para probar un día no contratado. */
  async horarioDeHoy(activo) {
    await rest('enrollment_type_schedules', { method: 'PATCH', headers: this.headers, query: `enrollment_type_id=eq.${this.tipoId}&day_of_week=eq.${this.diaSemana}`, body: { deleted_at: activo ? null : new Date().toISOString() } });
    await this.usarNino(this.ninoId);
  }

  /** Asocia el niño y su horario contratado de hoy (null si hoy no tiene horario). */
  async usarNino(id) {
    const h = this.headers;
    this.ninoId = id;
    this.aulaId = (await rest('classroom_enrollments', { headers: h, query: `child_id=eq.${id}&status=eq.active&select=classroom_id` })).json[0].classroom_id;
    const tipo = (await rest('enrollments', { headers: h, query: `child_id=eq.${id}&select=enrollment_type_id` })).json[0].enrollment_type_id;
    const dia = (await rest('enrollment_type_schedules', {
      headers: h, query: `enrollment_type_id=eq.${tipo}&day_of_week=eq.${this.diaSemana}&is_attending=eq.true&deleted_at=is.null&select=start_time,end_time`,
    })).json[0];
    this.inicio = dia ? aMinutos(dia.start_time) : null;
    this.fin = dia ? aMinutos(dia.end_time) : null;
  }

  get hayHorario() { return this.inicio !== null; }

  /** Aplica una política: todo apagado salvo lo que se indique. */
  async politica(cambios = {}) {
    const r = await rest('school_settings', { method: 'PATCH', headers: this.headers, query: `school_id=eq.${this.schoolId}&deleted_at=is.null`, body: { ...APAGADAS, ...cambios } });
    if (r.status >= 300) throw new Error(`No se pudo aplicar la política: HTTP ${r.status}`);
  }

  async restaurar() {
    const r = await rest('school_settings', { method: 'PATCH', headers: this.headers, query: `school_id=eq.${this.schoolId}&deleted_at=is.null`, body: this.original });
    console.log(`[ASIS] configuración restaurada: HTTP ${r.status}`);
  }

  /** Borra la asistencia y los cargos del niño: solo se puede registrar una asistencia por día. */
  async limpiarDia() {
    await rest('charges', { method: 'DELETE', headers: this.headers, query: `child_id=eq.${this.ninoId}` });
    await rest('attendance', { method: 'DELETE', headers: this.headers, query: `child_id=eq.${this.ninoId}` });
  }

  /** Check-in a la hora indicada (minutos desde medianoche, hora del colegio). Devuelve { status, asistencia, error }. */
  async entrar(min, aulaId = this.aulaId) {
    const r = await rest('rpc/fn_manual_check_in_child', { method: 'POST', headers: this.headers, body: {
      p_child_id: this.ninoId, p_classroom_id: aulaId, p_school_id: this.schoolId, p_authorized_by: this.perfil, p_entry_method: 'manual_admin',
      p_exception_reason: 'QA automatizado', p_tutor_doc_verified: true,
      p_entry_time: `${this.hoy}T${aHora(min)}${this.desfase}`, p_local_date: this.hoy, p_local_time: aHora(min),
    } });
    return { status: r.status, asistencia: r.json && r.json.data, error: r.status >= 300 ? r.text : null };
  }

  async salir(asistenciaId, min) {
    const r = await rest('rpc/fn_manual_check_out_child', { method: 'POST', headers: this.headers, body: {
      p_attendance_id: asistenciaId, p_authorized_by: this.perfil, p_exit_method: 'manual_admin', p_exception_reason: 'QA automatizado',
      p_tutor_doc_verified: true, p_exit_time: `${this.hoy}T${aHora(min)}${this.desfase}`, p_local_time: aHora(min),
    } });
    return { status: r.status, error: r.status >= 300 ? r.text : null };
  }

  async asistencia() {
    return (await rest('attendance', { headers: this.headers, query: `child_id=eq.${this.ninoId}&select=id,entry_time,exit_time,status,minutes_late,is_late,minutes_late_checkout,is_late_checkout,classroom_id` })).json || [];
  }

  async cargos() {
    return (await rest('charges', { headers: this.headers, query: `child_id=eq.${this.ninoId}&select=charge_type,source_event,amount,status,fee_breakdown&order=created_at` })).json || [];
  }
}

module.exports = { AsistenciaQA, TIPO_QA };
