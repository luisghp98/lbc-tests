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
  async familiarNuevo(email) {
    await this.page.getByPlaceholder('Search by name or email').fill(email);
    await this.page.locator('button', { hasText: 'Search' }).click();
    await expect(this.page.getByRole('heading', { name: 'Create New Family Member Profile' })).toBeVisible({ timeout: SLOW });
    await this.page.locator('#parent-info-first-name').fill('QA-Parent');
    await this.page.locator('#parent-info-last-name').fill('QA-Familiar');
    await this.elegir(/Type of ID/, 'Passport');
    await this.page.locator('#parent-info-government-id-last-4-characters-2').fill('A123');
    await this.page.locator('#parent-info-phone-2').fill('5552345678');
    await this.page.getByRole('checkbox', { name: /All Required Documents Submitted/ }).check();
  }

  async metodoPago(nombre) {
    await this.elegir(/Register a payment method/, nombre);
  }

  // Paso 3
  async medicacion({ nombre, inicio, fin }) {
    await this.page.getByPlaceholder('e.g., Albuterol').fill(nombre);
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

  /** Envía el registro. El niño se localiza por API (la app no siempre redirige al detalle). */
  async completar() {
    await this.page.getByRole('button', { name: 'Complete Enrollment' }).click();
  }
}

module.exports = { OnboardingPage, SLOW };
