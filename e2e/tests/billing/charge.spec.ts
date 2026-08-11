// e2e/charge.spec.ts
import { test, expect, BrowserContext, Page } from '@playwright/test';
import {
  clickTableAction,
  createCharge,
  debugLog,
  expectToast,
  findTableRow,
  getFieldValueByLabel,
  getModal,
  verifyFormFields,
} from '../../utils/helpers';
import { apiDelete, apiGet, apiPatch } from '../../utils/api';
import { loginViaUI } from '../../utils/auth';

test.describe('Create Charge', () => {
  let sharedContext: BrowserContext;
  let sharedPage: Page;

  // 0. Login - Una sola vez antes de todas las pruebas
  test.beforeAll(async ({ browser }) => {
    sharedContext = await browser.newContext();
    sharedPage = await sharedContext.newPage();
    await loginViaUI(sharedPage);
  });

  // Cerrar el contexto después de todas las pruebas
  test.afterAll(async () => {
    await sharedContext.close();
  });

  // 1. UI validation
  test('CP-CH-01 - Verify Create Charge UI', async () => {
    await sharedPage.goto('/admin/billing/charges/new');

    await expect(sharedPage.getByText('Create Charge').first()).toBeVisible();
    await expect(sharedPage.getByRole('textbox', { name: 'Search for a child...' })).toBeVisible();
    await expect(sharedPage.getByRole('textbox', { name: 'E.g., Late pickup charge - 30' })).toBeVisible();
    await expect(sharedPage.getByRole('spinbutton')).toBeVisible();
    await expect(sharedPage.locator('input[type="date"]')).toBeVisible();
    await expect(sharedPage.getByRole('textbox', { name: 'Additional details about the' })).toBeVisible();
    await expect(sharedPage.getByRole('button', { name: 'Create Charge' })).toBeVisible();
  });

  // 2. Required fields
  test('CP-CH-02 - Validate required fields', async () => {
    await sharedPage.goto('/admin/billing/charges/new');

    await sharedPage.getByRole('button', { name: 'Create Charge' }).click();

    await expect(sharedPage.getByText('Child is required')).toBeVisible();
    await expect(sharedPage.getByText('Selected child must have an')).toBeVisible();
    await expect(sharedPage.getByText('Description is required')).toBeVisible();
    await expect(sharedPage.getByText('Amount must be greater than')).toBeVisible();
  });

  // 3. Create successfully
  test('CP-CH-03 - Create charge successfully', async () => {
    const charge = await createCharge(sharedPage);

    await expect(sharedPage.getByRole('heading', { name: 'Pending' })).toBeVisible();
    await expect(sharedPage.getByText(charge.description)).toBeVisible();

    const dueDate = charge.due_date || new Date().toISOString().split('T')[0];
    const dueDateParts = dueDate.split('-');
    const formattedDate = `${dueDateParts[2]}/${dueDateParts[1]}/${dueDateParts[0]}`;
    await expect(sharedPage.getByText(formattedDate)).toBeVisible();

    if (charge.notes) {
      await expect(sharedPage.getByText(charge.notes)).toBeVisible();
    }
    await expect(sharedPage.getByText(`$${charge.amount}`)).toBeVisible();
  });

  // 4. Edit successfully
  test('CP-CH-04 - Edit charge fields', async () => {
    await sharedPage.goto('/admin/billing/charges');

    await clickTableAction(sharedPage, 'Edit');
    await expect(sharedPage.getByRole('heading', { name: 'Pending' })).toBeVisible();

    await verifyFormFields(sharedPage, [
      { label: 'Child' },
      { label: 'Charge Type' },
      { label: 'Description' },
      { label: 'Amount' },
      { label: 'Due Date' },
      { label: 'Additional Notes' },
      { label: 'Charge Status' }
    ], 'form');

    const newDescription = 'Late 50 minutes changed';
    const newAmount = '4.49';
    let newDueDate = new Date();
    newDueDate.setMonth(newDueDate.getMonth() + 1);
    const newDueDateStr = newDueDate.toISOString().split('T')[0];
    const newNotes = 'Aditional Notes Example';

    await sharedPage.getByRole('textbox').nth(2).click();
    await sharedPage.getByRole('textbox').nth(2).fill(newDescription);
    await sharedPage.getByRole('spinbutton').click();
    await sharedPage.getByRole('spinbutton').fill(newAmount);
    await sharedPage.locator('input[type="date"]').fill(newDueDateStr);
    await sharedPage.locator('textarea').click();
    await sharedPage.locator('textarea').fill(newNotes);

    await sharedPage.getByRole('button', { name: 'Save Charge' }).click();

    await expectToast(sharedPage, { type: 'success' });

    await expect(sharedPage.getByText(newDescription)).toBeVisible();
    const dueDateParts = newDueDateStr.split('-');
    const formattedDate = `${dueDateParts[2]}/${dueDateParts[1]}/${dueDateParts[0]}`;
    await expect(sharedPage.getByText(formattedDate)).toBeVisible();
    await expect(sharedPage.getByText(newNotes)).toBeVisible();
    await expect(sharedPage.getByText(`$${newAmount}`)).toBeVisible();
  });

  // 5. Delete from table (search by Status Pending)
  test('CP-CH-05 - Delete charge from Table (Pending)', async () => {
    await sharedPage.goto('/admin/billing/charges');

    await clickTableAction(sharedPage, 'Delete', { column: 'Status', value: 'Pending' });
    const modal = getModal(sharedPage);
    await modal.getByRole('button', { name: 'Delete' }).click();

    await expectToast(sharedPage, { type: 'success' });
  });

  // 6. Delete from charge view (extra)
  test('CP-CH-06 - Delete charge from Charge view', async () => {
    const charge = await createCharge(sharedPage);

    sharedPage.once('dialog', dialog => {
      debugLog(`Dialog message: ${dialog.message()}`);
      dialog.accept().catch(() => { });
    });

    await sharedPage.getByRole('button', { name: 'Delete' }).first().click();

    await expectToast(sharedPage, { type: 'success' });
  });

  test('CP-CH-07 - Change charge to Accepted and Invoice created', async () => {
    // 1. Crear un cargo y guardar su ID
    const charge = await createCharge(sharedPage);
    const chargeId = charge.id;

    // 2. Abrir el modal de aceptación
    await sharedPage.getByRole('button', { name: 'Accept' }).click();

    // 3. Completar el motivo y confirmar
    await sharedPage.getByRole('button', { name: 'Confirm Accept' }).click();
    await expect(sharedPage.getByText('A reason is required to accept')).toBeVisible();

    // 4. Capturar la fecha de vencimiento de la factura del modal
    const invoiceDueDateValue = await getFieldValueByLabel(sharedPage, 'Invoice Due Date');
    expect(invoiceDueDateValue, 'El campo Invoice Due Date debe tener un valor').not.toBeNull();
    debugLog('📅 Invoice Due Date (modal):', invoiceDueDateValue);

    await sharedPage.getByRole('textbox', { name: 'Enter the reason for this' }).fill('QA Test Accept');
    await sharedPage.getByRole('button', { name: 'Confirm Accept' }).click();

    // 5. Extraer número de factura del toast
    const toastMessage = await expectToast(sharedPage, { type: 'success' });
    const invoiceMatch = toastMessage.match(/(INV[^\s]*)/);
    expect(invoiceMatch, 'El toast debe contener un número de factura que comience con INV').not.toBeNull();
    const invoiceNumber = invoiceMatch![1];
    debugLog('🧾 Invoice Number:', invoiceNumber);

    // 6. Obtener el charge actualizado (incluyendo relaciones)
    const chargeResponse = await apiGet(
      sharedPage,
      `/rest/v1/charges?id=eq.${chargeId}&select=*,family:families(id,family_name,family_code),child:children(id,first_name,last_name)`
    );
    const chargeData = (await chargeResponse.json())[0];
    expect(chargeData, 'El cargo debe existir después de aceptar').toBeDefined();

    // 7. Obtener la factura recién creada
    const invoiceResponse = await apiGet(sharedPage, `/rest/v1/invoices?invoice_number=eq.${invoiceNumber}`);
    const invoiceData = (await invoiceResponse.json())[0];
    expect(invoiceData, `No se encontró la factura con número ${invoiceNumber}`).toBeDefined();

    // 8. Validaciones clave
    // 8.1. Fecha de vencimiento
    expect(invoiceData.due_date, 'La fecha de vencimiento de la factura debe coincidir con la del modal')
      .toBe(invoiceDueDateValue);

    // 8.2. Montos
    expect(invoiceData.subtotal, 'El subtotal debe ser el monto del cargo').toBe(chargeData.amount);
    expect(invoiceData.total_amount, 'El total debe ser el monto del cargo').toBe(chargeData.amount);
    expect(invoiceData.balance_due, 'El balance pendiente debe ser el total').toBe(chargeData.amount);
    expect(invoiceData.amount_paid, 'El monto pagado debe ser 0').toBe(0);
    expect(invoiceData.tax_amount, 'El impuesto debe ser 0').toBe(0);
    expect(invoiceData.discount_amount, 'El descuento debe ser 0').toBe(0);

    // 8.3. Relaciones y otros campos
    expect(invoiceData.child_id, 'El child_id debe coincidir').toBe(chargeData.child_id);
    expect(invoiceData.family_id, 'El family_id debe coincidir').toBe(chargeData.family_id);
    expect(invoiceData.currency, 'La moneda debe coincidir').toBe(chargeData.currency);
    expect(invoiceData.status, 'El estado de la factura debe ser "pending"').toBe('pending');

    // 9. Verificar la UI
    await expect(sharedPage.getByRole('heading', { name: 'Accepted' })).toBeVisible();

    debugLog('✅ Factura creada exitosamente y validada contra el cargo');
  });

  // 8. Change status to Waived
  test('CP-CH-08 - Change charge to Waived', async () => {
    await createCharge(sharedPage);

    await sharedPage.getByRole('button', { name: 'Waive' }).click();

    await sharedPage.getByRole('button', { name: 'Confirm Waive' }).click();
    await expect(sharedPage.getByText('A reason is required to waive')).toBeVisible();

    await sharedPage.getByRole('textbox', { name: 'Enter the reason for this' }).fill('QA Test Waive');
    await sharedPage.getByRole('button', { name: 'Confirm Waive' }).click();

    await expectToast(sharedPage, { type: 'success' });
    await expect(sharedPage.getByRole('heading', { name: 'Waived' })).toBeVisible();
  });

  // 9. Change status to Disputed
  test('CP-CH-09 - Change charge to Disputed', async () => {
    await createCharge(sharedPage);

    await sharedPage.getByRole('button', { name: 'Dispute' }).click();

    await sharedPage.getByRole('button', { name: 'Confirm Dispute' }).click();
    await expect(sharedPage.getByText('A reason is required to dispute')).toBeVisible();

    await sharedPage.getByRole('textbox', { name: 'Enter the reason for this' }).fill('QA Test Dispute');
    await sharedPage.getByRole('button', { name: 'Confirm Dispute' }).click();

    await expectToast(sharedPage, { type: 'success' });
    await expect(sharedPage.getByRole('heading', { name: 'Disputed' })).toBeVisible();
  });

  // ========== CP-CH-10 ==========
  test('CP-CH-10 - Eliminar un cargo pendiente vía API (DELETE) debe eliminarlo correctamente', async () => {
    // Crear un cargo pendiente (esto ya genera uno nuevo)
    const charge = await createCharge(sharedPage);
    const chargeId = charge.id;

    // (Opcional) Verificar que el botón Delete es visible en la UI, pero el test se enfoca en API
    // No es necesario porque el objetivo es probar la API directamente.

    // Obtener el estado actual del cargo (pre)
    const preDeleteGetResponse = await apiGet(sharedPage, `/rest/v1/charges?id=eq.${chargeId}`);
    const preData = await preDeleteGetResponse.json();

    // Intentar eliminar por API
    await apiDelete(sharedPage, `/rest/v1/charges?id=eq.${chargeId}`);

    // Obtener el estado después del DELETE (post)
    const posDeleteGetResponse = await apiGet(sharedPage, `/rest/v1/charges?id=eq.${chargeId}`);
    const postData = await posDeleteGetResponse.json();

    // Verificar que el cargo ya no existe (array vacío)
    expect(postData, 'El cargo pendiente debería haber sido eliminado de la base de datos').toHaveLength(0);
    // También podríamos comparar que no es igual al pre
    expect(preData).not.toEqual(postData);
  });

  // ========== CP-CH-11 ==========
  test('CP-CH-11 - No debe permitir la eliminación de un cargo Aceptado', async () => {
    await sharedPage.goto('/admin/billing/charges');
    const row = await findTableRow(sharedPage, { column: 'Status', value: 'Accepted' });
    await expect(
      row.getByRole('link', { name: 'Delete' }).or(row.getByRole('button', { name: 'Delete' })),
      'El botón Eliminar NO debe ser visible para un cargo Aceptado en la tabla'
    ).not.toBeVisible();

    await clickTableAction(sharedPage, 'View', { column: 'Status', value: 'Accepted' });
    await expect(sharedPage.getByRole('heading', { name: 'Charge Details' })).toBeVisible();
    await expect(
      sharedPage.getByRole('link', { name: 'Delete' }).or(sharedPage.getByRole('button', { name: 'Delete' })),
      'El botón Eliminar NO debe ser visible en la vista de detalles para un cargo Aceptado'
    ).not.toBeVisible();

    const chargeId = (await sharedPage.url()).split('/').pop();
    debugLog('ChargeId', chargeId);

    // Obtener estado antes de intentar eliminar
    const preDeleteGetResponse = await apiGet(sharedPage, `/rest/v1/charges?id=eq.${chargeId}`);
    const preData = await preDeleteGetResponse.json();

    // Intentar eliminar por API
    await apiDelete(sharedPage, `/rest/v1/charges?id=eq.${chargeId}`);

    // Obtener estado después
    const posDeleteGetResponse = await apiGet(sharedPage, `/rest/v1/charges?id=eq.${chargeId}`);
    const postData = await posDeleteGetResponse.json();

    // Verificar que el cargo no se eliminó (los datos deben ser idénticos)
    expect(preData, 'El cargo Aceptado NO debe haberse eliminado, los datos deben coincidir').toEqual(postData);
  });

  // ========== CP-CH-12 ==========
  test('CP-CH-12 - No debe permitir la eliminación de un cargo Condonado (Waive)', async () => {
    await sharedPage.goto('/admin/billing/charges');
    const row = await findTableRow(sharedPage, { column: 'Status', value: 'Waived' });
    await expect(
      row.getByRole('link', { name: 'Delete' }).or(row.getByRole('button', { name: 'Delete' })),
      'El botón Eliminar NO debe ser visible para un cargo Condonado (Waive) en la tabla'
    ).not.toBeVisible();

    await clickTableAction(sharedPage, 'View', { column: 'Status', value: 'Waived' });
    await expect(sharedPage.getByRole('heading', { name: 'Charge Details' })).toBeVisible();
    await expect(
      sharedPage.getByRole('link', { name: 'Delete' }).or(sharedPage.getByRole('button', { name: 'Delete' })),
      'El botón Eliminar NO debe ser visible en la vista de detalles para un cargo Condonado (Waive)'
    ).not.toBeVisible();

    const chargeId = (await sharedPage.url()).split('/').pop();
    debugLog('ChargeId', chargeId);

    const preDeleteGetResponse = await apiGet(sharedPage, `/rest/v1/charges?id=eq.${chargeId}`);
    const preData = await preDeleteGetResponse.json();

    await apiDelete(sharedPage, `/rest/v1/charges?id=eq.${chargeId}`);

    const posDeleteGetResponse = await apiGet(sharedPage, `/rest/v1/charges?id=eq.${chargeId}`);
    const postData = await posDeleteGetResponse.json();

    expect(preData, 'El cargo Condonado NO debe haberse eliminado, los datos deben coincidir').toEqual(postData);
  });

  // ========== CP-CH-13 ==========
  test('CP-CH-13 - No debe permitir la eliminación de un cargo en Disputa', async () => {
    await sharedPage.goto('/admin/billing/charges');
    const row = await findTableRow(sharedPage, { column: 'Status', value: 'Disputed' });
    await expect(
      row.getByRole('link', { name: 'Delete' }).or(row.getByRole('button', { name: 'Delete' })),
      'El botón Eliminar NO debe ser visible para un cargo en Disputa en la tabla'
    ).not.toBeVisible();

    await clickTableAction(sharedPage, 'View', { column: 'Status', value: 'Disputed' });
    await expect(sharedPage.getByRole('heading', { name: 'Charge Details' })).toBeVisible();
    await expect(
      sharedPage.getByRole('link', { name: 'Delete' }).or(sharedPage.getByRole('button', { name: 'Delete' })),
      'El botón Eliminar NO debe ser visible en la vista de detalles para un cargo en Disputa'
    ).not.toBeVisible();

    const chargeId = (await sharedPage.url()).split('/').pop();
    debugLog('ChargeId', chargeId);

    const preDeleteGetResponse = await apiGet(sharedPage, `/rest/v1/charges?id=eq.${chargeId}`);
    const preData = await preDeleteGetResponse.json();

    await apiDelete(sharedPage, `/rest/v1/charges?id=eq.${chargeId}`);

    const posDeleteGetResponse = await apiGet(sharedPage, `/rest/v1/charges?id=eq.${chargeId}`);
    const postData = await posDeleteGetResponse.json();

    expect(preData, 'El cargo en Disputa NO debe haberse eliminado, los datos deben coincidir').toEqual(postData);
  });

  // 14. Should not allow edit of Accepted charge
  test('CP-CH-14 - No debe permitir la edición de un cargo Aceptado', async () => {
    await sharedPage.goto('/admin/billing/charges');
    const row = await findTableRow(sharedPage, { column: 'Status', value: 'Accepted' });
    await expect(
      row.getByRole('link', { name: 'Edit' }).or(row.getByRole('button', { name: 'Edit' })),
      'El botón Editar NO debe ser visible para un cargo Aceptado en la tabla'
    ).not.toBeVisible();

    await clickTableAction(sharedPage, 'View', { column: 'Status', value: 'Accepted' });
    await expect(sharedPage.getByRole('heading', { name: 'Charge Details' })).toBeVisible();
    await expect(
      sharedPage.getByRole('button', { name: 'Edit Charge' }).or(sharedPage.getByRole('link', { name: 'Edit Charge' })),
      'El botón Editar Cargo NO debe ser visible en la vista de detalles para un cargo Aceptado'
    ).not.toBeVisible();

    const chargeId = (await sharedPage.url()).split('/').pop();
    debugLog('ChargeId', chargeId);
    expect(chargeId, 'El ID del cargo debe estar definido para un cargo Aceptado').toBeDefined();

    // Obtener descripción original para comparar
    const getBefore = await apiGet(sharedPage, `/rest/v1/charges?id=eq.${chargeId}`);
    const beforeData = await getBefore.json();
    const originalDescription = beforeData[0]?.description;

    const newDescription = 'Description changed via API';
    await apiPatch(sharedPage, `/rest/v1/charges?id=eq.${chargeId}`, { description: newDescription });

    // Verificar que la descripción NO cambió
    const getAfter = await apiGet(sharedPage, `/rest/v1/charges?id=eq.${chargeId}`);
    const afterData = await getAfter.json();
    expect(afterData[0].description, 'La edición no debe ser permitida para un cargo Aceptado').toBe(originalDescription);
  });

  // 15. Should not allow edit of Waived charge
  test('CP-CH-15 - No debe permitir la edición de un cargo Condonado (Waive)', async () => {
    await sharedPage.goto('/admin/billing/charges');
    const row = await findTableRow(sharedPage, { column: 'Status', value: 'Waived' });
    await expect(
      row.getByRole('link', { name: 'Edit' }).or(row.getByRole('button', { name: 'Edit' })),
      'El botón Editar NO debe ser visible para un cargo Condonado (Waive) en la tabla'
    ).not.toBeVisible();

    await clickTableAction(sharedPage, 'View', { column: 'Status', value: 'Waived' });
    await expect(sharedPage.getByRole('heading', { name: 'Charge Details' })).toBeVisible();
    await expect(
      sharedPage.getByRole('button', { name: 'Edit Charge' }).or(sharedPage.getByRole('link', { name: 'Edit Charge' })),
      'El botón Editar Cargo NO debe ser visible en la vista de detalles para un cargo Condonado (Waive)'
    ).not.toBeVisible();

    const chargeId = (await sharedPage.url()).split('/').pop();
    debugLog('ChargeId', chargeId);
    expect(chargeId, 'El ID del cargo debe estar definido para un cargo Condonado (Waive)').toBeDefined();

    // Obtener descripción original
    const getBefore = await apiGet(sharedPage, `/rest/v1/charges?id=eq.${chargeId}`);
    const beforeData = await getBefore.json();
    const originalDescription = beforeData[0]?.description;

    const newDescription = 'Description changed via API';
    await apiPatch(sharedPage, `/rest/v1/charges?id=eq.${chargeId}`, { description: newDescription });

    const getAfter = await apiGet(sharedPage, `/rest/v1/charges?id=eq.${chargeId}`);
    const afterData = await getAfter.json();
    expect(afterData[0].description, 'La edición no debe ser permitida para un cargo Condonado').toBe(originalDescription);
  });

  // 16. Should allow edit of Disputed charge
  test('CP-CH-16 - Debe permitir la edición de un cargo en Disputa', async () => {
    await sharedPage.goto('/admin/billing/charges');
    const row = await findTableRow(sharedPage, { column: 'Status', value: 'Disputed' });
    await expect(
      row.getByRole('link', { name: 'Edit' }).or(row.getByRole('button', { name: 'Edit' })),
      'El botón o enlace Editar DEBE ser visible para un cargo en Disputa en la tabla'
    ).toBeVisible();

    await clickTableAction(sharedPage, 'View', { column: 'Status', value: 'Disputed' });
    await expect(sharedPage.getByRole('heading', { name: 'Charge Details' })).toBeVisible();
    await expect(
      sharedPage.getByRole('button', { name: 'Edit Charge' }).or(sharedPage.getByRole('link', { name: 'Edit Charge' })),
      'El botón Editar Cargo DEBE ser visible en la vista de detalles para un cargo en Disputa'
    ).toBeVisible();

    const chargeId = (await sharedPage.url()).split('/').pop();
    debugLog('ChargeId', chargeId);
    expect(chargeId, 'El ID del cargo debe estar definido para un cargo en Disputa').toBeDefined();

    // Obtener descripción original
    const getBefore = await apiGet(sharedPage, `/rest/v1/charges?id=eq.${chargeId}`);
    const beforeData = await getBefore.json();
    const originalDescription = beforeData[0]?.description;

    const newDescription = 'Description changed via API';
    await apiPatch(sharedPage, `/rest/v1/charges?id=eq.${chargeId}`, { description: newDescription });

    const getAfter = await apiGet(sharedPage, `/rest/v1/charges?id=eq.${chargeId}`);
    const afterData = await getAfter.json();
    expect(afterData[0].description, 'La edición debe ser permitida para un cargo en Disputa').toBe(newDescription);
  });
});