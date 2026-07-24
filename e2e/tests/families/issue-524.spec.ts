// e2e/family-address.spec.ts
import { test, expect, BrowserContext, Page } from '@playwright/test';
import {
  clickTableAction,
  getModal,
  getFormFieldByLabel,
} from '../utils/helpers';
import { waitForResponse } from '../utils/api';
import { loginViaUI } from '../utils/auth';

test.describe('Family Address', () => {
  let sharedContext: BrowserContext;
  let sharedPage: Page;

  // -------------------------------------------------------------------------
  // HELPERS INTERNOS PARA EVITAR REPETICIÓN
  // -------------------------------------------------------------------------

  /**
   * Obtiene todos los campos del formulario de dirección y verifica que existan.
   * Retorna un objeto con los campos.
   */
  async function getAddressFields(page: Page) {
    const address = getFormFieldByLabel(page, 'Address');
    const city = getFormFieldByLabel(page, 'City');
    const state = getFormFieldByLabel(page, 'State');
    const postal = getFormFieldByLabel(page, 'Postal Code');
    const country = getFormFieldByLabel(page, 'Country');

    expect(address, 'El campo "Street address" debe existir').not.toBeNull();
    expect(city, 'El campo "City" debe existir').not.toBeNull();
    expect(state, 'El campo "State" debe existir').not.toBeNull();
    expect(postal, 'El campo "Postal Code" debe existir').not.toBeNull();
    expect(country, 'El campo "Country" debe existir').not.toBeNull();

    return { address: address!, city: city!, state: state!, postal: postal!, country: country! };
  }

  /**
   * Rellena los campos del formulario con los datos proporcionados (objeto parcial).
   * Ejemplo: fillAddressFields(page, { address: 'Calle 123', city: 'Madrid' });
   */
  async function fillAddressFields(
    page: Page,
    data: Partial<{
      address: string;
      city: string;
      state: string;
      postal: string;
      country: string;
    }>
  ) {
    const fields = await getAddressFields(page);
    if (data.address !== undefined) await fields.address.fill(data.address);
    if (data.city !== undefined) await fields.city.fill(data.city);
    if (data.state !== undefined) await fields.state.fill(data.state);
    if (data.postal !== undefined) await fields.postal.fill(data.postal);
    if (data.country !== undefined) await fields.country.selectOption(data.country);
  }

  /**
   * Limpia todos los campos del formulario (rellena con cadena vacía).
   */
  async function clearAddressFields(page: Page) {
    await fillAddressFields(page, {
      address: '',
      city: '',
      state: '',
      postal: '',
    });
  }

  // -------------------------------------------------------------------------
  // CONFIGURACIÓN DE LA SUITE
  // -------------------------------------------------------------------------

  test.beforeAll(async ({ browser }) => {
    sharedContext = await browser.newContext();
    sharedPage = await sharedContext.newPage();
    await loginViaUI(sharedPage);
  });

  test.afterAll(async () => {
    await sharedContext.close();
  });

  // -------------------------------------------------------------------------
  // PRUEBAS
  // -------------------------------------------------------------------------

  test('CP-FAM-01 - Verificar campos del modal de editar dirección', async () => {
    await sharedPage.goto('/admin/families');
    await clickTableAction(sharedPage, 'View', { column: 'Status', value: 'Active' });
    await sharedPage.getByRole('button', { name: 'Edit Address' }).first().click();

    const modal = getModal(sharedPage);
    const fields = await getAddressFields(sharedPage);
    await expect(modal.getByRole('button', { name: /Cancel|Back/ }), 'El botón "Cancel" debe estar visible').toBeVisible();
    await expect(modal.getByRole('button', { name: 'Save Address' }), 'El botón "Save Address" debe estar visible').toBeVisible();
  });

  test('CP-FAM-02 - Editar dirección de familia correctamente y persistir tras recarga', async () => {
    await sharedPage.goto('/admin/families');
    await clickTableAction(sharedPage, 'View', { column: 'Status', value: 'Active' });
    await sharedPage.getByRole('button', { name: 'Edit Address' }).first().click();

    await fillAddressFields(sharedPage, {
      address: '742 Evergreen Terrace',
      city: 'Springfield',
      state: 'Oregon',
      postal: '97401',
      country: 'United States',
    });

    const patchPromise = waitForResponse(sharedPage, '/rest/v1/families', 'PATCH');
    await sharedPage.getByRole('button', { name: 'Save Address' }).click();

    const response = await patchPromise;
    expect(response.status(), 'El PATCH debe responder con éxito (código < 400)').toBeLessThan(400);

    const payload = response.request().postDataJSON();
    expect(payload.address, 'El campo "address" debe coincidir con lo enviado').toBe('742 Evergreen Terrace');
    expect(payload.city, 'El campo "city" debe coincidir con lo enviado').toBe('Springfield');
    expect(payload.state, 'El campo "state" debe coincidir con lo enviado').toBe('Oregon');
    expect(payload.postal_code, 'El campo "postal_code" debe coincidir con lo enviado').toBe('97401');
    expect(payload.country, 'El campo "country" debe coincidir con lo enviado').toBe('United States');

    await expect(sharedPage.getByText('742 Evergreen Terrace'), 'La dirección debe mostrarse en la vista de detalle').toBeVisible();
    await expect(sharedPage.getByText('Springfield, Oregon 97401'), 'La ciudad, estado y código postal deben mostrarse formateados').toBeVisible();

    await sharedPage.reload();
    await expect(sharedPage.getByText('742 Evergreen Terrace'), 'Tras recargar, la dirección debe seguir visible').toBeVisible();
    await expect(sharedPage.getByText('Springfield, Oregon 97401'), 'Tras recargar, la ciudad/estado/CP deben seguir visibles').toBeVisible();
  });

  test('CP-FAM-03 - Limpiar todos los campos de dirección de la familia', async () => {
    await sharedPage.goto('/admin/families');
    await clickTableAction(sharedPage, 'View', { column: 'Status', value: 'Active' });
    await sharedPage.getByRole('button', { name: 'Edit Address' }).first().click();

    await clearAddressFields(sharedPage);

    const patchPromise = waitForResponse(sharedPage, '/rest/v1/families', 'PATCH');
    await sharedPage.getByRole('button', { name: 'Save Address' }).click();

    const response = await patchPromise;
    expect(response.status(), 'El PATCH debe responder con éxito (código < 400)').toBeLessThan(400);

    const payload = response.request().postDataJSON();
    expect(payload.address, 'El campo "address" debe enviarse vacío').toBeFalsy();
    expect(payload.city, 'El campo "city" debe enviarse vacío').toBeFalsy();
    expect(payload.state, 'El campo "state" debe enviarse vacío').toBeFalsy();
    expect(payload.postal_code, 'El campo "postal_code" debe enviarse vacío').toBeFalsy();

    const responseBody = await response.json();
    expect(responseBody.address).toBeFalsy();
    expect(responseBody.city).toBeFalsy();
    expect(responseBody.state).toBeFalsy();
    expect(responseBody.postal_code).toBeFalsy();

    await expect(sharedPage.getByText('No address'), 'La UI debe mostrar "No address" cuando todos los campos están vacíos').toBeVisible();
  });

  test('CP-FAM-04 - Enviar valores con solo espacios en blanco', async () => {
    await sharedPage.goto('/admin/families');
    await clickTableAction(sharedPage, 'View', { column: 'Status', value: 'Active' });
    await sharedPage.getByRole('button', { name: 'Edit Address' }).first().click();

    const whitespace = '   ';
    await fillAddressFields(sharedPage, {
      address: whitespace,
      city: whitespace,
      state: whitespace,
      postal: whitespace,
    });

    const patchPromise = waitForResponse(sharedPage, '/rest/v1/families', 'PATCH');
    await sharedPage.getByRole('button', { name: 'Save Address' }).click();

    const response = await patchPromise;
    expect(response.status(), 'El PATCH debe responder con éxito (código < 400)').toBeLessThan(400);

    const payload = response.request().postDataJSON();
    // Asumimos que el backend trimea los espacios
    expect(payload.address, 'El backend debería trimear los espacios y guardar cadena vacía').toBeFalsy();
    expect(payload.city, 'El backend debería trimear los espacios y guardar cadena vacía').toBeFalsy();
    expect(payload.state, 'El backend debería trimear los espacios y guardar cadena vacía').toBeFalsy();
    expect(payload.postal_code, 'El backend debería trimear los espacios y guardar cadena vacía').toBeFalsy();

    const responseBody = await response.json();
    expect(responseBody.address).toBeFalsy();
    expect(responseBody.city).toBeFalsy();
    expect(responseBody.state).toBeFalsy();
    expect(responseBody.postal_code).toBeFalsy();

    await expect(sharedPage.getByText('No address'), 'La UI debe mostrar "No address" si todos los campos quedan vacíos').toBeVisible();
  });

  test('CP-FAM-05 - Caracteres especiales en ciudad y estado', async () => {
    await sharedPage.goto('/admin/families');
    await clickTableAction(sharedPage, 'View', { column: 'Status', value: 'Active' });
    await sharedPage.getByRole('button', { name: 'Edit Address' }).first().click();

    const specialCity = 'São Paulo #-.';
    const specialState = 'Ñuñoa-123.';
    await fillAddressFields(sharedPage, {
      address: 'Some street',
      city: specialCity,
      state: specialState,
      postal: '12345',
    });

    const patchPromise = waitForResponse(sharedPage, '/rest/v1/families', 'PATCH');
    await sharedPage.getByRole('button', { name: 'Save Address' }).click();

    const response = await patchPromise;
    expect(response.status(), 'El PATCH debe aceptar caracteres especiales (código < 400)').toBeLessThan(400);

    const payload = response.request().postDataJSON();
    expect(payload.city, 'La ciudad con caracteres especiales debe guardarse correctamente').toBe(specialCity);
    expect(payload.state, 'El estado con caracteres especiales debe guardarse correctamente').toBe(specialState);

    await expect(sharedPage.getByText(specialCity), 'La ciudad con caracteres especiales debe mostrarse en la UI').toBeVisible();
    await expect(sharedPage.getByText(specialState), 'El estado con caracteres especiales debe mostrarse en la UI').toBeVisible();
  });

  test('CP-FAM-06 - Código postal alfanumérico (formato UK)', async () => {
    await sharedPage.goto('/admin/families');
    await clickTableAction(sharedPage, 'View', { column: 'Status', value: 'Active' });
    await sharedPage.getByRole('button', { name: 'Edit Address' }).first().click();

    const ukPostal = 'E1 5AB';
    await fillAddressFields(sharedPage, {
      address: '10 Downing Street',
      city: 'London',
      state: 'Greater London',
      postal: ukPostal,
    });

    const patchPromise = waitForResponse(sharedPage, '/rest/v1/families', 'PATCH');
    await sharedPage.getByRole('button', { name: 'Save Address' }).click();

    const response = await patchPromise;
    expect(response.status(), 'El PATCH debe aceptar código postal alfanumérico (código < 400)').toBeLessThan(400);

    const payload = response.request().postDataJSON();
    expect(payload.postal_code, 'El código postal alfanumérico debe guardarse sin alteraciones').toBe(ukPostal);

    await expect(sharedPage.getByText(ukPostal), 'El código postal alfanumérico debe mostrarse en la UI').toBeVisible();
  });

  test('CP-FAM-07 - Dirección larga (500 caracteres)', async () => {
    await sharedPage.goto('/admin/families');
    await clickTableAction(sharedPage, 'View', { column: 'Status', value: 'Active' });
    await sharedPage.getByRole('button', { name: 'Edit Address' }).first().click();

    const longAddress = 'a'.repeat(500);
    await fillAddressFields(sharedPage, {
      address: longAddress,
      city: 'City',
      state: 'State',
      postal: '12345',
    });

    const patchPromise = waitForResponse(sharedPage, '/rest/v1/families', 'PATCH');
    await sharedPage.getByRole('button', { name: 'Save Address' }).click();

    const response = await patchPromise;
    expect(response.status(), 'El backend debe aceptar 500 caracteres (o rechazar con 400 si hay límite)').toBeLessThan(400);

    const payload = response.request().postDataJSON();
    expect(payload.address.length, 'La longitud del address debe ser 500 (o el límite que imponga el backend)').toBe(500);

    await expect(sharedPage.getByText(longAddress.substring(0, 100)), 'El address largo debe aparecer en la UI (al menos parcialmente)').toBeVisible();
  });

  test('CP-FAM-08 - Inyección XSS en campos de dirección', async () => {
    await sharedPage.goto('/admin/families');
    await clickTableAction(sharedPage, 'View', { column: 'Status', value: 'Active' });
    await sharedPage.getByRole('button', { name: 'Edit Address' }).first().click();

    const xssPayload = '<script>alert("XSS")</script>';
    await fillAddressFields(sharedPage, {
      address: xssPayload,
      city: 'City',
      state: 'State',
      postal: '12345',
    });

    const patchPromise = waitForResponse(sharedPage, '/rest/v1/families', 'PATCH');
    await sharedPage.getByRole('button', { name: 'Save Address' }).click();

    const response = await patchPromise;
    expect(response.status(), 'El PATCH debe completarse (código < 400)').toBeLessThan(400);

    const payload = response.request().postDataJSON();
    expect(payload.address, 'El payload debe contener el script (escapado o como texto)').toContain('script');

    const addressDisplay = sharedPage.getByText('<script>', { exact: false });
    await expect(addressDisplay, 'El script debe mostrarse como texto escapado o literal, no ejecutado').toBeVisible();
  });
});

