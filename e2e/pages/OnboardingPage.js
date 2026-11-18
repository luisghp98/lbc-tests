const { expect } = require('@playwright/test');

const SLOW = 180_000; // conexión lenta: cada pantalla puede tardar minutos
const MESES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const etiquetaDia = (d) => `${MESES[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;

/** Wizard "Add New Child": Child Info → Family Member → Medical Info → Enrollment. */
class OnboardingPage {
  constructor(page) {
    this.page = page;
    this.main = page.locator('main');
  }

  async goto() {
    // La app restaura el borrador del wizard (sessionStorage); cada prueba debe empezar en el paso 1.
    if (!this.sinBorrador) {
      await this.page.addInitScript(() => sessionStorage.removeItem('child_enrollment_form_data'));
      this.sinBorrador = true;
    }
    await this.page.goto('/admin/children/new');
    await this.page.getByRole('heading', { name: 'Add New Child' }).waitFor({ timeout: SLOW });
  }

  async siguiente(boton) {
    await this.page.getByRole('button', { name: boton }).click();
  }

  async elegir(combo, opcion) {
    await this.page.getByRole('combobox', { name: combo }).click();
    await this.page.getByRole('option', { name: opcion, exact: typeof opcion === 'string' }).first().click();
  }

  // Calendario: navega mes a mes con "Previous month"/"Next month" hasta ver el día pedido.
  async fecha(disparador, fecha, direccion) {
    await disparador.click();
    const dia = this.page.getByRole('button', { name: etiquetaDia(fecha), exact: true });
    const nav = this.page.locator(`button[aria-label="${direccion === 'atras' ? 'Previous month' : 'Next month'}"]`).first();
    for (let i = 0; i < 400 && !(await dia.isVisible()); i++) await nav.click();
    await dia.click();
  }

  // Paso 1
  async datosNino({ firstName, lastName, gender = 'Male', nacimiento, foto }) {
    await this.page.getByRole('textbox', { name: 'First Name *' }).fill(firstName);
    await this.page.getByRole('textbox', { name: 'Last Name *' }).fill(lastName);
    if (nacimiento) await this.fecha(this.page.locator('#child-info-step-birth-date'), nacimiento, 'atras');
    await this.elegir('Gender *', gender);
    if (foto) await this.page.locator('input[type="file"]').setInputFiles(foto);
    await this.page.getByRole('checkbox', { name: /Acceptance of Policies/ }).check();
    await this.page.getByRole('checkbox', { name: /All Required Documents Submitted/ }).check();
  }

  errorFoto() {
    return this.main.getByText(/File (size|type)/);
  }

  // Paso 2: familiar nuevo (no se guarda nada hasta completar el registro)
  async familiarNuevo(email, extra = {}) {
    await this.page.getByPlaceholder('Search by name or email').fill(email);
    await this.page.locator('button', { hasText: 'Search' }).click();
    await expect(this.page.getByRole('heading', { name: 'Create New Family Member Profile' })).toBeVisible({ timeout: SLOW });
    await this.page.locator('#parent-info-first-name').fill('QA-Parent');
    await this.page.locator('#parent-info-last-name').fill('QA-Familiar');
    await this.elegir(/Type of ID/, 'Passport');
    await this.page.locator('#parent-info-government-id-last-4-characters-2').fill('A123');
    await this.page.locator('#parent-info-phone-2').fill('5552345678');
    if (extra.parentesco) await this.elegir(/Relationship to Child/, extra.parentesco);
    const marcar = { principal: /Primary Contact/i, recoger: /Authorized to Pick Up Child/i, medico: /Can Authorize Medical Treatment/i, actividades: /Can Authorize Activities/i };
    for (const [clave, nombre] of Object.entries(marcar)) if (extra[clave]) await this.page.getByRole('checkbox', { name: nombre }).check();
    await this.page.getByRole('checkbox', { name: /All Required Documents Submitted/ }).check();
  }

  async metodoPago(nombre) {
    await this.elegir(/Register a payment method/, nombre);
  }

  // Paso 3
  /** Campo de texto por su etiqueta (algunas etiquetas no están asociadas al campo: se usa el primero que la sigue). */
  campo(etiqueta) {
    return this.page.getByLabel(etiqueta, { exact: true })
      .or(this.page.locator(`xpath=//label[normalize-space()="${etiqueta}"]/following::input[1]`)).first();
  }

  async alergia(texto) {
    await this.page.getByPlaceholder('Type allergy and press Enter').fill(texto);
    await this.page.getByRole('button', { name: 'Add allergy' }).click();
  }

  async condicion({ nombre, severidad, notas }) {
    await this.page.getByPlaceholder('e.g., Asthma').fill(nombre);
    if (severidad) await this.elegir(/Severity/, severidad);
    if (notas) await this.page.getByPlaceholder('e.g., Keep the inhaler nearby').fill(notas);
    await this.page.getByRole('button', { name: 'Add condition' }).click();
  }

  async necesidades(texto) {
    await this.page.getByPlaceholder('Special needs and accommodations').fill(texto);
  }

  async medicacion({ nombre, dosis, frecuencia, instrucciones, inicio, fin }) {
    await this.page.getByPlaceholder('e.g., Albuterol').fill(nombre);
    if (dosis) await this.campo('Dosage').fill(dosis);
    if (frecuencia) await this.campo('Frequency').fill(frecuencia);
    if (instrucciones) await this.page.getByPlaceholder('e.g., Administer after lunch').fill(instrucciones);
    const fechas = this.page.locator('button', { hasText: 'Select date' });
    await this.fecha(fechas.nth(0), inicio, 'adelante');
    if (fin) await this.fecha(this.page.locator('button', { hasText: 'Select date' }).first(), fin, 'adelante');
    await this.page.getByRole('button', { name: 'Add medication' }).click();
  }

  /** Abre el desplegable y elige la primera opción habilitada (ni el placeholder ni las cerradas por [NO STAFF], ratio o edad). */
  async primeraHabilitada(combo) {
    await this.page.getByRole('combobox', { name: combo }).click();
    const opciones = this.page.getByRole('option');
    for (let i = 0, n = await opciones.count(); i < n; i++) {
      const o = opciones.nth(i);
      const texto = (await o.innerText()).trim();
      if (!/^Select /.test(texto) && (await o.getAttribute('aria-disabled')) !== 'true' && (await o.isEnabled())) {
        await o.click();
        return texto;
      }
    }
    throw new Error('No hay ninguna opción habilitada en ' + combo);
  }

  /** Estado del aula en el desplegable del paso 4 (sin elegirla). */
  async opcionAula(nombre) {
    await this.page.getByRole('combobox', { name: /Classroom/ }).click();
    return this.page.getByRole('option', { name: new RegExp(nombre) });
  }

  // Paso 4: tipo de enrolamiento (agrega solo el servicio) y aula
  async matricula({ tipo = /Full Time —/, aula }) {
    await this.page.getByText('Step 4 of 4').waitFor({ timeout: SLOW });
    await expect(this.page.getByText('Loading enrollment options...')).toHaveCount(0, { timeout: SLOW });
    if (tipo) await this.elegir(/Enrollment Type/, tipo);
    if (aula === 'habilitada') await this.primeraHabilitada(/Classroom/);
    else if (aula) await this.elegir(/Classroom/, aula);
    await this.page.getByRole('checkbox', { name: /All Required Documents Submitted/ }).check();
  }

  /** Empieza a recoger errores de consola y respuestas fallidas (para diagnosticar). */
  vigilar() {
    this.problemas = [];
    const anotar = (t) => { if (this.problemas.length < 25 && !this.problemas.includes(t)) this.problemas.push(t); };
    const ruta = (u) => { try { return new URL(u).pathname; } catch { return u.slice(0, 60); } };
    this.page.on('console', (m) => { if (m.type() === 'error') anotar(`consola: ${m.text().slice(0, 160)}`); });
    this.page.on('response', (r) => { if (r.status() >= 400) anotar(`${r.status()} ${r.request().method()} ${ruta(r.url())}`); });
    this.page.on('requestfailed', (r) => anotar(`falló ${r.method()} ${ruta(r.url())} ${r.failure() ? r.failure().errorText : ''}`));
  }

  /** Envía el registro. El niño se localiza por API (la app no siempre redirige al detalle). */
  async completar() {
    await this.page.getByRole('button', { name: 'Complete Enrollment' }).click();
  }
}

module.exports = { OnboardingPage, SLOW };
