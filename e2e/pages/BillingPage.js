const { expect } = require('@playwright/test');
const { apiRequest } = require('../utils/api');
const { resolveSchoolId } = require('../utils/school');
const { getModal, getFormFieldByLabel } = require('../utils/helpers');

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
    await this.page.goto(route, { waitUntil: 'domcontentloaded' });
  }
 // TODO: Creo que hay funciones redundantes que ya playwright otorga, como waitForLoad, etc no creo que sea necesario, mejor seria usar las que ya da palywright, no reinventar la rueda
  async waitForLoad(text) {
    const body = this.page.locator('body');
    await expect(body).toContainText(text);
    await expect(body).not.toContainText('Loading...').catch(() => {});
  }

  async waitForText(text) {
    await expect(this.page.locator('body')).toContainText(text);
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

  /**
   * Pagos (tabla `payments`, no `payment_transactions`) de una factura.
   * Es donde vive `bank_name` según LBC-533 — `payment_transactions` es sólo
   * el log de la pasarela y no lleva esa columna.
   */
  async getPaymentByInvoice(invoiceId) {
    return await this._apiRequest(
      `/rest/v1/payments?invoice_id=eq.${invoiceId}&select=id,payment_number,amount,status,payment_method,bank_name,reference_number&limit=5`
    );
  }

  async cleanupPayment(paymentId) {
    return await this._apiRequest(`/rest/v1/payments?id=eq.${paymentId}`, 'DELETE');
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

  // ---- Settings de métodos de pago (LBC-533) ------------------------------

  /** Fila cruda de school_settings del colegio del usuario. */
  async getSchoolSettings() {
    const res = await this._apiRequest(
      `/rest/v1/school_settings?${await this._school()}&select=payment_method_card_enabled,payment_method_cash_enabled,payment_method_bank_transfer_enabled,payment_method_check_enabled,payment_method_ach_enabled`
    );
    return res.json && res.json[0] ? res.json[0] : null;
  }

  async patchSchoolSettings(patch) {
    return await this._apiRequest(`/rest/v1/school_settings?${await this._school()}`, 'PATCH', patch);
  }

  // ---- Cobro recurrente (LBC-533) -----------------------------------------

  /**
   * Busca una factura pagable (pending/partial/overdue) del colegio que tenga
   * al menos un item recurrente (ciclo 1 con contrato, o ciclo 2+ generado por
   * cron). No reproduce la regla de bloqueo completa (eso vive en el backend,
   * fuera de alcance): sólo localiza un candidato para verificar el bloqueo
   * observable en la UI.
   */
  async findPayableInvoiceWithRecurringItem() {
    const items = await this._apiRequest(
      `/rest/v1/invoice_items?or=(is_recurring.eq.true,parent_invoice_item_id.not.is.null)&select=invoice_id&limit=200`
    );
    const invoiceIds = [...new Set((items.json || []).map(i => i.invoice_id).filter(Boolean))];
    if (invoiceIds.length === 0) return null;

    const idList = invoiceIds.slice(0, 80).join(',');
    const invoices = await this._apiRequest(
      `/rest/v1/invoices?id=in.(${idList})&${await this._school()}&status=in.(pending,partial,overdue)&select=id,invoice_number&limit=1`
    );
    return invoices.json && invoices.json[0] ? invoices.json[0] : null;
  }

  // ---- Modal de registro de pago (LBC-533) --------------------------------

  /**
   * Busca en el listado de facturas. Sin esto una factura recién creada (o
   * cualquiera fuera de la primera página) puede no estar en el DOM todavía.
   */
  async searchInvoices(text) {
    const box = this.page.getByPlaceholder('Search invoices...');
    await box.fill(text);
    await expect(this.invoiceRow(text).or(this.page.getByText('No invoices found'))).toBeVisible();
  }

  /** Fila de la tabla de facturas identificada por su número exacto. */
  invoiceRow(invoiceNumber) {
    return this.page.locator('tr', { has: this.page.getByRole('link', { name: invoiceNumber, exact: true }) });
  }

  async payButtonStateInList(invoiceNumber) {
    await this.searchInvoices(invoiceNumber);
    const btn = this.invoiceRow(invoiceNumber).getByRole('button', { name: 'Pay' });
    return { disabled: await btn.isDisabled(), title: await btn.getAttribute('title') };
  }

  async openPaymentModalFromList(invoiceNumber) {
    await this.searchInvoices(invoiceNumber);
    await this.invoiceRow(invoiceNumber).getByRole('button', { name: 'Pay' }).click();
    await expect(getModal(this.page)).toBeVisible();
  }

  /** Estado (disabled + title) de los botones de registro en /invoices/{id}/payments. */
  async registerPaymentButtonStates() {
    // goto() sólo espera domcontentloaded: la SPA sigue mostrando "Loading..."
    // mientras trae la factura por su cuenta. Sin esto, con la red lenta del
    // ambiente, se llega a leer los botones antes de que existan.
    await expect(this.page.getByRole('heading', { name: 'Payment History' })).toBeVisible({ timeout: 45000 });
    const top = this.page.getByRole('button', { name: 'Register Payment' });
    const first = this.page.getByRole('button', { name: 'Register First Payment' });
    const state = async (loc) => (await loc.count()) > 0
      ? { present: true, disabled: await loc.first().isDisabled(), title: await loc.first().getAttribute('title') }
      : { present: false };
    return { registerPayment: await state(top), registerFirstPayment: await state(first) };
  }

  async selectPaymentMethod(label) {
    const select = getFormFieldByLabel(this.page, 'Payment Method');
    await select.selectOption({ label });
  }

  async selectedPaymentMethodLabel() {
    const select = getFormFieldByLabel(this.page, 'Payment Method');
    return await select.locator('option:checked').textContent();
  }

  async selectFirstPaidBy() {
    const select = getFormFieldByLabel(this.page, 'Paid By');
    // El combo arranca en "Loading family members..." (deshabilitado) hasta
    // que resuelve una consulta aparte; con la red lenta del ambiente puede
    // superar el timeout de acción por defecto (60s) sin ser un error real.
    await expect(select, 'El combo Paid By debe salir de "Loading family members..."').toBeEnabled({ timeout: 90000 });
    await select.selectOption({ index: 1 });
  }

  async clickPayFullBalance() {
    await getModal(this.page).getByText('Pay full balance').click();
  }

  /**
   * Avanza desde el primer paso del modal (monto/método/pagador/fecha).
   * El botón cambia de texto según el método: pasarela -> "Continue to
   * Payment" (deriva al diálogo online); manual -> "Review Order Summary".
   */
  async proceedFromAmountStep() {
    const modal = getModal(this.page);
    const btn = modal.getByRole('button', { name: /^(Continue to Payment|Review Order Summary)$/ });
    const label = (await btn.textContent())?.trim();
    await btn.click();
    return label;
  }

  async fillReference(value) {
    await getFormFieldByLabel(this.page, 'Reference Number').fill(value);
  }

  async fillBank(value) {
    await getFormFieldByLabel(this.page, 'Bank').fill(value);
  }

  async clickRegisterPayment() {
    await getModal(this.page).getByRole('button', { name: 'Register Payment' }).click();
  }

  async clickCancelPaymentModal() {
    await getModal(this.page).getByRole('button', { name: 'Cancel' }).click();
  }

  referenceRequiredError() {
    return getModal(this.page).getByText('A reference number is required to record this payment');
  }

  bankRequiredError(methodLabel) {
    return getModal(this.page).getByText(`The bank is required for ${methodLabel} payments`);
  }

  // ---- Listado de Pagos (LBC-533) ------------------------------------------

  async gotoPaymentsList() {
    await this.goto('/admin/billing/payments');
  }

  /**
   * Busca en el listado de Pagos (por # de pago, factura, familia o niño). La
   * tabla no tiene columna "Reference": el filtro narrowa por ese campo aun
   * cuando no se ve en pantalla, así que no hay texto visible fiable contra
   * el cual esperar. Se usa el contador "Showing N payment(s)" en su lugar.
   */
  async searchPayments(text) {
    const box = this.page.getByPlaceholder(/Search by payment/i);
    await box.fill(text);
    await expect(this.page.getByText(/Showing \d+ payments?/)).toBeVisible();
  }

  /** Fila del listado de Pagos que contiene el texto dado (referencia, familia, etc.). */
  paymentsListRow(text) {
    return this.page.locator('table tbody tr', { hasText: text });
  }
}

module.exports = { BillingPage };
