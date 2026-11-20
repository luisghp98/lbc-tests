const { rest } = require('./rest');

const arr = (r) => (Array.isArray(r.json) ? r.json : []);

/**
 * Métodos de pago vivos de los perfiles de prueba (el familiar que registra el wizard se llama "QA-Parent QA-Familiar").
 * Nunca incluye los de personas reales.
 */
async function metodosQA(headers) {
  const pm = arr(await rest('payment_methods', { headers, query: 'deleted_at=is.null&select=id,type,provider,profile_id,created_at&limit=500' }));
  const ids = [...new Set(pm.map((m) => m.profile_id).filter(Boolean))];
  const qa = new Set();
  for (let i = 0; i < ids.length; i += 40) {
    const perfiles = arr(await rest('profiles', { headers, query: `id=in.(${ids.slice(i, i + 40).join(',')})&select=id,first_name,last_name` }));
    for (const p of perfiles) if (p.first_name === 'QA-Parent' && p.last_name === 'QA-Familiar') qa.add(p.id);
  }
  return pm.filter((m) => qa.has(m.profile_id));
}

/**
 * Borra los métodos de pago de prueba en la pasarela y en la base de datos con los endpoints de administración.
 * Esos endpoints solo aceptan la sesión web del staff (cookie), por eso se llaman con la página ya autenticada.
 *  · Card (MX Merchant): DELETE /api/payments/mx-merchant/cards/<id>?schoolId=<escuela>
 *  · ACH (NMI):          DELETE /api/payments/nmi/vault/<id>?schoolId=<escuela>&organizationId=<organización>
 * Con `soloUno` borra un único método y se detiene (para comprobar el efecto antes de seguir).
 */
async function borrarMetodosQA(page, headers, { schoolId, organizationId, soloUno = false }) {
  const origen = new URL(page.url()).origin;
  const lista = await metodosQA(headers);
  const res = { total: lista.length, borrados: 0, fallos: [] };
  for (const m of soloUno ? lista.slice(0, 1) : lista) {
    const ruta = m.provider === 'nmi' || m.type === 'ach'
      ? `/api/payments/nmi/vault/${m.id}?schoolId=${schoolId}&organizationId=${organizationId}`
      : `/api/payments/mx-merchant/cards/${m.id}?schoolId=${schoolId}`;
    const r = await page.request.delete(origen + ruta);
    if (r.ok()) res.borrados += 1; else res.fallos.push(`${m.type}/${m.provider}: HTTP ${r.status()} ${(await r.text()).slice(0, 120)}`);
  }
  return res;
}

module.exports = { metodosQA, borrarMetodosQA };