// =============================================================================
// TEST DESCRIBE PARA FAMILY MEMBER - MISMO CONJUNTO DE PRUEBAS DE DIRECCIÓN
// =============================================================================

test.describe('Family Member', () => {
  let sharedContext: BrowserContext;
  let sharedPage: Page;

  // -------------------------------------------------------------------------
  // HELPERS INTERNOS
  // -------------------------------------------------------------------------

  /**
   * Abre el modal de edición del primer miembro de la familia (haciendo clic
   * en el botón con icono de lápiz) y retorna la página.
   * Asume que ya estamos en la vista de detalle de una familia.
   */
  async function openFirstMemberEditModal(page: Page): Promise<void> {
    // Localizar el primer botón de editar (icono de lápiz) dentro de la sección de miembros
    await page.getByRole('button').filter({ hasText: /^$/ }).nth(1).click();

    // Esperar que el modal esté visible
    const modal = getModal(page);
    await expect(modal).toBeVisible();
  }

  /**
   * Obtiene todos los campos del formulario de dirección dentro del modal de
   * edición de un miembro. Asume que los labels son los mismos que en familia.
   */
  async function getMemberAddressFields(page: Page) {
    const address = getFormFieldByLabel(page, 'Address', true);
    const city = getFormFieldByLabel(page, 'City', true);
    const state = getFormFieldByLabel(page, 'State', true);
    const postal = getFormFieldByLabel(page, 'Postal Code', true);
    const country = getFormFieldByLabel(page, 'Country', true);

    expect(address, 'El campo "Address" debe existir en el modal del miembro').not.toBeNull();
    expect(city, 'El campo "City" debe existir en el modal del miembro').not.toBeNull();
    expect(state, 'El campo "State" debe existir en el modal del miembro').not.toBeNull();
    expect(postal, 'El campo "Postal Code" debe existir en el modal del miembro').not.toBeNull();
    expect(country, 'El campo "Country" debe existir en el modal del miembro').not.toBeNull();

    return { address: address!, city: city!, state: state!, postal: postal!, country: country! };
  }
  ''
  /**
   * Rellena los campos de dirección en el modal del miembro.
   */
  async function fillMemberAddressFields(
    page: Page,
    data: Partial<{
      address: string;
      city: string;
      state: string;
      postal: string;
      country: string;
    }>
  ) {
    const fields = await getMemberAddressFields(page);
    if (data.address !== undefined) await fields.address.fill(data.address);
    if (data.city !== undefined) await fields.city.fill(data.city);
    if (data.state !== undefined) await fields.state.fill(data.state);
    if (data.postal !== undefined) await fields.postal.fill(data.postal);
    if (data.country !== undefined) await fields.country.selectOption(data.country);
  }

  /**
   * Limpia todos los campos de dirección en el modal del miembro.
   */
  async function clearMemberAddressFields(page: Page) {
    await fillMemberAddressFields(page, {
      address: '',
      city: '',
      state: '',
      postal: '',
    });
  }

  // -------------------------------------------------------------------------
  // CONFIGURACIÓN DE LA SUITE
  // -------------------------------------------------------------------------

  test.beforeAll(async ({ browser }) => {
    sharedContext = await browser.newContext();
    sharedPage = await sharedContext.newPage();
    await loginViaUI(sharedPage);
  });

  test.afterAll(async () => {
    await sharedContext.close();
  });

  // -------------------------------------------------------------------------
  // PRUEBAS - REPLICAN EXACTAMENTE LAS DE FAMILY ADDRESS PERO PARA MIEMBRO
  // -------------------------------------------------------------------------

  test('CP-FAM-09 - Verificar campos de dirección en el modal de editar miembro', async () => {
    await sharedPage.goto('/admin/families');
    await clickTableAction(sharedPage, 'View', { column: 'Status', value: 'Active' });

    await openFirstMemberEditModal(sharedPage);

    const modal = getModal(sharedPage);
    const fields = await getMemberAddressFields(sharedPage);
    await expect(modal.getByRole('button', { name: /Cancel|Back/ }), 'El botón "Cancel" debe estar visible').toBeVisible();
    await expect(modal.getByRole('button', { name: /Save|Update/ }), 'El botón de guardar debe estar visible').toBeVisible();
  });

  test('CP-FAM-10 - Editar dirección de miembro correctamente y persistir tras recarga', async () => {
    await sharedPage.goto('/admin/families');
    await clickTableAction(sharedPage, 'View', { column: 'Status', value: 'Active' });

    await openFirstMemberEditModal(sharedPage);

    await fillMemberAddressFields(sharedPage, {
      address: '742 Evergreen Terrace',
      city: 'Springfield',
      state: 'Oregon',
      postal: '97401',
      country: 'United States',
    });

    const patchPromise = waitForResponse(sharedPage, '/rest/v1/family_members', 'PATCH');
    await sharedPage.getByRole('button', { name: /Save|Update/ }).click();

    const response = await patchPromise;
    expect(response.status(), 'El PATCH debe responder con éxito (código < 400)').toBeLessThan(400);

    const payload = response.request().postDataJSON();
    expect(payload.address, 'El campo "address" debe coincidir con lo enviado').toBe('742 Evergreen Terrace');
    expect(payload.city, 'El campo "city" debe coincidir con lo enviado').toBe('Springfield');
    expect(payload.state, 'El campo "state" debe coincidir con lo enviado').toBe('Oregon');
    expect(payload.postal_code, 'El campo "postal_code" debe coincidir con lo enviado').toBe('97401');
    expect(payload.country, 'El campo "country" debe coincidir con lo enviado').toBe('United States');

    // Verificar que la dirección se muestra en la vista de detalle (asumiendo que se muestra)
    await expect(sharedPage.getByText('742 Evergreen Terrace'), 'La dirección debe mostrarse en la vista de detalle').toBeVisible();
    await expect(sharedPage.getByText('Springfield, Oregon 97401'), 'La ciudad, estado y código postal deben mostrarse formateados').toBeVisible();

    await sharedPage.reload();
    await expect(sharedPage.getByText('742 Evergreen Terrace'), 'Tras recargar, la dirección debe seguir visible').toBeVisible();
    await expect(sharedPage.getByText('Springfield, Oregon 97401'), 'Tras recargar, la ciudad/estado/CP deben seguir visibles').toBeVisible();
  });

  test('CP-FAM-11 - Limpiar todos los campos de dirección del miembro', async () => {
    await sharedPage.goto('/admin/families');
    await clickTableAction(sharedPage, 'View', { column: 'Status', value: 'Active' });

    await openFirstMemberEditModal(sharedPage);

    await clearMemberAddressFields(sharedPage);

    const patchPromise = waitForResponse(sharedPage, '/rest/v1/family_members', 'PATCH');
    await sharedPage.getByRole('button', { name: /Save|Update/ }).click();

    const response = await patchPromise;
    expect(response.status(), 'El PATCH debe responder con éxito (código < 400)').toBeLessThan(400);

    const payload = response.request().postDataJSON();
    expect(payload.address, 'El campo "address" debe enviarse vacío').toBeFalsy();
    expect(payload.city, 'El campo "city" debe enviarse vacío').toBeFalsy();
    expect(payload.state, 'El campo "state" debe enviarse vacío').toBeFalsy();
    expect(payload.postal_code, 'El campo "postal_code" debe enviarse vacío').toBeFalsy();

    const responseBody = await response.json();
    expect(responseBody.address).toBeFalsy();
    expect(responseBody.city).toBeFalsy();
    expect(responseBody.state).toBeFalsy();
    expect(responseBody.postal_code).toBeFalsy();

    await expect(sharedPage.getByText('No address'), 'La UI debe mostrar "No address" cuando todos los campos están vacíos').toBeVisible();
  });

  test('CP-FAM-12 - Enviar valores con solo espacios en blanco en miembro', async () => {
    await sharedPage.goto('/admin/families');
    await clickTableAction(sharedPage, 'View', { column: 'Status', value: 'Active' });

    await openFirstMemberEditModal(sharedPage);

    const whitespace = '   ';
    await fillMemberAddressFields(sharedPage, {
      address: whitespace,
      city: whitespace,
      state: whitespace,
      postal: whitespace,
    });

    const patchPromise = waitForResponse(sharedPage, '/rest/v1/family_members', 'PATCH');
    await sharedPage.getByRole('button', { name: /Save|Update/ }).click();

    const response = await patchPromise;
    expect(response.status(), 'El PATCH debe responder con éxito (código < 400)').toBeLessThan(400);

    const payload = response.request().postDataJSON();
    // Asumimos que el backend trimea los espacios
    expect(payload.address, 'El backend debería trimear los espacios y guardar cadena vacía').toBeFalsy();
    expect(payload.city, 'El backend debería trimear los espacios y guardar cadena vacía').toBeFalsy();
    expect(payload.state, 'El backend debería trimear los espacios y guardar cadena vacía').toBeFalsy();
    expect(payload.postal_code, 'El backend debería trimear los espacios y guardar cadena vacía').toBeFalsy();

    const responseBody = await response.json();
    expect(responseBody.address).toBeFalsy();
    expect(responseBody.city).toBeFalsy();
    expect(responseBody.state).toBeFalsy();
    expect(responseBody.postal_code).toBeFalsy();

    await expect(sharedPage.getByText('No address'), 'La UI debe mostrar "No address" si todos los campos quedan vacíos').toBeVisible();
  });

  test('CP-FAM-13 - Caracteres especiales en ciudad y estado de miembro', async () => {
    await sharedPage.goto('/admin/families');
    await clickTableAction(sharedPage, 'View', { column: 'Status', value: 'Active' });

    await openFirstMemberEditModal(sharedPage);

    const specialCity = 'São Paulo #-.';
    const specialState = 'Ñuñoa-123.';
    await fillMemberAddressFields(sharedPage, {
      address: 'Some street',
      city: specialCity,
      state: specialState,
      postal: '12345',
    });

    const patchPromise = waitForResponse(sharedPage, '/rest/v1/family_members', 'PATCH');
    await sharedPage.getByRole('button', { name: /Save|Update/ }).click();

    const response = await patchPromise;
    expect(response.status(), 'El PATCH debe aceptar caracteres especiales (código < 400)').toBeLessThan(400);

    const payload = response.request().postDataJSON();
    expect(payload.city, 'La ciudad con caracteres especiales debe guardarse correctamente').toBe(specialCity);
    expect(payload.state, 'El estado con caracteres especiales debe guardarse correctamente').toBe(specialState);

    await expect(sharedPage.getByText(specialCity), 'La ciudad con caracteres especiales debe mostrarse en la UI').toBeVisible();
    await expect(sharedPage.getByText(specialState), 'El estado con caracteres especiales debe mostrarse en la UI').toBeVisible();
  });

  test('CP-FAM-14 - Código postal alfanumérico (formato UK) en miembro', async () => {
    await sharedPage.goto('/admin/families');
    await clickTableAction(sharedPage, 'View', { column: 'Status', value: 'Active' });

    await openFirstMemberEditModal(sharedPage);

    const ukPostal = 'E1 5AB';
    await fillMemberAddressFields(sharedPage, {
      address: '10 Downing Street',
      city: 'London',
      state: 'Greater London',
      postal: ukPostal,
    });

    const patchPromise = waitForResponse(sharedPage, '/rest/v1/family_members', 'PATCH');
    await sharedPage.getByRole('button', { name: /Save|Update/ }).click();

    const response = await patchPromise;
    expect(response.status(), 'El PATCH debe aceptar código postal alfanumérico (código < 400)').toBeLessThan(400);

    const payload = response.request().postDataJSON();
    expect(payload.postal_code, 'El código postal alfanumérico debe guardarse sin alteraciones').toBe(ukPostal);

    await expect(sharedPage.getByText(ukPostal), 'El código postal alfanumérico debe mostrarse en la UI').toBeVisible();
  });

  test('CP-FAM-15 - Dirección larga (500 caracteres) en miembro', async () => {
    await sharedPage.goto('/admin/families');
    await clickTableAction(sharedPage, 'View', { column: 'Status', value: 'Active' });

    await openFirstMemberEditModal(sharedPage);

    const longAddress = 'a'.repeat(500);
    await fillMemberAddressFields(sharedPage, {
      address: longAddress,
      city: 'City',
      state: 'State',
      postal: '12345',
    });

    const patchPromise = waitForResponse(sharedPage, '/rest/v1/family_members', 'PATCH');
    await sharedPage.getByRole('button', { name: /Save|Update/ }).click();

    const response = await patchPromise;
    expect(response.status(), 'El backend debe aceptar 500 caracteres (o rechazar con 400 si hay límite)').toBeLessThan(400);

    const payload = response.request().postDataJSON();
    expect(payload.address.length, 'La longitud del address debe ser 500 (o el límite que imponga el backend)').toBe(500);

    await expect(sharedPage.getByText(longAddress.substring(0, 100)), 'El address largo debe aparecer en la UI (al menos parcialmente)').toBeVisible();
  });

  test('CP-FAM-16 - Inyección XSS en campos de dirección de miembro', async () => {
    await sharedPage.goto('/admin/families');
    await clickTableAction(sharedPage, 'View', { column: 'Status', value: 'Active' });

    await openFirstMemberEditModal(sharedPage);

    const xssPayload = '<script>alert("XSS")</script>';
    await fillMemberAddressFields(sharedPage, {
      address: xssPayload,
      city: 'City',
      state: 'State',
      postal: '12345',
    });

    const patchPromise = waitForResponse(sharedPage, '/rest/v1/family_members', 'PATCH');
    await sharedPage.getByRole('button', { name: /Save|Update/ }).click();

    const response = await patchPromise;
    expect(response.status(), 'El PATCH debe completarse (código < 400)').toBeLessThan(400);

    const payload = response.request().postDataJSON();
    expect(payload.address, 'El payload debe contener el script (escapado o como texto)').toContain('script');

    const addressDisplay = sharedPage.getByText('<script>', { exact: false });
    await expect(addressDisplay, 'El script debe mostrarse como texto escapado o literal, no ejecutado').toBeVisible();
  });

  // -------------------------------------------------------------------------
  // TEST ADICIONAL: CP-FAM-17 - ABRIR MODAL DE AGREGAR MIEMBRO Y VERIFICAR CAMPOS
  // -------------------------------------------------------------------------

  test('CP-FAM-17 - Abrir modal de agregar miembro y verificar campos de dirección y botones', async () => {
    await sharedPage.goto('/admin/families');
    await clickTableAction(sharedPage, 'View', { column: 'Status', value: 'Active' });

    // Hacer clic en el botón "Add Member" (asumimos que existe con ese texto)
    const addButton = sharedPage.getByRole('button', { name: 'Add Member' });
    await expect(addButton).toBeVisible();
    await addButton.click();

    // Verificar que se abre el modal
    const modal = getModal(sharedPage);
    await expect(modal).toBeVisible();

    // Verificar que los campos de dirección existen
    const addressFields = await getMemberAddressFields(sharedPage);
    await expect(addressFields.address).toBeVisible();
    await expect(addressFields.city).toBeVisible();
    await expect(addressFields.state).toBeVisible();
    await expect(addressFields.postal).toBeVisible();
    await expect(addressFields.country).toBeVisible();

    // Verificar el campo Email (adicional, como se pidió)
    const emailField = getFormFieldByLabel(sharedPage, 'Email Address');
    expect(emailField, 'El campo "Email Address" debe existir').not.toBeNull();
    await emailField!.fill('new@parent.com');

    // Verificar visibilidad de los botones Cancel y Save
    await expect(modal.getByRole('button', { name: /Cancel|Back/ }), 'El botón "Cancel" debe estar visible').toBeVisible();
    await expect(modal.getByRole('button', { name: /Save|Add/ }), 'El botón de guardar debe estar visible').toBeVisible();
  });
});