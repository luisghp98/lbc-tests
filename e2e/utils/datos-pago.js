// ───────────────────────────────────────────────────────────────────────────────────────────────
// Datos de pago de Card y ACH para el onboarding (CP-ONB-14 y CP-ONB-15).
//
// Este archivo solo LEE los valores de variables de entorno: aquí no hay ningún número de tarjeta ni de cuenta.
// Los valores los pones tú (quien lea esto), nunca el asistente que mantiene la suite, que tampoco ejecuta estos casos con datos.
//
// 1) Valores
//      · en local: archivo `.env` (está en .gitignore; nunca se sube)
//      · en GitHub: Settings > Secrets and variables > Actions > pestaña *Secrets*
//
//      PAGO_HABILITADO=si              ← interruptor. Sin él, los casos con datos de pago salen PENDIENTE y no teclean nada.
//      PAGO_TARJETA_NUMERO             número de la tarjeta de prueba
//      PAGO_TARJETA_VENCIMIENTO        con el formato del campo: MM/YY
//      PAGO_TARJETA_CVV
//      PAGO_TARJETA_NUMERO_INVALIDO    (opcional, caso negativo)
//      PAGO_ACH_TITULAR                nombre de la cuenta ("Account Name")
//      PAGO_ACH_CUENTA                 número de cuenta
//      PAGO_ACH_ROUTING                routing number
//      PAGO_ACH_CUENTA_INVALIDA        (opcional, caso negativo)
//      PAGO_ACH_TIPO_CUENTA            (opcional, por defecto Checking)
//      PAGO_ACH_TIPO_TITULAR           (opcional, por defecto Personal)
//
//    En GitHub, además, hay que lanzar el workflow con la entrada `datos_de_pago` = si (por defecto es no).
//
// 2) Cómo se usa cada campo (verificado en el paso 2 del wizard, sin teclear nada):
//      · Card: campos en la propia página (sin iframes): "Card Number *", "Expiry *" (MM/YY) y "CVV *", y el botón "Verify Card Details".
//      · ACH: tres iframes de secure.nmi.com (títulos "Account Name", "Routing Number" y "Account Number"; campos #checkname, #checkaba
//        y #checkaccount), dos listas ("Account type *" y "Holder type *") y el botón "Validate bank account".
//
// 3) Este código NO se ha ejecutado con datos reales. Si la primera vez algo no coincide (por ejemplo el nombre de una opción de las
//    listas de ACH o la espera tras verificar), ajústalo aquí. NO imprimas los valores (ni en console.log ni en mensajes de error):
//    el log de GitHub es público.
// ───────────────────────────────────────────────────────────────────────────────────────────────

const { expect } = require('@playwright/test');

const IMPLEMENTADO = { tarjeta: true, ach: true };

const env = (n) => process.env[n] || '';
const datosTarjeta = (invalida = false) => ({
  // Con o sin espacios en la variable: el campo de la página pone los espacios solo.
  numero: (invalida ? env('PAGO_TARJETA_NUMERO_INVALIDO') : env('PAGO_TARJETA_NUMERO')).replace(/\s+/g, ''),
  vencimiento: env('PAGO_TARJETA_VENCIMIENTO'), cvv: env('PAGO_TARJETA_CVV'),
});
const datosACH = (invalida = false) => ({
  titular: env('PAGO_ACH_TITULAR'), cuenta: invalida ? env('PAGO_ACH_CUENTA_INVALIDA') : env('PAGO_ACH_CUENTA'), routing: env('PAGO_ACH_ROUTING'),
  tipoCuenta: env('PAGO_ACH_TIPO_CUENTA') || 'Checking', tipoTitular: env('PAGO_ACH_TIPO_TITULAR') || 'Personal',
});

/** Motivo por el que los casos con datos de pago no se pueden ejecutar, o null si están listos. */
function pendiente(metodo) {
  if (env('PAGO_HABILITADO') !== 'si') return 'Los casos con datos de pago solo se ejecutan cuando una persona los habilita (PAGO_HABILITADO=si)';
  const clave = metodo === 'Card' ? 'tarjeta' : 'ach';
  if (!IMPLEMENTADO[clave]) return `Falta escribir el código de ${metodo} en e2e/utils/datos-pago.js (y poner IMPLEMENTADO.${clave} = true)`;
  const d = metodo === 'Card' ? datosTarjeta() : datosACH();
  if (Object.values(d).some((v) => !v)) return `Faltan variables PAGO_* de ${metodo} en el .env o en los secretos de GitHub`;
  return null;
}

/** Elige una opción de una lista del wizard por su nombre accesible y el inicio del texto de la opción. */
async function elegirOpcion(page, lista, opcion) {
  await page.getByRole('combobox', { name: lista }).click();
  await page.getByRole('option', { name: new RegExp(`^${opcion}`, 'i') }).first().click();
}

/**
 * Paso 2 del wizard con "Card" ya elegido: escribe los datos de la tarjeta y pulsa "Verify Card Details".
 * @param {import('@playwright/test').Page} page
 * @param {{numero: string, vencimiento: string, cvv: string}} datos
 */
async function llenarTarjeta(page, datos) {
  await page.getByLabel('Card Number *').fill(datos.numero);
  await page.getByLabel('Expiry *').fill(datos.vencimiento);
  await page.getByLabel('CVV *').fill(datos.cvv);
  const verificar = page.getByRole('button', { name: 'Verify Card Details' });
  await expect(verificar, 'el botón de verificar está disponible').toBeEnabled();
  await verificar.click();
  // La verificación llama al proveedor: se espera a que la red quede en calma. Si la aplicación muestra un mensaje de éxito
  // o de error, se puede esperar aquí por ese texto en lugar de la red.
  await page.waitForLoadState('networkidle');
}

/**
 * Paso 2 del wizard con "ACH" ya elegido: escribe los datos de la cuenta bancaria y pulsa "Validate bank account".
 * @param {import('@playwright/test').Page} page
 * @param {{titular: string, cuenta: string, routing: string, tipoCuenta: string, tipoTitular: string}} datos
 */
async function llenarACH(page, datos) {
  await page.frameLocator('iframe[title="Account Name"]').locator('#checkname').fill(datos.titular);
  await page.frameLocator('iframe[title="Routing Number"]').locator('#checkaba').fill(datos.routing);
  await page.frameLocator('iframe[title="Account Number"]').locator('#checkaccount').fill(datos.cuenta);
  await elegirOpcion(page, 'Account type *', datos.tipoCuenta);
  await elegirOpcion(page, 'Holder type *', datos.tipoTitular);
  const validar = page.getByRole('button', { name: 'Validate bank account' });
  await expect(validar, 'el botón de validar está disponible').toBeEnabled();
  await validar.click();
  await page.waitForLoadState('networkidle');
}

/**
 * Opcional. Paso 4, justo antes de "Complete Enrollment": si el proveedor pide verificar el pago en ese paso, hazlo aquí.
 * Por defecto no hace nada.
 */
async function alCompletar(page, metodo) { // eslint-disable-line no-unused-vars
}

module.exports = { IMPLEMENTADO, datosTarjeta, datosACH, pendiente, llenarTarjeta, llenarACH, alCompletar };
