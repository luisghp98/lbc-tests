const { test, expect } = require('@playwright/test');
const { loginViaUI } = require('../../utils/auth');
const { expectToast, getFormFieldByLabel, getModal } = require('../../utils/helpers');
const { BillingPage } = require('../../pages/BillingPage');
const { SettingsPage, PAYMENT_METHOD_LABELS } = require('../../pages/SettingsPage');

/**
 * LBC-533: Experiencia de Pagos en Web.
 *
 * Cubre la HU: métodos de pago configurables por escuela (Settings), el
 * selector de Facturas que sólo ofrece los métodos activos, banco obligatorio
 * para Check/Transferencia, el listado de Pagos con Method/Bank, y el bloqueo
 * del botón Pay en facturas con cobro recurrente.
 *
 * Fuera de alcance (por decisión explícita): la migración SQL, la validación
 * server-side de createPayment más allá de lo observable en la UI, y la
 * lógica exacta de detección de recurrencia (getRecurringPaymentLock) — para
 * el módulo 5 sólo se verifica que el bloqueo sea observable en la UI para
 * una factura con al menos un item recurrente, sin reproducir esa regla.
 */

// Sin mode:'serial' a propósito: CP-533-02 y CP-533-04 ejercitan el botón
// "Save Changes" real, que a la fecha de esta corrida no persiste ningún
// cambio (ver nota en CP-533-02). Si alguno falla, el resto de la suite debe
// seguir corriendo igual — sólo CP-533-08/CP-533-10 dependen del orden, y con
// workers:1 (fijado en playwright.config.ts) los tests de un mismo archivo se
// siguen ejecutando en el orden en que están declarados.
test.describe('CP-533: Experiencia de Pagos en Web (LBC-533)', {
  tag: '@billing @settings @cp-533 @lbc-533',
}, () => {
  let sharedContext;
  let sharedPage;
  let bil;
  let settings;
  let originalMethods;

  // Estado compartido entre CP-533-08 (crea el pago) y CP-533-10 (lo verifica
  // en el listado); test.describe.configure({mode:'serial'}) garantiza el orden.
  let checkPaymentFixture = null;

  test.beforeAll(async ({ browser }) => {
    sharedContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    sharedPage = await sharedContext.newPage();
    await loginViaUI(sharedPage);
    bil = new BillingPage(sharedPage);
    settings = new SettingsPage(sharedPage);

    originalMethods = await bil.getSchoolSettings();
    expect(originalMethods, 'La escuela debe tener una fila en school_settings').toBeTruthy();
  });

  test.afterAll(async () => {
    // Red de seguridad final: pase lo que pase durante la corrida, la escuela
    // debe quedar exactamente como estaba antes de tocar Payment Methods.
    if (originalMethods) {
      await bil.patchSchoolSettings({
        payment_method_card_enabled: originalMethods.payment_method_card_enabled,
        payment_method_cash_enabled: originalMethods.payment_method_cash_enabled,
        payment_method_bank_transfer_enabled: originalMethods.payment_method_bank_transfer_enabled,
        payment_method_check_enabled: originalMethods.payment_method_check_enabled,
        payment_method_ach_enabled: originalMethods.payment_method_ach_enabled,
      });
    }
    if (sharedContext) await sharedContext.close();
  });

  // ═══════════════════════════════════════════════════════════════
  // MÓDULO 1: Settings > School > Payment Methods (HU punto 1)
  // ═══════════════════════════════════════════════════════════════

  test('CP-533-01: La sección Payment Methods lista los 5 métodos con su toggle', async () => {
    await settings.goto();
    await settings.openPaymentMethodsSection();

    for (const label of PAYMENT_METHOD_LABELS) {
      await expect(settings._toggleFor(label), `El toggle de ${label} debe existir`).toBeVisible();
    }
  });

  test('CP-533-02: Desactivar un método y guardar persiste el cambio', async () => {
    // NOTA: al verificar esta suite (2026-08-20) se confirmó que el botón
    // "Save Changes" de Settings > School no dispara ningún request de
    // escritura — ni PATCH/POST a PostgREST ni a una API interna propia, sin
    // errores de consola. Se reprodujo también con Cash y Card, no es
    // específico de ACH. Este test ejercita el flujo real de UI tal como lo
    // pide la HU (LBC-533 punto 1) y por eso debe fallar mientras el bug siga
    // presente: es el comportamiento correcto de la prueba, no un defecto de
    // la prueba misma.
    try {
      await settings.goto();
      await settings.openPaymentMethodsSection();

      await settings.setMethodEnabled('ACH', false);
      await settings.clickSaveChanges();

      // Verificación por API: el cambio debe llegar a school_settings.
      await expect(async () => {
        const row = await bil.getSchoolSettings();
        expect(row.payment_method_ach_enabled, 'ACH debe quedar deshabilitado en BD').toBe(false);
      }).toPass({ timeout: 10000 });

      // Y debe sobrevivir a un reload (no es sólo estado local del formulario).
      await settings.goto();
      await settings.openPaymentMethodsSection();
      expect(await settings.isMethodEnabled('ACH'), 'ACH debe seguir deshabilitado tras recargar').toBe(false);
    } finally {
      // Pase lo que pase, la escuela debe quedar con ACH activo para el
      // resto de la suite y para cualquier otra prueba que corra en paralelo.
      await bil.patchSchoolSettings({ payment_method_ach_enabled: true });
    }
  });

  test('CP-533-03: Sin ningún método activo se muestra el banner de advertencia', async () => {
    await settings.goto();
    await settings.openPaymentMethodsSection();

    await settings.setAllMethods(false);
    await expect(settings.zeroMethodsBanner(), 'Debe verse el banner de "no hay métodos activos"').toBeVisible();

    // No se guarda: alcanza con verificar el estado client-side y restaurar.
    await settings.setAllMethods(true);
    for (const label of PAYMENT_METHOD_LABELS) {
      expect(await settings.isMethodEnabled(label), `${label} debe quedar activo antes de salir`).toBe(true);
    }
  });

  test('CP-533-04: Guardar sin métodos activos muestra un toast de advertencia', async () => {
    // Mismo defecto que CP-533-02: si "Save Changes" no persiste nada, este
    // toast de advertencia tampoco debería dispararse (no hay guardado que
    // advertir). Se deja como test real e independiente igual.
    try {
      await settings.goto();
      await settings.openPaymentMethodsSection();

      await settings.setAllMethods(false);
      await settings.clickSaveChanges();

      await expectToast(sharedPage, { type: 'warning' });
    } finally {
      // Restauración por API pase lo que pase: minimiza la ventana con el
      // colegio sin métodos de pago activos.
      await bil.patchSchoolSettings({
        payment_method_card_enabled: originalMethods.payment_method_card_enabled,
        payment_method_cash_enabled: originalMethods.payment_method_cash_enabled,
        payment_method_bank_transfer_enabled: originalMethods.payment_method_bank_transfer_enabled,
        payment_method_check_enabled: originalMethods.payment_method_check_enabled,
        payment_method_ach_enabled: originalMethods.payment_method_ach_enabled,
      });
    }
  });

  // ═══════════════════════════════════════════════════════════════
  // MÓDULO 2: Facturas - sólo métodos activos y parametrizados (HU punto 2)
  // ═══════════════════════════════════════════════════════════════

  test('CP-533-05: El modal de pago sólo ofrece los métodos habilitados en Settings', async () => {
    // Estado determinístico: sólo Cash y Check habilitados.
    await bil.patchSchoolSettings({
      payment_method_card_enabled: false,
      payment_method_cash_enabled: true,
      payment_method_bank_transfer_enabled: false,
      payment_method_check_enabled: true,
      payment_method_ach_enabled: false,
    });

    const family = await bil.getFirstFamily();
    expect(family, 'La escuela debe tener al menos una familia').toBeTruthy();
    const invRes = await bil.createInvoiceApi({ family_id: family.id, invoice_number: 'CP533-05-' + Date.now() });
    const invoice = invRes.json?.[0];
    expect(invoice, 'La factura de prueba debe crearse').toBeTruthy();

    try {
      await bil.goto('/admin/billing/invoices');
      await bil.openPaymentModalFromList(invoice.invoice_number);

      const select = getFormFieldByLabel(sharedPage, 'Payment Method');
      const options = (await select.locator('option').allTextContents()).map(t => t.trim());

      expect(options).toContain('Cash');
      expect(options).toContain('Check');
      expect(options, 'Card debe estar oculto: el método está deshabilitado').not.toContain('Card');
      expect(options, 'Bank Transfer debe estar oculto: el método está deshabilitado').not.toContain('Bank Transfer');
      expect(options, 'ACH debe estar oculto: el método está deshabilitado').not.toContain('ACH');

      await bil.clickCancelPaymentModal();
    } finally {
      await bil.cleanupInvoice(invoice.id);
      await bil.patchSchoolSettings({
        payment_method_card_enabled: originalMethods.payment_method_card_enabled,
        payment_method_cash_enabled: originalMethods.payment_method_cash_enabled,
        payment_method_bank_transfer_enabled: originalMethods.payment_method_bank_transfer_enabled,
        payment_method_check_enabled: originalMethods.payment_method_check_enabled,
        payment_method_ach_enabled: originalMethods.payment_method_ach_enabled,
      });
    }
  });

  // ═══════════════════════════════════════════════════════════════
  // MÓDULO 3: Banco obligatorio en Check / Transferencia (HU punto 4)
  // ═══════════════════════════════════════════════════════════════

  async function expectBankRequired(methodLabel) {
    const family = await bil.getFirstFamily();
    expect(family, 'La escuela debe tener al menos una familia').toBeTruthy();
    const invRes = await bil.createInvoiceApi({ family_id: family.id, invoice_number: `CP533-BANK-${methodLabel}-` + Date.now() });
    const invoice = invRes.json?.[0];
    expect(invoice, 'La factura de prueba debe crearse').toBeTruthy();

    try {
      await bil.goto('/admin/billing/invoices');
      await bil.openPaymentModalFromList(invoice.invoice_number);
      await bil.clickPayFullBalance();
      await bil.selectPaymentMethod(methodLabel);
      await bil.selectFirstPaidBy();
      const buttonLabel = await bil.proceedFromAmountStep();
      expect(buttonLabel, 'Un método offline debe llevar al resumen manual').toBe('Review Order Summary');

      await bil.fillReference('QA-' + Date.now());
      await bil.clickRegisterPayment();

      await expect(bil.bankRequiredError(methodLabel), `Debe exigirse el banco para ${methodLabel}`).toBeVisible();

      const invoiceAfter = await bil.getInvoiceById(invoice.id);
      expect(invoiceAfter.balance_due, 'La factura no debe haberse cobrado: falta el banco').toBe(invoice.balance_due);
      // No hace falta cerrar el modal: el próximo test navega con goto(), que
      // recarga la página entera. El paso 2 (Order Summary) además ya no
      // tiene botón "Cancel" — sólo "Back" — así que forzarlo aquí sería
      // frágil sin aportar nada a la limpieza.
    } finally {
      await bil.cleanupInvoice(invoice.id);
    }
  }

  test('CP-533-06: Pago con Check sin banco no se registra', async () => {
    await expectBankRequired('Check');
  });

  test('CP-533-07: Pago con Bank Transfer sin banco no se registra', async () => {
    await expectBankRequired('Bank Transfer');
  });

  test('CP-533-08: Pago con Check y banco completo se registra y persiste el banco', async () => {
    const family = await bil.getFirstFamily();
    expect(family, 'La escuela debe tener al menos una familia').toBeTruthy();
    const invRes = await bil.createInvoiceApi({ family_id: family.id, invoice_number: 'CP533-08-' + Date.now() });
    const invoice = invRes.json?.[0];
    expect(invoice, 'La factura de prueba debe crearse').toBeTruthy();

    const bankName = 'Banco QA ' + Date.now();
    const reference = 'REF-QA-' + Date.now();

    await bil.goto('/admin/billing/invoices');
    await bil.openPaymentModalFromList(invoice.invoice_number);
    await bil.clickPayFullBalance();
    await bil.selectPaymentMethod('Check');
    await bil.selectFirstPaidBy();
    const buttonLabel = await bil.proceedFromAmountStep();
    expect(buttonLabel).toBe('Review Order Summary');

    await bil.fillReference(reference);
    await bil.fillBank(bankName);
    await bil.clickRegisterPayment();

    // Éxito: el modal se cierra y la factura queda saldada.
    await expect(getModal(sharedPage)).toBeHidden({ timeout: 15000 });

    const invoiceAfter = await bil.getInvoiceById(invoice.id);
    expect(invoiceAfter.balance_due, 'La factura debe quedar saldada').toBe(0);

    const payRes = await bil.getPaymentByInvoice(invoice.id);
    const payment = payRes.json?.[0];
    expect(payment, 'Debe existir un registro en payments ligado a la factura').toBeTruthy();
    expect(payment.bank_name, 'El banco debe quedar persistido en el pago').toBe(bankName);

    checkPaymentFixture = { invoice, bankName, reference, payment };
  });

  // ═══════════════════════════════════════════════════════════════
  // MÓDULO 4: Listado de Pagos con Method/Bank (HU punto 5)
  // ═══════════════════════════════════════════════════════════════

  test('CP-533-09: El listado de Pagos incluye la columna de banco', async () => {
    await bil.gotoPaymentsList();
    await expect(sharedPage.locator('body')).toContainText('Payment #');
    const headers = await bil.getTableHeaders();
    const hasMethodOrBankColumn = headers.some(h => /method/i.test(h) || /bank/i.test(h));
    expect(hasMethodOrBankColumn, `La tabla debe traer una columna de método/banco. Encontradas: ${headers.join(', ')}`).toBeTruthy();
  });

  test('CP-533-10: El pago con Check muestra su banco en el listado', async () => {
    test.skip(!checkPaymentFixture, 'CP-533-08 no dejó un pago registrado para verificar');

    await bil.gotoPaymentsList();
    // La tabla no muestra columna "Reference": el filtro narrowa por ese
    // campo igual, así que buscando por la referencia debe quedar 1 sola fila.
    await bil.searchPayments(checkPaymentFixture.reference);
    const row = bil.paymentsListRow(checkPaymentFixture.payment.payment_number);
    await expect(row, 'El pago filtrado debe aparecer en el listado').toBeVisible();
    await expect(row, 'El banco debe verse bajo el método de pago').toContainText(checkPaymentFixture.bankName);

    // Limpieza: el pago y la factura de prueba ya cumplieron su propósito.
    await bil.cleanupPayment(checkPaymentFixture.payment.id);
    await bil.cleanupInvoice(checkPaymentFixture.invoice.id);
  });

  // ═══════════════════════════════════════════════════════════════
  // MÓDULO 5: Factura con cobro recurrente bloquea el pago (HU punto 6)
  // ═══════════════════════════════════════════════════════════════

  test('CP-533-11: El botón Pay está deshabilitado para una factura con cobro recurrente', async () => {
    const candidate = await bil.findPayableInvoiceWithRecurringItem();
    test.skip(!candidate, 'El colegio no tiene ninguna factura pagable con item recurrente para verificar el bloqueo');

    await bil.goto('/admin/billing/invoices');
    const state = await bil.payButtonStateInList(candidate.invoice_number);

    expect(state.disabled, 'El botón Pay debe estar deshabilitado en una factura con cobro recurrente').toBe(true);
    expect(state.title, 'Debe explicar por qué está bloqueado').toContain('billed automatically under an active recurring contract');
  });

  test('CP-533-12: Register Payment queda deshabilitado en el historial de la factura recurrente', async () => {
    const candidate = await bil.findPayableInvoiceWithRecurringItem();
    test.skip(!candidate, 'El colegio no tiene ninguna factura pagable con item recurrente para verificar el bloqueo');

    await bil.goto(`/admin/billing/invoices/${candidate.id}/payments`);
    const buttons = await bil.registerPaymentButtonStates();

    if (buttons.registerPayment.present) {
      expect(buttons.registerPayment.disabled, 'Register Payment debe estar deshabilitado').toBe(true);
    }
    if (buttons.registerFirstPayment.present) {
      expect(buttons.registerFirstPayment.disabled, 'Register First Payment debe estar deshabilitado').toBe(true);
    }
    expect(
      buttons.registerPayment.present || buttons.registerFirstPayment.present,
      'Debe existir al menos uno de los dos botones de registro de pago'
    ).toBe(true);
  });
});
