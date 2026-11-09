const { rest } = require('./rest');
const { letters } = require('./qa');

const hoy = () => new Date().toISOString().slice(0, 10);

/** Aulas de prueba (prefijo QA-1702) con o sin personal asignado, creadas por API y retiradas al final. */
class AulasQA {
  constructor() {
    this.aulas = [];
    this.asignaciones = [];
  }

  async crear(headers, { etiqueta, conPersonal }) {
    const ref = await rest('classrooms', { headers, query: 'classroom_name=ilike.QA-*&deleted_at=is.null&limit=1&select=campus_id' });
    const campusId = ref.json && ref.json[0] && ref.json[0].campus_id;
    if (!campusId) throw new Error('No hay un aula QA de referencia para tomar el campus');

    const nombre = `QA-1702-${etiqueta}-${letters(4)}`;
    const res = await rest('classrooms', {
      method: 'POST', headers,
      body: {
        campus_id: campusId, classroom_name: nombre, classroom_code: `Q${letters(7).toUpperCase()}`,
        capacity: 5, level: 'Pre-Kindergarten', status: 'active', is_active: true, floor: 1, square_footage: 600,
      },
    });
    if (res.status !== 201) throw new Error(`crear aula ${nombre}: ${res.status} ${res.text.slice(0, 200)}`);
    const aula = { id: res.json[0].id, nombre, conPersonal };
    this.aulas.push(aula);

    if (conPersonal) {
      const staff = await rest('staff', { headers, query: 'employment_status=eq.active&deleted_at=is.null&limit=1&select=id' });
      const staffId = staff.json && staff.json[0] && staff.json[0].id;
      if (!staffId) throw new Error('No hay personal activo para asignar');
      const asg = await rest('classroom_staff_assignments', {
        method: 'POST', headers,
        body: { classroom_id: aula.id, staff_id: staffId, role: 'lead', is_active: true, assigned_at: hoy() },
      });
      if (asg.status !== 201) throw new Error(`asignar personal: ${asg.status} ${asg.text.slice(0, 200)}`);
      this.asignaciones.push(asg.json[0].id);
    }
    return aula;
  }

  async limpiar(headers) {
    for (const id of this.asignaciones) {
      await rest('classroom_staff_assignments', { method: 'PATCH', headers, query: `id=eq.${id}`, body: { is_active: false } });
    }
    for (const a of this.aulas) {
      await rest('classrooms', {
        method: 'PATCH', headers, query: `id=eq.${a.id}&classroom_name=like.QA-1702-*`,
        body: { is_active: false, status: 'inactive', deleted_at: new Date().toISOString() },
      });
    }
    console.log(`[QA aulas] retiradas: ${this.aulas.length}, asignaciones desactivadas: ${this.asignaciones.length}`);
    this.aulas = [];
    this.asignaciones = [];
  }

  /** Red de seguridad: aulas QA-1702 de corridas interrumpidas. */
  async sweep(headers) {
    const left = await rest('classrooms', { headers, query: 'classroom_name=like.QA-1702-*&deleted_at=is.null&select=id' });
    for (const a of left.json || []) {
      await rest('classroom_staff_assignments', { method: 'PATCH', headers, query: `classroom_id=eq.${a.id}&is_active=eq.true`, body: { is_active: false } });
      await rest('classrooms', { method: 'PATCH', headers, query: `id=eq.${a.id}`, body: { is_active: false, status: 'inactive', deleted_at: new Date().toISOString() } });
    }
    console.log(`[QA aulas sweep] restos: ${(left.json || []).length}`);
  }
}

module.exports = { AulasQA };
