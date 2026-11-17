const { test, expect } = require('@playwright/test');
const { asUser, anon, rest } = require('../../utils/rest');
const { QaCleanup, QA_PREFIX, letters } = require('../../utils/qa');
const { informar } = require('../../utils/informe');

// Pruebas "sin formulario": la API se llama directo, saltándose las validaciones del cliente.
// Un resultado fuera de lo esperado es un hallazgo de seguridad o de validación en el servidor.
test.describe('CP-ONB-API: seguridad y validaciones del servidor', { tag: '@onboarding @seguridad' }, () => {
  test.setTimeout(180_000);

  const limpieza = new QaCleanup();
  let headers;
  let schoolId;

  const ninoValido = (extra = {}) => ({
    school_id: schoolId, first_name: 'QA-Child', last_name: `${QA_PREFIX}${letters()}`,
    birth_date: new Date(Date.now() - 4 * 365 * 86400000).toISOString().slice(0, 10), gender: 'Male', status: 'pending', ...extra,
  });

  // POST de un niño QA; si el servidor lo acepta, queda registrado para su limpieza.
  const crear = async (hdrs, cuerpo) => {
    const res = await rest('children', { method: 'POST', headers: hdrs, body: cuerpo });
    if (res.status === 201 && res.json && res.json[0]) limpieza.trackChild(res.json[0].id);
    return res;
  };

  test.beforeAll(async () => {
    headers = await asUser();
    const staff = await rest('staff', { headers, query: 'limit=1&select=school_id' });
    schoolId = staff.json[0].school_id;
    await limpieza.sweep(headers);
  });

  test.afterAll(async () => {
    await limpieza.run(await asUser());
  });

  test('CP-ONB-API-01: sin sesión no se leen ni se crean niños, matrículas ni facturas', async () => {
    for (const tabla of ['children', 'enrollments', 'invoices']) {
      const lectura = await rest(tabla, { headers: anon(), query: 'limit=1&select=id' });
      const sinDatos = lectura.status >= 400 || (Array.isArray(lectura.json) && lectura.json.length === 0);
      expect(sinDatos, `GET anónimo a ${tabla}: ${lectura.status}`).toBeTruthy();
    }
    const escritura = await crear(anon(), ninoValido());
    expect(escritura.status, 'POST anónimo a children').toBeGreaterThanOrEqual(400);
    informar('CP-ONB-API-01', `sin sesión: lecturas sin datos y escritura rechazada (HTTP ${escritura.status})`);
  });

  test('CP-ONB-API-02: un token inválido se rechaza', async () => {
    const falso = { ...anon(), Authorization: 'Bearer token.invalido.qa' };
    const res = await rest('children', { headers: falso, query: 'limit=1&select=id' });
    expect(res.status).toBe(401);
    informar('CP-ONB-API-02', `token inválido rechazado (HTTP ${res.status})`);
  });

  test('CP-ONB-API-03: el servidor rechaza datos que el formulario ya valida', async () => {
    const casos = {
      'apellido con dígitos y símbolos': ninoValido({ last_name: `${QA_PREFIX}${letters(3)}123<b>` }),
      'fecha de nacimiento futura': ninoValido({ birth_date: new Date(Date.now() + 365 * 86400000).toISOString().slice(0, 10) }),
      'género fuera de catálogo': ninoValido({ gender: 'XYZ' }),
      'sin nombre': ninoValido({ first_name: '' }),
    };
    const aceptados = [];
    for (const [nombre, cuerpo] of Object.entries(casos)) {
      const res = await crear(headers, cuerpo);
      if (res.status < 300) aceptados.push(nombre);
    }
    informar('CP-ONB-API-03', `el servidor aceptó ${aceptados.length} de ${Object.keys(casos).length} casos inválidos: ${aceptados.join('; ') || 'ninguno'}`);
    expect(aceptados, 'el servidor aceptó estos datos inválidos (falta validación en el servidor)').toEqual([]);
  });

  test('CP-ONB-API-04: no se puede crear un niño en una escuela ajena', async () => {
    const res = await crear(headers, ninoValido({ school_id: '00000000-0000-4000-8000-000000000001' }));
    expect(res.status, 'POST con school_id ajeno').toBeGreaterThanOrEqual(400);
    informar('CP-ONB-API-04', `creación en una escuela ajena rechazada (HTTP ${res.status})`);
  });
});
