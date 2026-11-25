const { test, expect } = require('@playwright/test');
const { asUser, rest } = require('../../utils/rest');
const { QaCleanup } = require('../../utils/qa');
const { AulasQA } = require('../../utils/aulas');
const { StaffQA, ninoPresente, aHora, aMin } = require('../../utils/staff');
const { informar } = require('../../utils/informe');

// LBC-1896: asistencia del staff (clock-in/out, breaks, forzamiento del ratio, cambio de aula y día configurado).
// Docente de prueba (STAFF_QA_ID, tipo teacher y sin horario propio): se le guarda un horario temporal de hoy y al terminar se deja sin horario.
// La ventana de trabajo sale de las horas del colegio de hoy (el horario del staff debe estar dentro de ellas); si la escuela está cerrada, se omite.
// El clock-out exitoso no se puede completar con la sesión de administrador: el aula exige cerrar su registro de asistencia desde la app del staff
// (classroom_attendance_register_pending), por eso el clock-out se comprueba con la validación y con el motivo del rechazo.
test.describe('STAFF: asistencia del staff', { tag: '@asistencia' }, () => {
  test.setTimeout(600_000);
  test.describe.configure({ mode: 'serial', retries: 0 });

  const limpieza = new QaCleanup();
  const aulas = new AulasQA();
  let headers; let s; let ini; let fin; let ratio; let medio; let horarioNuestro = false;
  let vacia; let sinRatio; let aulaRatio; let origen; let destino; let inactiva; let attOrigen;
  const instante = (min) => new Date(`${s.hoy}T${aHora(min)}${s.desfase}`).getTime();
  const sumarDias = (n) => new Date(new Date(`${s.hoy}T12:00:00Z`).getTime() + n * 86400000).toISOString().slice(0, 10);
  const proximo = (dia) => sumarDias(((dia - s.diaSemana + 7) % 7) || 7);
  const horarioBase = () => s.guardarHorario(s.semana(true, ini, fin));
  const rechazo = (r, motivo) => { expect(r.ok, `el registro debe rechazarse: ${motivo}`).toBe(false); expect(`${r.error}`, 'motivo del rechazo').toContain(motivo); };

  test.beforeAll(async () => {
    headers = await asUser();
    s = new StaffQA(headers); await s.iniciar();
    expect(s.tipo, 'el docente de prueba debe ser tipo teacher').toBe('teacher');
    expect(await s.filasHorario(), 'el docente de prueba no debe tener horario propio (se usa uno temporal)').toHaveLength(0);
    expect((await s.asistenciasDeHoy()).filter((a) => a.notes !== 'QA automatizado'), 'el docente ya tiene una asistencia real hoy').toHaveLength(0);
    await limpieza.sweep(headers); await aulas.sweep(headers);
    await s.limpiarDia();
    const v = await s.ventanaEscuela();
    test.skip(!v, 'La escuela está cerrada hoy: no hay ventana de trabajo para el staff');
    ini = v.abre + 60; fin = v.cierra - 60; medio = Math.floor((ini + fin) / 2);
    ratio = (await rest('staff_ratios', { headers, query: 'ratio_name=eq.Small Infants&deleted_at=is.null&select=id,max_children' })).json[0];
    const g = await horarioBase();
    horarioNuestro = g.ok;
    expect(g.ok, `guardar el horario temporal: ${JSON.stringify(g.json)}`).toBe(true);
    vacia = await aulas.crear(headers, { etiqueta: 'StVacia', conPersonal: true, ratioId: ratio.id, staffId: s.staffId });
    sinRatio = await aulas.crear(headers, { etiqueta: 'StSinRatio', conPersonal: false });
    console.log(`[STAFF] hoy ${s.hoy} (día ${s.diaSemana}); ventana del staff ${aHora(ini).slice(0, 5)}–${aHora(fin).slice(0, 5)}; escuela ${aHora(v.abre).slice(0, 5)}–${aHora(v.cierra).slice(0, 5)}`);
  });

  // La limpieza es lo más importante: cada paso se reintenta (la conexión local se corta a veces) y un fallo no impide los demás.
  const paso = async (nombre, fn, errores) => {
    for (let i = 1; i <= 3; i++) {
      try { return await fn(); } catch (e) { if (i === 3) errores.push(`${nombre}: ${String(e.message).slice(0, 120)}`); }
    }
  };

  test.afterAll(async () => {
    const errores = [];
    await paso('sesión', async () => { headers = await asUser(); s.headers = headers; }, errores);
    const n = await paso('asistencias', () => s.limpiarDia(), errores);
    const transiciones = await paso('transiciones', async () => (await s.transiciones()).length, errores);
    await paso('ajustes', () => s.restaurarAjustes(), errores);
    await paso('niños', () => limpieza.run(headers), errores);
    await paso('aulas', () => aulas.limpiar(headers), errores);
    const filas = horarioNuestro ? await paso('horario', () => s.quitarHorario(), errores) : 0;
    const quedan = horarioNuestro ? await paso('comprobar horario', async () => (await s.filasHorario()).length, errores) : 0;
    const ajustes = await paso('comprobar ajustes', async () => (await rest('schools', { headers, query: `id=eq.${s.schoolId}&select=settings` })).json[0].settings, errores);
    console.log(`[STAFF] limpieza: asistencias borradas ${n}; transiciones que quedaron hoy ${transiciones}; horario retirado (filas) ${filas}; horario activo restante ${quedan}; errores ${errores.length}`);
    expect(errores, 'la limpieza no debe fallar').toEqual([]);
    expect(quedan, 'el docente queda sin horario propio, como estaba').toBe(0);
    expect(ajustes, 'los ajustes de la escuela quedan como estaban').toEqual(s.ajustes);
  });

  // ---------- A. Clock-in / clock-out y horario del staff ----------
  test('A-01: clock-in dentro del horario crea una asistencia con la hora indicada', async () => {
    await s.limpiarDia();
    const r = await s.entrar(ini + 5, vacia.id);
    expect(r.ok, `clock-in: ${r.error}`).toBe(true);
    const fila = await s.filaAsistencia(r.id);
    informar('STAFF-A-01', `clock-in ${aHora(ini + 5)}: estado=${fila.status}; entry_time=${fila.entry_time}; minutos tarde=${fila.minutes_late}; aula=la indicada`);
    expect(new Date(fila.entry_time).getTime()).toBe(instante(ini + 5));
    expect(fila.status).toBe('present');
    expect(fila.classroom_id).toBe(vacia.id);
    expect(await s.asistenciasDeHoy(), 'una sola asistencia del día').toHaveLength(1);
  });

  test('X-01: un segundo clock-in el mismo día se rechaza (no hay registros dobles)', async () => {
    const r = await s.entrar(ini + 10, vacia.id);
    informar('STAFF-X-01', `segundo clock-in: ${JSON.stringify(r.json)}`);
    expect(r.ok).toBe(false);
    expect(r.json && r.json.error).toBe('already_checked_in');
    expect(await s.asistenciasDeHoy(), 'sigue habiendo una sola asistencia').toHaveLength(1);
  });

  test('A-02: los límites del horario son inclusivos (inicio y fin)', async () => {
    await s.limpiarDia();
    const dentroIni = await s.validarHorario('clock_in', aHora(ini));
    const dentroFin = await s.validarHorario('clock_out', aHora(fin));
    const r = await s.entrar(ini, vacia.id);
    informar('STAFF-A-02', `validación inicio=${dentroIni.allowed}; validación fin=${dentroFin.allowed}; clock-in exacto al inicio: ${r.ok ? 'aceptado' : r.error}`);
    expect(dentroIni.allowed).toBe(true);
    expect(dentroFin.allowed).toBe(true);
    expect(r.ok, `clock-in exacto al inicio: ${r.error}`).toBe(true);
    await s.limpiarDia();
  });

  for (const [id, titulo, delta] of [['A-03', 'antes del inicio', -1], ['A-04', 'después del fin', 1]]) {
    test(`${id}: el clock-in ${titulo} del horario se rechaza y no crea asistencia`, async () => {
      await s.limpiarDia();
      const min = delta < 0 ? ini - 1 : fin + 1;
      const v = await s.validarHorario('clock_in', aHora(min));
      const r = await s.entrar(min, vacia.id);
      informar(`STAFF-${id}`, `clock-in ${aHora(min)}: validación=${v.reason}; registro=${r.ok ? 'ACEPTADO' : `HTTP ${r.status} ${r.json && r.json.hint}`}`);
      expect(v.allowed).toBe(false);
      expect(v.reason).toBe('staff_outside_work_schedule');
      rechazo(r, 'staff_outside_work_schedule');
      expect(await s.asistenciasDeHoy(), 'no se crea asistencia').toHaveLength(0);
    });
  }

  test('A-05: el clock-out dentro del horario pasa la validación del horario', async () => {
    await s.limpiarDia();
    const ci = await s.entrar(ini + 5, vacia.id);
    expect(ci.ok, ci.error).toBe(true);
    const v = await s.validarHorario('clock_out', aHora(ini + 20));
    const r = await s.salir(ci.id, ini + 20);
    informar('STAFF-A-05', `validación clock-out ${aHora(ini + 20)}: permitido=${v.allowed}; registro: ${r.ok ? 'registrado' : (r.json && r.json.hint) || r.error}`);
    expect(v.allowed).toBe(true);
    // Con la sesión de administrador el aula exige cerrar su registro de asistencia (app del staff): ese es el único rechazo admitido.
    if (!r.ok) expect(`${r.error}`).toContain('classroom_attendance_register_pending');
  });

  test('A-06: el clock-out después del fin no pasa la validación del horario y la asistencia sigue abierta', async () => {
    const [att] = await s.asistenciasDeHoy();
    const v = await s.validarHorario('clock_out', aHora(fin + 1));
    const r = await s.salir(att.id, fin + 1);
    const fila = await s.filaAsistencia(att.id);
    informar('STAFF-A-06', `validación clock-out ${aHora(fin + 1)}: ${v.reason}; registro: ${r.ok ? 'ACEPTADO' : (r.json && r.json.hint) || r.error}; exit_time=${fila.exit_time}`);
    expect(v.allowed).toBe(false);
    expect(v.reason).toBe('staff_outside_work_schedule');
    expect(r.ok, 'el clock-out fuera de horario no se registra').toBe(false);
    expect(fila.exit_time, 'la asistencia sigue abierta').toBeNull();
    await s.limpiarDia();
  });

  test('A-09: el horario se valida igual con el forzamiento del staff activo e inactivo', async () => {
    const motivos = {};
    for (const activo of [true, false]) {
      await s.forzamiento({ staff: activo });
      await s.limpiarDia();
      const fuera = await s.entrar(ini - 1, vacia.id);
      const dentro = await s.entrar(ini + 5, vacia.id);
      motivos[activo ? 'activo' : 'inactivo'] = { fuera: fuera.ok ? 'aceptado' : (fuera.json && fuera.json.hint), dentro: dentro.ok };
      rechazo(fuera, 'staff_outside_work_schedule');
      expect(dentro.ok, dentro.error).toBe(true);
    }
    await s.restaurarAjustes();
    informar('STAFF-A-09', `fuera de horario / dentro: ${JSON.stringify(motivos)}`);
    await s.limpiarDia();
  });

  test('X-02: llegar tarde respecto al inicio del horario (informativo)', async () => {
    await s.limpiarDia();
    const r = await s.entrar(ini + 30, vacia.id);
    expect(r.ok, r.error).toBe(true);
    const fila = await s.filaAsistencia(r.id);
    informar('STAFF-X-02', `clock-in ${aHora(ini + 30)} con inicio ${aHora(ini)}: estado=${fila.status}; minutos tarde=${fila.minutes_late}`);
    await s.limpiarDia();
  });

  // ---------- B. Breaks ----------
  test.describe('B. Breaks', () => {
    let att; let brk;
    test.beforeAll(async () => { await s.limpiarDia(); const r = await s.entrar(ini + 5, vacia.id); expect(r.ok, r.error).toBe(true); att = r.id; });

    test('B-01: el break-in dentro del horario crea el break y la asistencia sigue abierta', async () => {
      const v = await s.validarHorario('break_in', aHora(ini + 60));
      const b = await s.iniciarBreak(att, vacia.id, 'lunch', ini + 60);
      expect(v.allowed, JSON.stringify(v)).toBe(true);
      expect(b.ok, b.error).toBe(true);
      const fila = await s.filaAsistencia(att);
      const [abierto] = await s.breaksDe(att);
      informar('STAFF-B-01', `break-in ${aHora(ini + 60)}: tipo=${abierto.break_type}; break_end=${abierto.break_end}; exit_time de la asistencia=${fila.exit_time}`);
      expect(abierto.break_end).toBeNull();
      expect(new Date(abierto.break_start).getTime()).toBe(instante(ini + 60));
      expect(fila.exit_time).toBeNull();
      brk = b.id;
    });

    test('B-02: el break-out cierra el break sin cerrar la asistencia', async () => {
      const v = await s.validarHorario('break_out', aHora(ini + 75));
      const r = await s.terminarBreak(brk, ini + 75);
      expect(v.allowed).toBe(true);
      expect(r.ok, r.error).toBe(true);
      const [cerrado] = await s.breaksDe(att);
      const fila = await s.filaAsistencia(att);
      informar('STAFF-B-02', `break-out ${aHora(ini + 75)}: duración=${r.json[0].duration_minutes} min; exit_time de la asistencia=${fila.exit_time}`);
      expect(new Date(cerrado.break_end).getTime()).toBe(instante(ini + 75));
      expect(r.json[0].duration_minutes).toBe(15);
      expect(fila.exit_time).toBeNull();
    });

    test('B-03: el break fuera del horario no pasa la validación del horario', async () => {
      const res = {};
      for (const [evento, min] of [['break_in', ini - 1], ['break_out', ini - 1], ['break_in', fin + 1], ['break_out', fin + 1]]) {
        const v = await s.validarHorario(evento, aHora(min));
        res[`${evento} ${aHora(min).slice(0, 5)}`] = v.reason;
        expect(v.allowed, `${evento} ${aHora(min)}`).toBe(false);
        expect(v.reason).toBe('staff_outside_work_schedule');
      }
      // Observación: el horario solo lo controla la validación previa de la aplicación; la tabla acepta el break si se inserta directo.
      const directo = await s.iniciarBreak(att, vacia.id, 'lunch', ini - 1);
      if (directo.id) await rest('staff_breaks', { method: 'DELETE', headers, query: `id=eq.${directo.id}` });
      informar('STAFF-B-03', `validación: ${JSON.stringify(res)}; insert directo en staff_breaks fuera de horario: ${directo.ok ? 'ACEPTADO por la base' : 'rechazado'}`);
    });

    test('B-04: dos breaks activos a la vez (la pantalla lo impide; se anota qué hace la base)', async () => {
      const a = await s.iniciarBreak(att, vacia.id, 'lunch', ini + 90);
      const b = await s.iniciarBreak(att, vacia.id, 'lunch', ini + 91);
      const activos = (await s.breaksDe(att)).filter((x) => !x.break_end).length;
      // La pantalla comprueba si ya hay un break activo con maybeSingle(): con 2 filas activas la API responde 406 y esa comprobación deja de detectar nada.
      const guardia = await rest('staff_breaks', { headers: { ...headers, Accept: 'application/vnd.pgrst.object+json' }, query: `staff_id=eq.${s.staffId}&staff_attendance_id=eq.${att}&break_end=is.null&select=id` });
      const duraciones = [];
      for (const x of [a.id, b.id]) if (x) { const r = await s.terminarBreak(x, ini + 100); duraciones.push(r.ok ? r.json[0].duration_minutes : null); }
      informar('STAFF-B-04', `primer break activo: ${a.ok ? 'aceptado' : 'rechazado'}; segundo break activo: ${b.ok ? 'ACEPTADO por la base' : 'rechazado'}; breaks activos=${activos}; consulta de la pantalla con ${activos} activos: HTTP ${guardia.status}; duraciones=${JSON.stringify(duraciones)} (suma ${duraciones.reduce((t, d) => t + (d || 0), 0)} min; tiempo real fuera del aula 10 min)`);
      expect(a.ok, a.error).toBe(true);
    });

    test('B-05: el almuerzo programado no restringe los eventos dentro del horario de trabajo', async () => {
      const res = {};
      for (const [evento, min] of [['clock_in', medio], ['break_in', medio - 10], ['break_out', medio + 10], ['clock_out', medio]]) {
        const v = await s.validarHorario(evento, aHora(min));
        res[`${evento} ${aHora(min).slice(0, 5)}`] = v.allowed;
        expect(v.allowed, `${evento} dentro del almuerzo programado`).toBe(true);
      }
      informar('STAFF-B-05', `almuerzo programado ${aHora(medio - 15).slice(0, 5)}–${aHora(medio + 15).slice(0, 5)}; permitidos: ${JSON.stringify(res)}`);
    });

    test('X-03: clock-out con un break activo (informativo)', async () => {
      const b = await s.iniciarBreak(att, vacia.id, 'lunch', ini + 120);
      const r = await s.salir(att, ini + 125);
      informar('STAFF-X-03', `clock-out con break activo: ${r.ok ? 'registrado' : (r.json && r.json.hint) || r.error}`);
      if (b.id) await s.terminarBreak(b.id, ini + 126);
    });

    test.afterAll(async () => { await s.limpiarDia(); });
  });

  // ---------- C. Forzamiento activo / inactivo (ratio del aula) ----------
  test.describe('C. Forzamiento del ratio', () => {
    test.beforeAll(async () => {
      await s.limpiarDia();
      aulaRatio = await aulas.crear(headers, { etiqueta: 'StRatio', conPersonal: true, ratioId: ratio.id, staffId: s.staffId });
      const r = await s.entrar(ini + 5, aulaRatio.id);
      expect(r.ok, r.error).toBe(true);
      for (let i = 0; i < ratio.max_children; i++) await ninoPresente(headers, s, limpieza, aulaRatio.id, ini + 6);
    });
    test.afterAll(async () => { await s.limpiarDia(); await s.restaurarAjustes(); });

    for (const [id, activo, accion, confirma] of [['C-01', true, 'block', false], ['C-02', false, 'confirm', true]]) {
      test(`${id}: con el forzamiento del staff ${activo ? 'activo' : 'inactivo'} el clock-out que deja el aula sin cobertura ${activo ? 'se bloquea' : 'pide confirmación'}`, async () => {
        await s.forzamiento({ staff: activo });
        const v = await s.validarRatio(aulaRatio.id, 'clock_out');
        informar(`STAFF-${id}`, `personal presente=${v.current_staff}; niños=${v.current_children}/${v.max_children}; acción=${v.validation_action}; razón=${v.reason}; requiere confirmación=${v.requires_confirmation}`);
        expect(v.current_staff).toBe(1);
        expect(v.current_children).toBe(ratio.max_children);
        expect(v.enforce_active).toBe(activo);
        expect(v.ratio_affected).toBe(true);
        expect(v.validation_action).toBe(accion);
        expect(v.requires_confirmation).toBe(confirma);
        expect(v.allowed).toBe(false);
        expect((await s.asistenciasDeHoy())[0].exit_time, 'el staff sigue presente').toBeNull();
      });
    }

    test('B-06: el break-in que deja el aula sin cobertura se trata igual que el clock-out', async () => {
      const res = {};
      for (const [activo, accion] of [[true, 'block'], [false, 'confirm']]) {
        await s.forzamiento({ staff: activo });
        const v = await s.validarRatio(aulaRatio.id, 'break_in');
        res[activo ? 'activo' : 'inactivo'] = `${v.validation_action}/${v.reason}`;
        expect(v.validation_action).toBe(accion);
        expect(v.ratio_affected).toBe(true);
      }
      informar('STAFF-B-06', `break-in con 1 staff y ${ratio.max_children} niños: ${JSON.stringify(res)}`);
    });

    test('C-03: el clock-in que no afecta el ratio se permite con el forzamiento activo e inactivo', async () => {
      const res = {};
      for (const activo of [true, false]) {
        await s.forzamiento({ staff: activo });
        const v = await s.validarRatio(vacia.id, 'clock_in');
        res[activo ? 'activo' : 'inactivo'] = v.validation_action;
        expect(v.validation_action).toBe('allow');
        expect(v.allowed).toBe(true);
        expect(v.requires_confirmation).toBe(false);
      }
      informar('STAFF-C-03', `clock-in en un aula sin niños: ${JSON.stringify(res)}`);
    });

    test('C-04: el clock-in que sobrepasa el ratio (sobrecobertura) se permite con el forzamiento activo e inactivo', async () => {
      const res = {};
      for (const activo of [true, false]) {
        await s.forzamiento({ staff: activo });
        const v = await s.validarRatio(aulaRatio.id, 'clock_in');
        res[activo ? 'activo' : 'inactivo'] = `${v.validation_action}/sobrecobertura=${v.over_covered}`;
        expect(v.over_covered).toBe(true);
        expect(v.validation_action).toBe('allow');
        expect(v.allowed).toBe(true);
      }
      informar('STAFF-C-04', `clock-in con 1 staff presente y ${ratio.max_children} niños (requiere 1): ${JSON.stringify(res)}`);
    });

    test('C-05: un aula sin ratio asignado permite los cuatro eventos', async () => {
      const res = {};
      for (const ev of ['clock_in', 'clock_out', 'break_in', 'break_out']) {
        const v = await s.validarRatio(sinRatio.id, ev);
        res[ev] = v.validation_action;
        expect(v.validation_action, ev).toBe('allow');
      }
      informar('STAFF-C-05', `aula sin ratio: ${JSON.stringify(res)}`);
    });

    test('C-06: el forzamiento del staff no depende del de niños', async () => {
      const res = {};
      for (const [staff, ninos, accion] of [[true, false, 'block'], [false, true, 'confirm']]) {
        await s.forzamiento({ staff, ninos });
        const v = await s.validarRatio(aulaRatio.id, 'clock_out');
        res[`staff=${staff},niños=${ninos}`] = v.validation_action;
        expect(v.validation_action).toBe(accion);
      }
      informar('STAFF-C-06', `clock-out según cada clave: ${JSON.stringify(res)}`);
    });
  });

  // ---------- D. Cambio de aula del staff ----------
  test.describe('D. Cambio de aula', () => {
    let antes;
    const activas = async () => (await s.asignaciones()).filter((a) => a.is_active).map((a) => a.classroom_id).sort();
    const cambio = (confirmar) => s.cambiarAula(attOrigen, destino.id, { confirmar, min: ini + 30 });

    test.beforeAll(async () => {
      await s.limpiarDia(); await s.restaurarAjustes();
      origen = await aulas.crear(headers, { etiqueta: 'StOrigen', conPersonal: true, ratioId: ratio.id, staffId: s.staffId });
      destino = await aulas.crear(headers, { etiqueta: 'StDestino', conPersonal: true, ratioId: ratio.id, staffId: s.staffId });
      inactiva = await aulas.crear(headers, { etiqueta: 'StInactiva', conPersonal: false, ratioId: ratio.id });
      const p = await rest('classrooms', { method: 'PATCH', headers, query: `id=eq.${inactiva.id}`, body: { is_active: false, status: 'inactive' } });
      expect(p.status, 'dejar inactiva el aula de prueba').toBeLessThan(300);
      const r = await s.entrar(ini + 5, origen.id);
      expect(r.ok, r.error).toBe(true);
      attOrigen = r.id;
      for (let i = 0; i < ratio.max_children; i++) await ninoPresente(headers, s, limpieza, origen.id, ini + 6);
      await ninoPresente(headers, s, limpieza, destino.id, ini + 6);
      antes = {
        entrada: (await s.filaAsistencia(attOrigen)).entry_time, asignaciones: await activas(),
        origen: (await s.validarRatio(origen.id, 'clock_in')).current_staff, destino: (await s.validarRatio(destino.id, 'clock_in')).current_staff,
      };
    });
    test.afterAll(async () => { await s.limpiarDia(); await s.restaurarAjustes(); });

    test('D-09: las opciones de cambio no incluyen el aula de origen y sí las aulas activas', async () => {
      const op = await s.opcionesCambio(attOrigen);
      const ids = (op.options || []).map((o) => o.id);
      informar('STAFF-D-09', `opciones=${ids.length}; incluye el aula destino=${ids.includes(destino.id)}; incluye el origen=${ids.includes(origen.id)}; forzamiento=${op.enforce_ratio}`);
      expect(op.success).not.toBe(false);
      expect(ids).not.toContain(origen.id);
      expect(ids).toContain(destino.id);
    });

    test('D-09b: un aula inactiva no se puede elegir en las opciones de cambio (se lista bloqueada: can_move=false, CLASSROOM_INACTIVE)', async () => {
      const op = await s.opcionesCambio(attOrigen);
      const o = (op.options || []).find((x) => x.id === inactiva.id);
      informar('STAFF-D-09b', o ? `el aula inactiva aparece en la lista bloqueada: can_move=${o.can_move}; motivos=${JSON.stringify(o.blocked_reasons)}` : 'el aula inactiva no aparece en las opciones');
      if (o) {
        expect(o.can_move, 'el aula inactiva no debe poder elegirse').toBe(false);
        expect(o.blocked_reasons).toContain('CLASSROOM_INACTIVE');
      }
    });

    test('D-09c: elegir un aula inactiva se rechaza (classroom_inactive), ni confirmando, y no cambia nada', async () => {
      const sin = await s.cambiarAula(attOrigen, inactiva.id, { confirmar: false });
      const conf = await s.cambiarAula(attOrigen, inactiva.id, { confirmar: true });
      const fila = await s.filaAsistencia(attOrigen);
      const trans = (await s.transiciones()).filter((t) => t.staff_attendance_id === attOrigen);
      informar('STAFF-D-09c', `sin confirmar=${sin.json.error}; confirmando=${conf.json.error}; aula de la asistencia=${fila.classroom_id === origen.id ? 'origen' : 'OTRA'}; transiciones=${trans.length}`);
      expect(sin.json.success).toBe(false);
      expect(sin.json.error).toBe('classroom_inactive');
      expect(conf.json.success).toBe(false);
      expect(conf.json.error).toBe('classroom_inactive');
      expect(fila.classroom_id, 'la asistencia no cambia de aula').toBe(origen.id);
      expect(trans, 'no se registra transición').toHaveLength(0);
    });

    test('D-06: con el forzamiento activo y el origen sin cobertura el cambio se bloquea, ni confirmando', async () => {
      await s.forzamiento({ staff: true });
      const v = await s.validarRatio(origen.id, 'clock_out');
      const sin = await cambio(false);
      const conf = await cambio(true);
      const fila = await s.filaAsistencia(attOrigen);
      informar('STAFF-D-06', `origen: personal=${v.current_staff}, niños=${v.current_children}; sin confirmar=${sin.json.error}; confirmando=${conf.json.error}; aula de la asistencia=${fila.classroom_id === origen.id ? 'origen' : 'OTRA'}`);
      expect(sin.json.success).toBe(false);
      expect(sin.json.error).toBe('origin_understaffed');
      expect(conf.json.success).toBe(false);
      expect(conf.json.error).toBe('origin_understaffed');
      expect(fila.classroom_id, 'la asistencia no cambia de aula').toBe(origen.id);
      expect((await s.transiciones()).filter((t) => t.staff_attendance_id === attOrigen), 'no se registra transición').toHaveLength(0);
    });

    test('D-07: con el forzamiento inactivo el cambio pide confirmación y, confirmado, se completa', async () => {
      await s.forzamiento({ staff: false });
      const sin = await cambio(false);
      const fila1 = await s.filaAsistencia(attOrigen);
      const conf = await cambio(true);
      informar('STAFF-D-07', `sin confirmar=${sin.json.error}; confirmando: éxito=${conf.json.success}`);
      expect(sin.json.success).toBe(false);
      expect(sin.json.error).toBe('ratio_confirmation_required');
      expect(fila1.classroom_id, 'sin confirmar no cambia').toBe(origen.id);
      expect(conf.json.success, JSON.stringify(conf.json).slice(0, 300)).toBe(true);
    });

    test('D-01..D-05 y D-08: el cambio no crea otro clock-in, conserva la hora y las asignaciones, deja traza y el clock-out va al aula nueva', async () => {
      const fila = await s.filaAsistencia(attOrigen);
      const hoy = await s.asistenciasDeHoy();
      const trans = (await s.transiciones()).filter((t) => t.staff_attendance_id === attOrigen);
      const despues = { origen: (await s.validarRatio(origen.id, 'clock_in')).current_staff, destino: (await s.validarRatio(destino.id, 'clock_in')).current_staff };
      const asignaciones = await activas();
      const co = await s.salir(attOrigen, ini + 40);
      informar('STAFF-D-01', `asistencias de hoy=${hoy.length}`);
      informar('STAFF-D-02', `entry_time antes=${antes.entrada}; después=${fila.entry_time}`);
      informar('STAFF-D-03', `asignaciones activas iguales=${JSON.stringify(antes.asignaciones) === JSON.stringify(asignaciones)}`);
      informar('STAFF-D-04', `transiciones=${trans.length}; ratio_warning=${trans[0] && trans[0].ratio_warning}; ratio_enforced=${trans[0] && trans[0].ratio_enforced}; motivo=${trans[0] && trans[0].reason}`);
      informar('STAFF-D-05', `aula de la asistencia=${fila.classroom_id === destino.id ? 'destino' : 'OTRA'}; clock-out: ${co.ok ? 'registrado' : (co.json && co.json.details) || co.error}`);
      informar('STAFF-D-08', `personal en el origen ${antes.origen}→${despues.origen}; en el destino ${antes.destino}→${despues.destino}`);
      expect(hoy, 'D-01: sigue habiendo una sola asistencia del día').toHaveLength(1);
      expect(fila.entry_time, 'D-02: la hora original de clock-in no cambia').toBe(antes.entrada);
      expect(asignaciones, 'D-03: la asignación estructural no cambia').toEqual(antes.asignaciones);
      expect(trans, 'D-04: una transición registrada').toHaveLength(1);
      expect(trans[0].from_classroom.id).toBe(origen.id);
      expect(trans[0].to_classroom.id).toBe(destino.id);
      expect(trans[0].transitioned_at).toBeTruthy();
      expect(trans[0].transitioned_by, 'D-04: quién hizo el cambio').toBeTruthy();
      expect(String(trans[0].actor_email).toLowerCase()).toBe(String(process.env.USER).toLowerCase());
      expect(trans[0].reason).toBe('QA automatizado');
      expect(fila.classroom_id, 'D-05: la asistencia queda en el aula nueva').toBe(destino.id);
      // El clock-out se evalúa en el aula nueva: el rechazo del registro pendiente nombra el aula destino.
      if (!co.ok) expect(`${co.error}`, 'D-05: el clock-out se evalúa en el aula nueva').toContain(`classroom_id=${destino.id}`);
      expect([antes.origen, despues.origen], 'D-08: el staff deja de contarse en el origen').toEqual([1, 0]);
      expect([antes.destino, despues.destino], 'D-08: el staff se cuenta en el destino').toEqual([0, 1]);
    });
  });

  // ---------- E. Regla de negocio 1: el día debe ser uno de los configurados ----------
  test.describe('E. Día configurado', () => {
    test.beforeAll(async () => { await s.limpiarDia(); });
    test.afterAll(async () => { await s.limpiarDia(); let g = await horarioBase().catch(() => ({})); if (!g.ok) g = await horarioBase(); expect(g.ok, 'restaurar el horario temporal').toBe(true); });

    test('E-01: si hoy no está entre los días del staff, el clock-in se rechaza y no crea asistencia', async () => {
      const g = await s.guardarHorario(s.semana(false, ini, fin));
      expect(g.ok, JSON.stringify(g.json)).toBe(true);
      const v = await s.validarHorario('clock_in', aHora(ini + 5));
      const r = await s.entrar(ini + 5, vacia.id);
      informar('STAFF-E-01', `hoy no trabaja: validación=${v.reason}; registro=${r.ok ? 'ACEPTADO' : `HTTP ${r.status} ${r.json && r.json.hint}`}`);
      expect(v.reason).toBe('staff_not_scheduled_today');
      rechazo(r, 'staff_not_scheduled_today');
      expect(await s.asistenciasDeHoy()).toHaveLength(0);
    });

    test('E-02: un día que no está entre los configurados se rechaza en cualquier fecha', async () => {
      const res = {};
      for (const fecha of [sumarDias(1), sumarDias(2), proximo(6), proximo(0)]) {
        const v = await s.validarHorario('clock_in', aHora(ini + 5), fecha);
        res[fecha] = v.reason;
        expect(v.reason, fecha).toBe('staff_not_scheduled_today');
      }
      informar('STAFF-E-02', `staff que solo trabaja hoy; otras fechas: ${JSON.stringify(res)}`);
    });

    test('E-03: sin horario propio y con la escuela cerrada ese día (domingo) el clock-in se rechaza', async () => {
      await s.quitarHorario();
      const fecha = proximo(0);
      const v = await s.validarHorario('clock_in', '10:00:00', fecha);
      informar('STAFF-E-03', `sin horario propio, ${fecha} (domingo): ${v.reason}`);
      expect(v.allowed).toBe(false);
      expect(v.reason).toBe('school_closed_on_day');
    });

    test('E-04: sin horario propio rigen las horas del colegio, también el sábado', async () => {
      const sabado = proximo(6);
      const abre = await s.validarHorario('clock_in', '08:00:00', sabado);
      expect(abre.windowStart, 'el sábado la escuela tiene horario').toBeTruthy();
      const dentro = await s.validarHorario('clock_in', aHora(Math.floor((aMin(abre.windowStart) + aMin(abre.windowEnd)) / 2)), sabado);
      const fuera = await s.validarHorario('clock_in', aHora(aMin(abre.windowEnd) + 1), sabado);
      informar('STAFF-E-04', `sábado ${sabado}: ventana ${abre.windowStart}–${abre.windowEnd}; dentro=${dentro.allowed} (${dentro.source}); fuera=${fuera.reason}`);
      expect(dentro.allowed).toBe(true);
      expect(dentro.source).toBe('school');
      expect(fuera.allowed).toBe(false);
      expect(fuera.reason).toBe('outside_school_hours');
    });

    test('A-07 y A-08: sin horario propio rigen las horas del colegio también hoy', async () => {
      const v = await s.ventanaEscuela();
      const dentro = await s.validarHorario('clock_in', aHora(Math.floor((v.abre + v.cierra) / 2)));
      const antes = await s.validarHorario('clock_in', aHora(v.abre - 1));
      const despues = await s.validarHorario('clock_in', aHora(v.cierra + 1));
      informar('STAFF-A-07', `sin horario propio, dentro de ${aHora(v.abre).slice(0, 5)}–${aHora(v.cierra).slice(0, 5)}: permitido=${dentro.allowed} (${dentro.source})`);
      informar('STAFF-A-08', `fuera del horario escolar: antes=${antes.reason}; después=${despues.reason}`);
      expect(dentro.allowed).toBe(true);
      expect(dentro.source).toBe('school');
      expect(antes.reason).toBe('outside_school_hours');
      expect(despues.reason).toBe('outside_school_hours');
    });
  });
});
