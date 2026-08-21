const { expect } = require('@playwright/test');

const METHOD_LABELS = ['Card', 'Cash', 'Bank Transfer', 'Check', 'ACH'];

/**
 * Page Object de Settings > School > Payment Methods.
 *
 * El checkbox de cada método SÍ está envuelto en un <label> (título +
 * descripción), así que su nombre accesible es "Card Families pay by card...",
 * "Cash Record a cash payment...", etc. — confirmado vía snapshot de
 * accesibilidad. Por eso se localiza con getByRole('checkbox', {name}), que
 * usa el nombre accesible ya calculado por el navegador, en vez de intentar
 * adivinar la estructura del DOM con filtros de texto (ese enfoque resultó
 * ambiguo: en una corrida real sólo alternó el primer método de la lista y
 * dejó los demás intactos sin lanzar ningún error).
 */
class SettingsPage {
  constructor(page) {
    this.page = page;
  }

  async goto() {
    await this.page.goto('/admin/settings?tab=school', { waitUntil: 'domcontentloaded' });
  }

  async openPaymentMethodsSection() {
    const header = this.page.getByRole('button', { name: /Payment Methods/ });
    // El checkbox de cada método es sr-only: no sirve para decidir si la
    // sección está expandida. El párrafo de ayuda sólo se renderiza cuando
    // la sección colapsable está abierta, así que es la señal confiable.
    const helpText = this.page.getByText('Payment methods your center accepts for tuition and other invoices.');
    if (!(await helpText.isVisible().catch(() => false))) {
      // force: true — un hermano visual (el switch decorativo, no el header)
      // suele quedar exactamente sobre las coordenadas del click en esta
      // página; el evento real igual llega y dispara el toggle de la sección.
      await header.click({ force: true });
    }
    await expect(helpText).toBeVisible();
  }

  /** Locator del checkbox de un método por su nombre accesible (empieza con Card, Cash, Bank Transfer, Check o ACH). */
  _toggleFor(label) {
    return this.page.getByRole('checkbox', { name: new RegExp('^' + label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) });
  }

  async isMethodEnabled(label) {
    return await this._toggleFor(label).isChecked();
  }

  async setMethodEnabled(label, enabled) {
    const toggle = this._toggleFor(label);
    // force: true — el switch decorativo (el span visible junto al input
    // sr-only) queda exactamente sobre el input e intercepta el puntero;
    // sin force, Playwright reintenta 60s sin nunca poder clickear.
    await toggle.setChecked(enabled, { force: true });
    await expect(toggle).toBeChecked({ checked: enabled });
  }

  async setAllMethods(enabled) {
    for (const label of METHOD_LABELS) {
      await this.setMethodEnabled(label, enabled);
    }
  }

  zeroMethodsBanner() {
    return this.page.getByText('No payment methods are enabled. Payments cannot be recorded for this center until at least one method is turned on.');
  }

  async clickSaveChanges() {
    await this.page.getByRole('button', { name: 'Save Changes' }).click();
  }

  methodLabels() {
    return METHOD_LABELS;
  }
}

module.exports = { SettingsPage, PAYMENT_METHOD_LABELS: METHOD_LABELS };
