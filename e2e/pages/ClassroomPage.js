const { expect } = require('@playwright/test');
const { getFormFieldByLabel } = require('../utils/helpers');

class ClassroomPage {
  constructor(page) {
    this.page = page;

    // --- Campos con label (usamos getFormFieldByLabel) ---
    // No los guardamos como propiedades fijas porque el helper los busca dinámicamente.
    // En su lugar, definimos métodos internos para obtenerlos.
  }

  // -------------------------------------------------------------------------
  // Métodos privados para obtener campos por label
  // -------------------------------------------------------------------------

  _getField(label) {
    return getFormFieldByLabel(this.page, label);
  }

  async _getSelectOptions(field) {
    if (!field) return [];
    return await field.locator('option').allInnerTexts().catch(() => []);
  }

  // -------------------------------------------------------------------------
  // Navegación
  // -------------------------------------------------------------------------

  async gotoNew() {
    await this.page.goto('/admin/classrooms/new', { waitUntil: 'domcontentloaded' }).catch(() => { });
    await this.page.waitForTimeout(2000);
    if (this.page.url().includes('/admin/classrooms/new')) {
      for (let i = 0; i < 45; i++) {
        const text = await this.page.evaluate(() => document.body.innerText);
        if (!text.includes('Loading')) return;
        await this.page.waitForTimeout(2000);
      }
      return;
    }
    console.log('  → WARN: Direct /new failed, navigating via list');
    await this.page.goto('/admin/classrooms', { waitUntil: 'domcontentloaded' }).catch(() => { });
    await this.page.waitForTimeout(3000);
    const addBtn = this.page.locator('a[href="/admin/classrooms/new"]');
    await addBtn.waitFor({ state: 'visible' }).catch(() => { });
    await addBtn.click().catch(() => { });
    await this.page.waitForURL('**/admin/classrooms/new').catch(() => { });
    for (let i = 0; i < 45; i++) {
      const text = await this.page.evaluate(() => document.body.innerText);
      if (!text.includes('Loading')) break;
      await this.page.waitForTimeout(2000);
    }
  }

  async gotoList() {
    await this.page.goto('/admin/classrooms');
    for (let i = 0; i < 45; i++) {
      const text = await this.page.evaluate(() => document.body.innerText);
      if (!text.includes('Loading')) break;
      await this.page.waitForTimeout(2000);
    }
    await this.page.waitForTimeout(2000);
  }

  async gotoEdit(classroomId) {
    await this.page.goto(`/admin/classrooms/${classroomId}`);
    await this.page.waitForFunction(() => !document.body.innerText.includes('Loading')).catch(() => { });
    await this.page.waitForSelector('h1:has-text("Classroom")');
    await this.page.getByRole('link', { name: /edit classroom/i }).click();
    await this.page.waitForURL(`**/admin/classrooms/${classroomId}/edit`).catch(() => { });
    await this.page.waitForFunction((id) => {
      return document.body.innerText.includes('Classroom Name') ||
        document.location.href.includes('/edit');
    }, classroomId);
    await this.page.waitForTimeout(1500);
  }

  // -------------------------------------------------------------------------
  // Fill Basic Info
  // -------------------------------------------------------------------------

  async fillBasicInfo({ name, code, campus, level, size, status }) {
    // Classroom Name *
    const nameField = this._getField('Classroom Name *');
    if (nameField && name !== undefined) {
      await nameField.fill(name);
    }

    // Classroom Code *
    const codeField = this._getField('Classroom Code *');
    if (codeField && code !== undefined) {
      await codeField.fill(code);
    }

    // Campus
    const campusField = this._getField('Campus');
    if (campusField && campus !== undefined) {
      await campusField.selectOption(campus);
    }

    // Level
    const levelField = this._getField('Level');
    if (levelField && level !== undefined) {
      await levelField.selectOption(level);
    }

    // Classroom Size (sq ft)
    const sizeField = this._getField('Classroom Size (sq ft)');
    if (sizeField && size !== undefined) {
      await sizeField.fill(String(size));
    }

    // Status
    const statusField = this._getField('Status');
    if (statusField && status !== undefined) {
      await statusField.selectOption(status);
    }
  }

