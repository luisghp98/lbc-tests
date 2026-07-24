import { test, expect, BrowserContext, Page } from '@playwright/test';
import { clickTableAction, createCharge, debugLog, expectToast, findTableRow, getFieldValueByLabel, getFormFieldByLabel, getModal } from './utils/helpers';
import { apiDelete, apiGet, apiPatch, waitForResponse } from './utils/api';
import { loginViaUI } from './utils/auth';

test.describe('Example', () => {
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

  async function openFirstMemberEditModal(page: Page): Promise<void> {
    // Localizar el primer botón de editar (icono de lápiz) dentro de la sección de miembros
    await page.getByRole('button').filter({ hasText: /^$/ }).nth(1).click();

    // Esperar que el modal esté visible
    const modal = getModal(page);
    await expect(modal).toBeVisible();
  }

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
   * Obtiene todos los campos del formulario de dirección dentro del modal de
   * edición de un miembro. Asume que los labels son los mismos que en familia.
   */
  async function getMemberAddressFields(page: Page, continerHas='') {
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

    // const patchPromise = waitForResponse(sharedPage, '/rest/v1/family_members', 'PATCH');
    const patchPromise = waitForResponse(sharedPage, '/rest/v1/families', 'POST'); // Este es el que se ejecuta
    await sharedPage.getByRole('button', { name: /Save|Update/ }).click();

    const response = await patchPromise;
    expect(response.status(), 'El PATCH debe responder con éxito (código < 400)').toBeLessThan(400);

    const payload = response.request().postDataJSON();
    console.log(payload)
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
});