// e2e/helpers.ts
import { expect, Locator, Page } from '@playwright/test';
import dotenv from 'dotenv';
import path from 'path';
import { waitForResponse } from './api';

// Cargar variables de entorno (por si no se cargaron desde playwright.config)
dotenv.config({ path: path.resolve(__dirname, '../.env') });

const isDebug = !!process.env.DEBUG

// Función helper para logs condicionales
export function debugLog(...args: any[]) {
  if (isDebug) {
    debugLog(...args);
  }
}

export async function takeScreenshot(page: Page, name?: string, dirname='') {
  const screenshotDir = path.resolve(__dirname, '../screenshots'+(dirname ? `/${dirname}` : ''));
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = (name ? name : timestamp)+'.png';
  const filepath = path.join(screenshotDir, filename);
  await page.screenshot({ path: filepath, fullPage: true });
  console.log(`📸 Screenshot guardado: ${filepath}`);
}

export function sanitizeTitle(title: string): string {
  // 1. Eliminar todo lo que está entre paréntesis (incluyendo los paréntesis)
  // Ej: "Acceso permitido - Accountant (Contador) (hevola4569@dysonc.com)" 
  //   -> "Acceso permitido - Accountant  "
  let sanitized = title.replace(/\([^)]*\)/g, '');

  // 2. Reemplazar espacios y caracteres especiales por guión bajo
  sanitized = sanitized.replace(/[^a-zA-Z0-9\s\-.]/g, '_');

  // 3. Reemplazar espacios por guión bajo
  sanitized = sanitized.replace(/\s+/g, '_');

  // 4. Eliminar guiones bajos múltiples (consecutivos)
  sanitized = sanitized.replace(/_+/g, '_');

  // 5. Eliminar guiones bajos al inicio y al final
  sanitized = sanitized.replace(/^_|_$/g, '');

  return sanitized;
}

/**
 * Selecciona una opción de un dropdown con estructura específica
 * Estructura: div:has(input[placeholder="..."]) + div ul li
 *
 * @param page - Instancia de Page
 * @param placeholder - Texto del placeholder del input
 * @param options - { index?: number, text?: string }
 * @example
 * // Seleccionar primera opción (por defecto)
 * await selectDropdownOption(page, 'Search for a child...');
 *
 * // Seleccionar por índice (tercera opción)
 * await selectDropdownOption(page, 'Search for a child...', { index: 2 });
 *
 * // Seleccionar por texto
 * await selectDropdownOption(page, 'Search for a child...', { text: 'Aby Firststy' });
 */
export async function selectDropdownOption(
  page: Page,
  placeholder: string,
  options: { index?: number; text?: string } = {}
): Promise<void> {
  const { index = 0, text } = options;

  if (index !== undefined && text !== undefined) {
    throw new Error('Provide either index OR text, not both');
  }

  const baseSelector = `div:has(input[placeholder="${placeholder}"]) + div ul`;

  await page.getByRole('textbox', { name: placeholder }).click();
  await expect(page.locator('ul')).toBeVisible();

  let liSelector: string;
  if (text) {
    liSelector = `${baseSelector} li:has-text("${text}")`;
  } else {
    liSelector = `${baseSelector} li:nth-child(${index + 1})`;
  }

  await expect(page.locator(liSelector)).toBeVisible();
  await page.locator(liSelector).click();
}

/**
 * Realiza clic en un botón/enlace de acción (View, Edit, Delete) dentro de la tabla de cargos.
 */
// Función auxiliar para encontrar la fila
export async function findTableRow(
  page: Page,
  options: { search?: string; column?: string; value?: string } = {}
): Promise<Locator> {
  if (options.search) {
    await page.getByPlaceholder('Search charges...').fill(options.search);
    await page.waitForTimeout(500);
  }

  await expect(page.locator('table')).toBeVisible();
  const rows = page.locator('tbody tr');

  if (options.column && options.value) {
    const headers = await page.locator('thead th').allTextContents();
    const columnIndex = headers.findIndex(th => th.trim().toLowerCase() === options.column!.trim().toLowerCase());
    if (columnIndex === -1) {
      throw new Error(`Columna "${options.column}" no encontrada en la tabla`);
    }

    const rowCount = await rows.count();
    for (let i = 0; i < rowCount; i++) {
      const row = rows.nth(i);
      const cell = row.locator('td').nth(columnIndex);
      const cellText = await cell.textContent();
      const trimmedCellText = cellText?.trim() || '';
      console.log(`Fila ${i + 1}, Columna "${options.column}": "${trimmedCellText}"`);
      if (trimmedCellText.toLowerCase().includes(options.value.trim().toLowerCase())) {
        return row;
      }
    }
    throw new Error(`No se encontró fila con valor "${options.value}" en columna "${options.column}"`);
  }

  return rows.first();
}

