const { apiRequest } = require('../utils/api');
const { resolveSchoolId } = require('../utils/school');

/**
 * Page Object del módulo de Billing (facturas, pagos y cargos).
 *
 * Sin UUIDs ni credenciales quemadas: el colegio se resuelve desde la sesión
 * del usuario definido en el `.env` (ver utils/school.ts) y la autenticación la
 * maneja utils/api.ts, que también lee USER / PASSWORD / API_KEY del `.env`.
 */
class BillingPage {
  constructor(page) {
    this.page = page;
  }

  // ---- Contexto de la escuela --------------------------------------------

  /** school_id del usuario autenticado (resuelto una vez y cacheado). */
  async schoolId() {
    return await resolveSchoolId(this.page);
  }

  /** Filtro PostgREST del colegio, listo para concatenar en un query string. */
  async _school() {
    return `school_id=eq.${await this.schoolId()}`;
  }

  // ---- API Helpers --------------------------------------------------------

  /**
   * Petición REST autenticada. Devuelve { status, json } para mantener la forma
   * que esperan los tests.
   */
  async _apiRequest(path, method = 'GET', body) {
    try {
      const res = await apiRequest(this.page, {
        method,
        endpoint: path,
        payload: body,
      });
      let json = null;
      try { json = await res.json(); } catch { /* 204 y respuestas vacías */ }
      return { status: res.status(), json };
    } catch (e) {
      console.log(`  _apiRequest[${method} ${path}] falló: ${e.message}`);
      return { status: 0, json: null };
    }
  }

  async getInvoices(limit = 5) {
    return await this._apiRequest(
      `/rest/v1/invoices?${await this._school()}&select=id,total_amount,amount_paid,balance_due,status&limit=${limit}`
    );
  }

  async getPayments(limit = 5) {
    return await this._apiRequest(
      `/rest/v1/payment_transactions?${await this._school()}&select=id,amount,status,invoice_id&limit=${limit}`
    );
  }

  async getCharges(limit = 10) {
    return await this._apiRequest(
      `/rest/v1/charges?${await this._school()}&select=id,amount,charge_type,status,description,child_id&limit=${limit}`
    );
  }

  // ---- Navegación ---------------------------------------------------------

  async goto(route) {
    await this.page.goto(route, { waitUntil: 'domcontentloaded', timeout: 30000 });
  }

  async waitForLoad(text, timeout = 20000) {
    await this.page.waitForFunction(t => {
      const body = document.body;
      if (!body) return false;
      return !body.innerText.includes('Loading...') && body.innerText.toLowerCase().includes(t.toLowerCase());
    }, text, { timeout }).catch(() => { });
  }

  async waitForText(text, timeout = 15000) {
    await this.page.waitForFunction(t => document.body.innerText.includes(t), text, { timeout }).catch(() => { });
  }

  // ---- Lectura de la UI ---------------------------------------------------

  async getTableHeaders() {
    return await this.page.evaluate(() => {
      const ths = document.querySelectorAll('table th');
      return Array.from(ths).map(th => th.innerText.trim()).filter(t => t.length > 0);
    });
  }

  async getSelectOptions() {
    return await this.page.evaluate(() => {
      const selects = document.querySelectorAll('select');
      return Array.from(selects).map(sel => ({
        count: sel.options.length,
        options: Array.from(sel.options).map(o => o.text.trim()),
      }));
    });
  }

  async getTableRows() {
    return await this.page.evaluate(() => {
      const rows = document.querySelectorAll('table tbody tr');
      return Array.from(rows).map(tr => {
        const cells = tr.querySelectorAll('td');
        return Array.from(cells).map(td => td.innerText.trim());
      });
    });
  }

  async clickFirstRowLink() {
    const link = this.page.locator('table tr:first-child a, table tr:first-child button').first();
    const exists = await link.count() > 0;
    if (exists) await link.click();
    return exists;
  }

  async clickButton(text) {
    const loc = this.page.locator(`button:has-text("${text}"), a:has-text("${text}")`).first();
    if (await loc.count() > 0) {
      await loc.click();
      return true;
    }
    return false;
  }

  async isBadgeVisible(text) {
    return await this.page
      .locator(`span:has-text("${text}"), td:has-text("${text}")`)
      .first()
      .isVisible()
      .catch(() => false);
  }

  async fillInputByPlaceholder(placeholder, value) {
    const input = this.page.locator(`input[placeholder="${placeholder}"]`).first();
    if (await input.count() > 0) {
      await input.fill(String(value));
      return true;
    }
    return false;
  }

  // ---- CRUD de cargos -----------------------------------------------------

