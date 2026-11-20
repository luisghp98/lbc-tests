const { test, expect } = require('@playwright/test');
const { asUser, anon, rest, request } = require('../../utils/rest');
const { QaCleanup, QA_PREFIX, letters } = require('../../utils/qa');
const { png } = require('../../utils/imagen');
const { informar } = require('../../utils/informe');

// Pruebas "sin formulario": la API se llama directo, saltándose las validaciones del cliente.
// Lo que no cumple y no está en los criterios de la historia se informa como mejora (no como defecto).
// Se ejecutan en local: el repositorio es público y sus fallos quedarían en los logs.
const MB = 1024 * 1024;

test.describe('CP-ONB-API: seguridad y validaciones del servidor', { tag: '@onboarding @seguridad' }, () => {
  test.setTimeout(600_000);

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

  // Carpeta del almacenamiento donde se guardan las fotos de niños de prueba (se toma de una foto QA existente).
  const carpetaDeFotos = async () => {
    const f = await rest('children', { headers, query: `profile_picture_url=not.is.null&last_name=like.${QA_PREFIX}*&select=profile_picture_url&limit=1` });
    const url = f.json && f.json[0] && f.json[0].profile_picture_url;
    const m = url && String(url).match(/\/storage\/v1\/object\/(?:public|sign|authenticated)?\/?([^/?]+)\/([^?]+)$/);
    if (!m) return null;
    return { bucket: m[1], carpeta: m[2].slice(0, m[2].lastIndexOf('/')) };
  };
  const subir = async (destino, nombre, cuerpo, tipo) => {
    const res = await request(`/storage/v1/object/${destino.bucket}/${destino.carpeta}/${nombre}`, {
      method: 'POST', body: cuerpo, timeoutMs: 400_000, headers: { ...headers, 'Content-Type': tipo, 'x-upsert': 'false' },
    });
    return res.status;
  };
  const borrar = (destino, nombres) => (nombres.length
    ? request(`/storage/v1/object/${destino.bucket}`, { method: 'DELETE', headers: { ...headers, 'Content-Type': 'application/json' }, body: { prefixes: nombres.map((n) => `${destino.carpeta}/${n}`) } })
    : null);

  test.beforeAll(async () => {
    headers = await asUser();
    schoolId = (await rest('staff', { headers, query: 'limit=1&select=school_id' })).json[0].school_id;
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

  test('CP-ONB-API-05: el almacenamiento rechaza fotos de más de 5 MiB subidas directo', async () => {
    const destino = await carpetaDeFotos();
    test.skip(!destino, 'No hay una foto de prueba guardada de la que tomar la carpeta del almacenamiento');
    const subidos = [];
    try {
      const nombre = (k) => `qa-lbc1702-${k}-${Date.now()}.png`;
      const control = nombre('1mb');
      const estadoControl = await subir(destino, control, png(1 * MB), 'image/png');
      expect(estadoControl, 'control: una foto de 1 MiB debe poder subirse').toBeLessThan(300);
      subidos.push(control);
      const resultados = {};
      for (const [etiqueta, bytes] of [['5,1 MiB', 5.1 * MB], ['6 MiB', 6 * MB]]) {
        const n = nombre(etiqueta.replace(/\D/g, ''));
        const st = await subir(destino, n, png(bytes), 'image/png');
        resultados[etiqueta] = st;
        if (st < 300) subidos.push(n);
      }
      const aceptadas = Object.entries(resultados).filter(([, st]) => st < 300).map(([k]) => k);
      informar('CP-ONB-API-05', `subida directa de 1 MiB aceptada; ${Object.entries(resultados).map(([k, st]) => `${k}: ${st < 300 ? 'aceptada' : 'rechazada'} (HTTP ${st})`).join('; ')}`);
      expect(aceptadas, 'el servidor debe rechazar fotos de más de 5 MiB').toEqual([]);
    } finally {
      // Si la limpieza falla (por ejemplo por un tiempo de espera de red) no debe tapar el error o el resultado de la prueba.
      try { await borrar(destino, subidos); } catch (e) { console.log(`[API-05] no se pudieron borrar los archivos de prueba: ${e.message}`); }
    }
  });

  test('CP-ONB-API-06: el almacenamiento rechaza archivos que no son imagen subidos directo', async () => {
    const destino = await carpetaDeFotos();
    test.skip(!destino, 'No hay una foto de prueba guardada de la que tomar la carpeta del almacenamiento');
    // Se sube primero un archivo de texto (inocuo y diminuto); solo si el servidor lo rechaza se prueban los otros tipos.
    // Si lo acepta, queda un archivo que quizá el usuario no pueda borrar: por eso se detiene en el primero aceptado.
    const casos = [
      ['txt', 'text/plain', Buffer.from('qa')],
      ['pdf', 'application/pdf', Buffer.from('%PDF-1.4 qa')],
      ['html', 'text/html', Buffer.from('<html><body>qa</body></html>')],
    ];
    const subidos = []; const aceptados = []; const probados = [];
    let borrado = null;
    try {
      for (const [ext, tipo, cuerpo] of casos) {
        const n = `qa-lbc1702-tipo-${Date.now()}.${ext}`;
        const st = await subir(destino, n, cuerpo, tipo);
        probados.push(ext);
        if (st < 300) { subidos.push(n); aceptados.push(`${ext} (${tipo})`); break; }
      }
    } finally {
      try { const r = await borrar(destino, subidos); borrado = r ? r.status : null; } catch (e) { console.log(`[API-06] no se pudo borrar el archivo de prueba: ${e.message}`); }
    }
    informar('CP-ONB-API-06', `tipos probados: ${probados.join(', ')}; archivos que no son imagen aceptados por el servidor: ${aceptados.length ? aceptados.join(', ') : 'ninguno'}${subidos.length ? `; borrado del archivo de prueba: ${borrado !== null && borrado < 300 ? 'sí' : `no (HTTP ${borrado}), queda un archivo diminuto en el almacenamiento`}` : ''}`);
    expect(aceptados, 'el servidor debe rechazar archivos que no son imagen').toEqual([]);
  });
});