  // -------------------------------------------------------------------------
  // Fill Physical Location
  // -------------------------------------------------------------------------

  async fillPhysicalLocation({ building, floor, roomNumber }) {
    const buildingField = this._getField('Building');
    if (buildingField && building !== undefined) {
      await buildingField.fill(building);
    }

    const floorField = this._getField('Floor');
    if (floorField && floor !== undefined) {
      await floorField.fill(String(floor));
    }

    const roomField = this._getField('Room Number');
    if (roomField && roomNumber !== undefined) {
      await roomField.fill(roomNumber);
    }
  }

  // -------------------------------------------------------------------------
  // Operating Hours (se mantienen con selectores relativos porque no hay labels únicos)
  // -------------------------------------------------------------------------

  async setOperatingHours(dayIndex, { enabled, start, end }) {
    // Los checkboxes de días están dentro de una sección, usamos selectores relativos
    const dayCheckboxes = this.page.locator('input[type="checkbox"]').filter({ has: this.page.locator('..').locator('label') });
    // Pero mejor: localizar por el texto del día (Monday, Tuesday, etc.)
    const days = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
    const dayLabel = days[dayIndex];
    if (!dayLabel) return;

    // Encontrar el checkbox asociado al día
    const checkbox = this.page.locator(`label:has-text("${dayLabel}")`).locator('..').locator('input[type="checkbox"]').first();
    if (enabled !== undefined) {
      const isChecked = await checkbox.isChecked().catch(() => false);
      if (enabled !== isChecked) {
        await checkbox.click();
      }
    }

    // Los inputs de tiempo: buscamos dentro del mismo contenedor del día
    const container = this.page.locator(`label:has-text("${dayLabel}")`).locator('..');
    const timeInputs = container.locator('input[type="time"]');
    if (start) {
      const startInput = timeInputs.nth(0);
      if (await startInput.isVisible().catch(() => false)) {
        await startInput.fill(start);
      }
    }
    if (end) {
      const endInput = timeInputs.nth(1);
      if (await endInput.isVisible().catch(() => false)) {
        await endInput.fill(end);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Staff Ratio (select con label)
  // -------------------------------------------------------------------------

  async selectStaffRatio(ratioValue) {
    const ratioField = this._getField('Staff Ratio');
    if (ratioField) {
      await ratioField.selectOption(ratioValue);
    }
  }

  // -------------------------------------------------------------------------
  // Amenities (checkboxes con label)
  // -------------------------------------------------------------------------

  async toggleAmenity(name, checked) {
    const cb = this._getField(name);
    if (cb && await cb.isVisible().catch(() => false)) {
      const isChecked = await cb.isChecked().catch(() => false);
      if (checked !== isChecked) {
        await cb.click();
      }
    }
  }

  // -------------------------------------------------------------------------
  // Notes
  // -------------------------------------------------------------------------

  async fillNotes(notes) {
    // El campo de notas tiene label "Notes" o "Additional Notes"
    const notesField = this._getField('Notes');
    if (notesField && notes !== undefined) {
      await notesField.fill(notes);
    }
  }

  // -------------------------------------------------------------------------
  // Botones
  // -------------------------------------------------------------------------

  async clickCreate() {
    const createBtn = this.page.getByRole('button', { name: /Create Classroom/i });
    await createBtn.scrollIntoViewIfNeeded();
    await this.page.waitForTimeout(500);
    await createBtn.click();
    await this.page.waitForTimeout(3000);
  }

  async clickUpdate() {
    const updateBtn = this.page.getByRole('button', { name: /Save Changes/i });
    await updateBtn.click();
    await this.page.waitForTimeout(2000);
  }

  // -------------------------------------------------------------------------
  // Helper para seleccionar el primer campus disponible (útil para pruebas)
  // -------------------------------------------------------------------------

  async selectFirstAvailableCampus() {
    const campusField = this._getField('Campus');
    if (!campusField) return;
    await this.page.waitForTimeout(2000);
    const hasOptions = await campusField.evaluate(sel => {
      return Array.from(sel.options).some(o => o.value && o.value !== '');
    }).catch(() => false);
    if (hasOptions) {
      const value = await campusField.evaluate(sel => {
        const opt = Array.from(sel.options).find(o => o.value && o.value !== '');
        return opt ? opt.value : null;
      });
      if (value) await campusField.selectOption(value);
    } else {
      console.log('  → WARN: No campuses available, proceeding without campus selection');
    }
  }

  // -------------------------------------------------------------------------
  // Expect success / validation
  // -------------------------------------------------------------------------

  async expectSuccessMessage(createdName) {
    if (createdName) {
      const id = await this.verifyCreationByAPI(createdName);
      if (id) return id;
    }
    await expect(async () => {
      const url = this.page.url();
      const onList = url.includes('/admin/classrooms') && !url.includes('/new');
      if (onList) {
        const errorToast = await this.page.locator('.error-toast, .alert-error, [data-sonner-toast][data-type="error"]').first().isVisible().catch(() => false);
        expect(errorToast).toBeFalsy();
        return;
      }
      const successToast = await this.page.locator('[data-sonner-toast][data-type="success"], [data-sonner-toast]:has-text("success"), [data-sonner-toast]:has-text("created"]').first().isVisible().catch(() => false);
      expect(successToast).toBeTruthy();
    }).toPass();
    return null;
  }

  async expectValidationError() {
    await expect(this.page).toHaveURL(/\/new$/);
  }

  // -------------------------------------------------------------------------
  // API Helpers (se mantienen igual)
  // -------------------------------------------------------------------------

  async getAuthToken() {
    const cookies = await this.page.context().cookies();
    const authCookie = cookies.find(c => c.name === 'sb-api-auth-token');
    if (!authCookie) {
      console.log('  → WARN: sb-api-auth-token cookie not found');
      return null;
    }
    try {
      const payload = JSON.parse(Buffer.from(authCookie.value.replace('base64-', ''), 'base64').toString());
      return payload.access_token;
    } catch (e) {
      console.log('  → Error decoding auth cookie:', e.message);
      return null;
    }
  }

  async verifyCreationByAPI(name) {
    const token = await this.getAuthToken();
    if (!token) return null;
    try {
      const encoded = encodeURIComponent(name).replace(/%20/g, '+');
      const apiHost = process.env.API_BASE_URL || 'https://api.presupbase.juvomos.com';
      const res = await fetch(apiHost + '/rest/v1/classrooms?select=id,classroom_name&classroom_name=eq.' + encoded, {
        headers: { 'Authorization': 'Bearer ' + token, 'apikey': process.env.API_KEY }
      });
      const data = await res.json();
      if (data && data.length > 0) return data[0].id;
      console.log(`  → API: no classroom found with name="${name}"`);
    } catch (e) { console.log('  → API verification error:', e.message); }
    return null;
  }

  async getClassroomIdFromList(name) {
    const apiId = await this.verifyCreationByAPI(name);
    if (apiId) return apiId;
    await this.page.goto('/admin/classrooms');
    await this.page.waitForFunction(() => !document.body.innerText.includes('Loading')).catch(() => { });
    await this.page.waitForTimeout(3000);
    const searchBox = this.page.locator('input[placeholder*="Search"]');
    if (await searchBox.isVisible().catch(() => false)) {
      await searchBox.fill(name);
      await this.page.waitForTimeout(3000);
    }
    const id = await this.page.evaluate((searchName) => {
      const links = document.querySelectorAll('a[href*="/edit"], a[href*="/classrooms/"]');
      for (const link of links) {
        const match = link.href.match(/\/admin\/classrooms\/([^/]+)/);
        if (match && match[1] && match[1].length > 20) {
          const row = link.closest('tr') || link.parentElement || link;
          if (row && row.textContent.includes(searchName)) {
            return match[1];
          }
        }
      }
      return null;
    }, name);
    if (!id) throw new Error(`Classroom named "${name}" not found in list`);
    return id;
  }
}

module.exports = { ClassroomPage };