  async createChargeApi(data) {
    const defaults = {
      school_id: await this.schoolId(),
      description: 'E2E Test Charge ' + Date.now(),
      amount: 25.00,
      charge_type: 'damage',
      status: 'pending',
    };
    return await this._apiRequest('/rest/v1/charges', 'POST', { ...defaults, ...data });
  }

  async updateChargeStatus(chargeId, status) {
    return await this._apiRequest(`/rest/v1/charges?id=eq.${chargeId}`, 'PATCH', { status });
  }

  async getChargeById(chargeId) {
    const res = await this._apiRequest(
      `/rest/v1/charges?id=eq.${chargeId}&select=id,description,amount,status,charge_type,child_id,family_id`
    );
    return res.json && res.json.length > 0 ? res.json[0] : null;
  }

  async cleanupCharge(chargeId) {
    return await this._apiRequest(`/rest/v1/charges?id=eq.${chargeId}`, 'DELETE');
  }

  // ---- Facturas -----------------------------------------------------------

  async createInvoiceApi(data) {
    const now = new Date();
    const issueDate = now.toISOString().split('T')[0];
    const dueDate = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

    // Completar child_id y responsable financiero si no vinieron dados.
    if (!data.child_id || !data.responsible_family_member_id) {
      const famId = data.family_id;
      if (famId) {
        const [childRes, memberRes] = await Promise.all([
          this._apiRequest(`/rest/v1/child_families?family_id=eq.${famId}&select=child_id&limit=1`),
          this._apiRequest(`/rest/v1/family_members?family_id=eq.${famId}&select=id&limit=1`),
        ]);
        if (!data.child_id) data.child_id = childRes.json?.[0]?.child_id;
        if (!data.responsible_family_member_id) data.responsible_family_member_id = memberRes.json?.[0]?.id;
      }
    }

    const defaults = {
      school_id: await this.schoolId(),
      subtotal: 50.00,
      total_amount: 50.00,
      amount_paid: 0,
      balance_due: 50.00,
      status: 'pending',
      invoice_number: 'INV-E2E-' + Date.now(),
      currency: 'USD',
      issue_date: issueDate,
      due_date: dueDate,
    };
    return await this._apiRequest('/rest/v1/invoices', 'POST', { ...defaults, ...data });
  }

  async getInvoiceById(invoiceId) {
    const res = await this._apiRequest(
      `/rest/v1/invoices?id=eq.${invoiceId}&select=id,invoice_number,total_amount,amount_paid,balance_due,status,family_id`
    );
    return res.json && res.json.length > 0 ? res.json[0] : null;
  }

  /** Facturas del colegio que admiten pago (pendientes o parciales). */
  async getPayableInvoices(limit = 5) {
    return await this._apiRequest(
      `/rest/v1/invoices?${await this._school()}&status=in.(pending,partial,overdue)&select=id,invoice_number,total_amount,status&limit=${limit}`
    );
  }

  async cleanupInvoice(invoiceId) {
    return await this._apiRequest(`/rest/v1/invoices?id=eq.${invoiceId}`, 'DELETE');
  }

  // ---- Pagos --------------------------------------------------------------

  async processPaymentApi(data) {
    const defaults = {
      school_id: await this.schoolId(),
      amount: 50.00,
      status: 'succeeded',
      currency: 'USD',
    };
    return await this._apiRequest('/rest/v1/payment_transactions', 'POST', { ...defaults, ...data });
  }

  async getPaymentByInvoice(invoiceId) {
    return await this._apiRequest(
      `/rest/v1/payment_transactions?invoice_id=eq.${invoiceId}&select=id,amount,status,created_at,provider&limit=5`
    );
  }

  // ---- Familias y niños ---------------------------------------------------

  async getFirstFamily() {
    const res = await this._apiRequest(
      `/rest/v1/families?${await this._school()}&select=id,family_name&limit=1`
    );
    return res.json && res.json.length > 0 ? res.json[0] : null;
  }

  /** Devuelve el primer niño asociado a una familia, o null. */
  async getFirstChildOfFamily(familyId) {
    const res = await this._apiRequest(
      `/rest/v1/child_families?family_id=eq.${familyId}&select=child_id&limit=1`
    );
    return res.json?.[0]?.child_id || null;
  }

  /**
   * Devuelve una pareja { family, childId } utilizable del colegio del usuario,
   * recorriendo varias familias hasta encontrar una que tenga niño asociado.
   */
  async getFamilyWithChild() {
    const res = await this._apiRequest(
      `/rest/v1/families?${await this._school()}&select=id,family_name&limit=10`
    );
    const familias = res.json || [];
    for (const family of familias) {
      const childId = await this.getFirstChildOfFamily(family.id);
      if (childId) return { family, childId };
    }
    return null;
  }
}

module.exports = { BillingPage };
