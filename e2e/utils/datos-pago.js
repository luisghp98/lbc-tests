// ───────────────────────────────────────────────────────────────────────────────────────────────
// ÚNICO archivo que una persona debe completar para que el onboarding corra con tarjeta y con ACH.
//
// Por qué: el asistente que mantiene esta suite no escribe números de tarjeta ni de cuenta bancaria
// (ni siquiera los de prueba). Todo lo demás de los casos de Card y ACH ya está escrito: elegir el
// método, marcar o no la autorización de recurrencia, completar el registro y comprobar la factura.
// Aquí solo falta "teclear" los datos en los campos seguros y verificarlos.
//
// 1) Valores: NO van en el código. Se leen de variables de entorno:
//      · en local: archivo `.env` (está en .gitignore; nunca se sube)
//      · en GitHub: Settings > Secrets and variables > Actions > pestaña *Secrets* (el workflow ya las pasa)
//
//      PAGO_TARJETA_NUMERO        PAGO_TARJETA_VENCIMIENTO (MM/AA)     PAGO_TARJETA_CVV     PAGO_TARJETA_CP
//      PAGO_ACH_TITULAR           PAGO_ACH_CUENTA                      PAGO_ACH_ROUTING
//      (casos negativos, opcionales)  PAGO_TARJETA_NUMERO_INVALIDO     PAGO_ACH_CUENTA_INVALIDA
//
// 2) Código: completa `llenarTarjeta` y `llenarACH` (más abajo). Pistas:
//      · en el paso 2 del wizard, tras elegir el método, los campos de pago están en iframes del proveedor
//        (MX Merchant para tarjeta, secure.nmi.com para ACH): usa `page.frameLocator(...)`.
//      · la tarjeta de prueba solo aprueba con montos menores a 10 USD (ver el producto QA-lbc-Matricula-5USD).
//      · NO imprimas los valores (ni en console.log ni en mensajes de error): el log de GitHub es público.
//
// 3) Cuando termines, cambia a `true` la bandera de `IMPLEMENTADO`. Mientras sea `false` (o falten las
//    variables), los casos de Card y ACH con datos aparecen como PENDIENTE en el informe.
// ───────────────────────────────────────────────────────────────────────────────────────────────

const IMPLEMENTADO = { tarjeta: false, ach: false };

const env = (n) => process.env[n] || '';
const datosTarjeta = (invalida = false) => ({
  numero: invalida ? env('PAGO_TARJETA_NUMERO_INVALIDO') : env('PAGO_TARJETA_NUMERO'),
  vencimiento: env('PAGO_TARJETA_VENCIMIENTO'), cvv: env('PAGO_TARJETA_CVV'), cp: env('PAGO_TARJETA_CP'),
});
const datosACH = (invalida = false) => ({
  titular: env('PAGO_ACH_TITULAR'), cuenta: invalida ? env('PAGO_ACH_CUENTA_INVALIDA') : env('PAGO_ACH_CUENTA'), routing: env('PAGO_ACH_ROUTING'),
});

/** Motivo por el que los casos con datos de pago no se pueden ejecutar, o null si están listos. */
function pendiente(metodo) {
  const clave = metodo === 'Card' ? 'tarjeta' : 'ach';
  if (!IMPLEMENTADO[clave]) return `Falta escribir el código de ${metodo} en e2e/utils/datos-pago.js (y poner IMPLEMENTADO.${clave} = true)`;
  const d = metodo === 'Card' ? datosTarjeta() : datosACH();
  if (Object.values(d).some((v) => !v)) return `Faltan variables PAGO_* de ${metodo} en el .env o en los secretos de GitHub`;
  return null;
}

/**
 * Paso 2 del wizard con "Card" ya elegido: escribe los datos de la tarjeta y verifícalos.
 * @param {import('@playwright/test').Page} page
 * @param {{numero: string, vencimiento: string, cvv: string, cp: string}} datos
 */
async function llenarTarjeta(page, datos) { // eslint-disable-line no-unused-vars
  // TODO (persona): completar aquí.
  throw new Error('llenarTarjeta sin implementar');
}

/**
 * Paso 2 del wizard con "ACH" ya elegido: escribe los datos de la cuenta bancaria.
 * @param {import('@playwright/test').Page} page
 * @param {{titular: string, cuenta: string, routing: string}} datos
 */
async function llenarACH(page, datos) { // eslint-disable-line no-unused-vars
  // TODO (persona): completar aquí.
  throw new Error('llenarACH sin implementar');
}

/**
 * Opcional. Paso 4, justo antes de "Complete Enrollment": si el proveedor pide verificar el pago en ese paso
 * (por ejemplo "Verify Card Details"), hazlo aquí. Por defecto no hace nada.
 */
async function alCompletar(page, metodo) { // eslint-disable-line no-unused-vars
}

module.exports = { IMPLEMENTADO, datosTarjeta, datosACH, pendiente, llenarTarjeta, llenarACH, alCompletar };