// Función principal clickTableAction usando findTableRow
export async function clickTableAction(
  page: Page,
  action: 'View' | 'Edit' | 'Delete' | string,
  options: { search?: string; column?: string; value?: string } = {}
): Promise<void> {
  const targetRow = await findTableRow(page, options);

  const link = targetRow.getByRole('link', { name: new RegExp(action, 'i') });
  const button = targetRow.getByRole('button', { name: new RegExp(action, 'i') });
  const actionLocator = link.or(button);
  await actionLocator.click();
  await page.waitForTimeout(2000);
}

/**
 * Obtiene el contenedor del modal.
 */
export function getModal(page: Page) {
  return page.locator('.fixed.inset-0.flex.items-center.justify-center.z-50');
}

/**
 * Crea un cargo exitosamente y devuelve sus datos.
 */
export async function createCharge(page: Page) {
  await page.goto('/admin/billing/charges/new');

  await selectDropdownOption(page, 'Search for a child...');
  await expect(page.getByText('Loading associated family...')).not.toBeVisible();

  const dueDate = new Date();
  dueDate.setMonth(dueDate.getMonth() + 1);
  const dueDateStr = dueDate.toISOString().split('T')[0];

  const description = `Late pickup ${Date.now()}`;
  const amount = '2.5';
  const notes = 'Example of details about the charge';

  await page.getByRole('textbox', { name: 'E.g., Late pickup charge - 30' }).fill(description);
  await page.getByRole('spinbutton').fill(amount);
  await page.locator('input[type="date"]').fill(dueDateStr);
  await page.getByRole('textbox', { name: 'Additional details about the' }).fill(notes);

  const responsePromise = waitForResponse(page, '/rest/v1/charges', 'POST')

  await page.getByRole('button', { name: 'Create Charge' }).click();

  const response = await responsePromise;
  expect(response.status()).toBe(201);
  const responseBody = await response.json();

  return responseBody;
}

/**
 * Obtiene el locator del toast actual.
 */
export function getToast(page: Page): Locator {
  const container = page.locator('section[aria-label="Notifications alt+T"]');
  return container.locator('li[data-sonner-toast]').first();
}

/**
 * Devuelve el código de color ANSI según el tipo de toast.
 */
function getColorForType(type?: string): { color: string; reset: string } {
  const reset = '\x1b[0m';
  let color = '\x1b[37m';
  switch (type) {
    case 'success':
      color = '\x1b[32m';
      break;
    case 'error':
      color = '\x1b[31m';
      break;
    case 'warning':
      color = '\x1b[33m';
      break;
    case 'info':
      color = '\x1b[34m';
      break;
    default:
      color = '\x1b[37m';
  }
  return { color, reset };
}

/**
 * Verifica que haya un toast visible, opcionalmente de un tipo y con texto.
 */
export async function expectToast(
  page: Page,
  options: { type?: 'success' | 'error' | 'warning' | 'info'; text?: string | RegExp } = {}
): Promise<string> {
  const toast = getToast(page);
  await expect(toast).toBeVisible();

  const title = toast.locator('[data-title]');
  const toastMessage = await title.textContent();

  let actualType = options.type;
  if (!actualType) {
    const dataType = await toast.getAttribute('data-type');
    if (dataType) actualType = dataType as 'success' | 'error' | 'warning' | 'info';
  }

  const { color, reset } = getColorForType(actualType);
  debugLog(`${color}🍞 Toast message: ${toastMessage?.trim() || 'No message'}${reset}`);

  if (options.type) {
    await expect(toast).toHaveAttribute('data-type', options.type);
  }
  if (options.text) {
    if (typeof options.text === 'string') {
      await expect(title).toHaveText(options.text);
    } else {
      await expect(title).toHaveText(options.text);
    }
  }
  return await title.textContent() ?? ''
}

/**
 * Encuentra el elemento de formulario (input, select, textarea) asociado a un label por su texto.
 * Busca el primer label que contenga el texto exacto (ignorando asteriscos),
 * sube al primer div ancestro, y dentro de él localiza el primer input, select o textarea.
 *
 * @param page - Instancia de Page
 * @param labelText - Texto del label (puede incluir el asterisco, pero se busca por coincidencia parcial)
 * @returns Locator del elemento de formulario o null si no se encuentra
 */
