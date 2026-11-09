const { rest } = require('./rest');

// Los nombres solo admiten letras, espacios, guiones y apóstrofes: el prefijo lleva guion.
const QA_PREFIX = 'QA-Lbc-';

const letters = (n = 6) =>
  Array.from({ length: n }, () => 'abcdefghijklmnopqrstuvwxyz'[Math.floor(Math.random() * 26)]).join('');

const qaChild = (overrides = {}) => ({
  firstName: 'QA-Child',
  lastName: `${QA_PREFIX}${letters()}`,
  gender: 'Male',
  ...overrides,
});

const qaEmail = () => `qa.lbc1702.${letters(8)}@example.com`;

/**
 * Registro de lo creado por los tests y limpieza al final.
 * Solo toca niños cuyo apellido empieza por "QA-" (comprobado antes de borrar).
 */
class QaCleanup {
  constructor() {
    this.childIds = new Set();
  }

  trackChild(id) {
    if (id) this.childIds.add(id);
  }

  async removeChild(headers, id) {
    const got = await rest('children', { headers, query: `id=eq.${id}&select=id,last_name` });
    const child = got.json && got.json[0];
    if (!child || !String(child.last_name).startsWith(QA_PREFIX)) {
      console.log(`[QA cleanup] omitido ${id}: no es un niño QA`);
      return false;
    }
    const invoices = await rest('invoices', { headers, query: `child_id=eq.${id}&select=id` });
    for (const inv of invoices.json || []) {
      await rest('invoice_items', { method: 'DELETE', headers, query: `invoice_id=eq.${inv.id}` });
      await rest('invoices', { method: 'DELETE', headers, query: `id=eq.${inv.id}` });
    }
    await rest('child_financial_responsibles', { method: 'DELETE', headers, query: `child_id=eq.${id}` });
    await rest('child_families', { method: 'DELETE', headers, query: `child_id=eq.${id}` });
    // Las matrículas no se pueden borrar: el niño se da de baja y se oculta (mismo patrón que la suite anterior).
    const today = new Date().toISOString().slice(0, 10);
    const res = await rest('children', {
      method: 'PATCH', headers, query: `id=eq.${id}`,
      body: { status: 'inactive', deleted_at: new Date().toISOString(), withdrawal_date: today },
    });
    return res.status < 300;
  }

  /** Borra lo registrado por este run. */
  async run(headers) {
    const results = [];
    for (const id of this.childIds) results.push(await this.removeChild(headers, id));
    console.log(`[QA cleanup] niños retirados: ${results.filter(Boolean).length}/${results.length}`);
    this.childIds.clear();
  }

  /** Red de seguridad: restos de corridas interrumpidas (apellido QA-*, sin dar de baja). */
  async sweep(headers) {
    const left = await rest('children', { headers, query: `last_name=ilike.${QA_PREFIX}*&deleted_at=is.null&select=id` });
    for (const c of left.json || []) await this.removeChild(headers, c.id);
    console.log(`[QA sweep] restos retirados: ${(left.json || []).length}`);
  }
}

module.exports = { QA_PREFIX, letters, qaChild, qaEmail, QaCleanup };
