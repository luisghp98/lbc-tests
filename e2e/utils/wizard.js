const { expect } = require('@playwright/test');
const { OnboardingPage, SLOW } = require('../pages/OnboardingPage');
const { qaChild, qaEmail } = require('./qa');

const haceAnios = (n) => { const d = new Date(); d.setFullYear(d.getFullYear() - n); return d; };

/** Registra un niño QA completo por el wizard (tipo Full Time, primera aula habilitada) y devuelve su id. */
async function registrarNino(page, limpieza, { tipo = /Full Time —/ } = {}) {
  const onb = new OnboardingPage(page);
  const nino = qaChild();
  await onb.goto();
  await onb.datosNino({ ...nino, nacimiento: haceAnios(4) });
  await onb.siguiente('Next: Family Member');
  await onb.familiarNuevo(qaEmail());
  await onb.siguiente('Next: Medical Info');
  await onb.siguiente('Next: Enrollment');
  await onb.matricula({ tipo, aula: 'habilitada' });
  const envio = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().includes('/admin/children/new'), { timeout: SLOW });
  await onb.completar();
  await envio;
  await page.waitForURL(/\/admin\/children\/[0-9a-f-]{36}/, { timeout: 120_000 });
  const id = page.url().match(/children\/([0-9a-f-]{36})/)[1];
  limpieza.trackChild(id);
  return { id, nino };
}

module.exports = { registrarNino };