export function getFormFieldByLabel(
  page: Page,
  labelText: string,
  exact: boolean = false
): Locator | null {
  // Si exact es true, busca coincidencia exacta
  const labelSelector = exact
    ? `label:text-is("${labelText}")`
    : `label:has-text("${labelText}")`;

  const label = page.locator(labelSelector).first();
  if (!label) return null;

  const container = label.locator('xpath=ancestor::div[1]');
  if (!container) return null;

  const field = container.locator('input, select, textarea').first();
  return field;
}

/**
 * Obtiene el valor (atributo "value") del campo de formulario asociado a un label.
 * Útil para inputs de tipo date, text, number, o selects.
 *
 * @param page - Instancia de Page
 * @param labelText - Texto del label
 * @returns El valor del campo o null si no se encuentra
 */
export async function getFieldValueByLabel(page: Page, labelText: string): Promise<string | null> {
  const field = getFormFieldByLabel(page, labelText);
  if (!field) return null;
  const value = await field.getAttribute('value');
  return value;
}

/**
 * Verifica que un campo del formulario exista y, opcionalmente, sea requerido.
 */
export async function expectFormField(
  page: Page,
  labelText: string,
  options: { required?: boolean; notRequired?: boolean } = {}
): Promise<void> {
  const label = page.getByText(labelText, { exact: true }).first();
  await expect(label).toBeVisible();

  const asterisk = label.locator('span:text("*")');
  if (options.required) {
    await expect(asterisk).toBeVisible();
    await expect(asterisk).toHaveClass(/text-red-500/);
  } else {
    await expect(asterisk).not.toBeVisible();
  }
}

/**
 * Verifica varios campos del formulario.
 */
export async function verifyFormFields(
  page: Page,
  fields: { label: string; required?: boolean }[],
  formSelector: string = 'form'
): Promise<void> {
  const form = page.locator(formSelector).first();
  await expect(form).toBeVisible();

  const labelLocators = form.locator('label');
  const count = await labelLocators.count();
  const actualLabels: string[] = [];

  for (let i = 0; i < count; i++) {
    const text = await labelLocators.nth(i).textContent();
    if (text) {
      const clean = text.replace(/\s*\*\s*$/, '').trim();
      actualLabels.push(clean);
    }
  }

  const expectedLabels = fields.map(f => f.label);
  const missing = expectedLabels.filter(label => !actualLabels.includes(label));
  const extra = actualLabels.filter(label => !expectedLabels.includes(label));

  if (missing.length > 0) {
    console.warn(`⚠️ Missing expected fields: ${missing.join(', ')}`);
  }
  if (extra.length > 0) {
    console.warn(`⚠️ Extra fields found (not mentioned): ${extra.join(', ')}`);
  }

  for (const field of fields) {
    await expectFormField(page, field.label, { required: field.required });
  }
}

// Helper para capturar headers de una solicitud GET a la API
export async function captureApiHeaders(page: Page): Promise<Record<string, string>> {
  let capturedHeaders: Record<string, string> = {};
  const headersPromise = new Promise<void>((resolve) => {
    const listener = (request: any) => {
      const url = request.url();
      if (url.includes('/rest/v1/charges') && request.method() === 'GET') {
        const headers = request.headers();
        // Extraer los headers que necesita la API
        capturedHeaders = {
          'apikey': headers['apikey'] || '',
          'Authorization': headers['authorization'] || '',
          'Content-Type': headers['content-type'] || 'application/json',
          'Content-Profile': headers['content-profile'] || 'public',
          'Prefer': headers['prefer'] || 'return=representation',
          'x-client-info': headers['x-client-info'] || '',
          // Opcional: agregar Origin y Referer si la API los requiere
          'Origin': headers['origin'] || 'https://prelbc.juvomos.com',
          'Referer': headers['referer'] || 'https://prelbc.juvomos.com/',
        };
        // Limpiar valores undefined
        Object.keys(capturedHeaders).forEach(key => {
          if (!capturedHeaders[key]) delete capturedHeaders[key];
        });

        page.off('request', listener);
        resolve();
      }
    };
    page.on('request', listener);
  });

  // Navegar a la página de cargos para disparar la petición GET
  await page.goto('/admin/billing/charges'); // Navegar a cualquiera.
  await page.waitForLoadState('networkidle');

  // Esperar a capturar los headers (máximo 10s)
  await Promise.race([
    headersPromise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout capturando headers')), 10000)),
  ]);

  if (!capturedHeaders) throw new Error('No se pudieron capturar los headers');

  return capturedHeaders;
}