const { getFormFieldByLabel } = require('../utils/helpers');

/**
 * OnboardingPage — Page object for the 4-step child enrollment wizard.
 *
 * Step flow:
 *   1. Child Information  → "Next: Parent/Guardian"
 *   2. Parent/Guardian   → "Next: Medical Info"   (needs a guardian added + relationship)
 *   3. Medical           → "Next: Enrollment"
 *   4. Enrollment        → "Complete Enrollment"   (needs classroom + enrollment type)
 */
class OnboardingPage {
  constructor(page) {
    this.page = page;
  }

  // -------------------------------------------------------------------------
  // Navegación y espera de carga
  // -------------------------------------------------------------------------
  async goto() {
    // Limpiar datos de sesión previos
    await this.page.evaluate(() => {
      try { sessionStorage.removeItem('child_enrollment_form_data'); } catch { }
    }).catch(() => { });

    const url = this.page.url();
    const base = url.replace(/\/admin.*$/, '');
    const target = `${base}/admin/children/new`;

    await this.page.goto(target, { timeout: 60000, waitUntil: 'domcontentloaded' });

    // Esperar a que el botón "Next: Parent/Guardian" esté visible (indica que el paso 1 está listo)
    const nextBtn = this.page.getByRole('button', { name: /Next: Parent\/Guardian/i });
    await nextBtn.waitFor({ state: 'visible', timeout: 90000 });
    console.log('  Wizard Step 1 ready');
  }

  // -------------------------------------------------------------------------
  // Helper para rellenar el formulario de nuevo parent en el paso 2
  // -------------------------------------------------------------------------
  async _fillNewParentForm(email) {
    // First Name *
    const firstNameField = getFormFieldByLabel(this.page, 'First Name *');
    if (firstNameField) await firstNameField.fill('Test');

    // Last Name *
    const lastNameField = getFormFieldByLabel(this.page, 'Last Name *');
    if (lastNameField) await lastNameField.fill('Parent');

    // Type of ID *
    const idTypeField = getFormFieldByLabel(this.page, 'Type of ID *');
    if (idTypeField) {
      const opts = await idTypeField.locator('option').allInnerTexts();
      const pick = opts.find(o => o.trim() && !/select/i.test(o)) || opts[1];
      await idTypeField.selectOption({ label: pick.trim() });
    }

    // Government ID (Last 4 Digits) *
    const govIdField = getFormFieldByLabel(this.page, 'Government ID (Last 4 Digits) *');
    if (govIdField) await govIdField.fill('A123');

    // Phone *
    const phoneField = getFormFieldByLabel(this.page, 'Phone *');
    if (phoneField) await phoneField.fill('(555) 234-5678');

    // Email * (ya debe estar lleno, pero aseguramos)
    // const emailField = getFormFieldByLabel(this.page, 'Email *');
    // if (emailField) await emailField.fill(email);

    // Relationship to Child *
    const relField = getFormFieldByLabel(this.page, 'Relationship to Child *');
    if (relField) {
      const opts = await relField.locator('option').allInnerTexts();
      const pick = opts.find(o => o.trim() && !/select/i.test(o) && /guardian|father|mother/i.test(o)) || opts[1];
      await relField.selectOption({ label: pick.trim() });
    }

    // Permissions (checkboxes)
    const permissionLabels = [
      'Primary Contact',
      'Can Pickup Child',
      'Can Authorize Medical Treatment',
      'Can Authorize Activities'
    ];
    for (const labelText of permissionLabels) {
      const cb = getFormFieldByLabel(this.page, labelText);
      if (cb && !(await cb.isChecked().catch(() => false))) {
        await cb.check();
      }
    }
    // En _fillNewParentForm y _handleExistingParent
    const docsCheckbox = this.page.locator('#all_documents_submitted_parent');
    if (await docsCheckbox.isVisible().catch(() => false)) {
      if (!(await docsCheckbox.isChecked().catch(() => false))) {
        await docsCheckbox.check();
      }
    }
    // Avanzar al paso 3 (hace clic en "Next: Medical Info")
    const nextBtn = this.page.getByRole('button', { name: /Next: Medical Info/i }).first();
    await nextBtn.click({ timeout: 10000 });
  }

  // -------------------------------------------------------------------------
  // STEP 1: Child Information
  // -------------------------------------------------------------------------
  async fillStep1({ firstName, lastName, birthDate, gender, govId } = {}) {
    const fName = getFormFieldByLabel(this.page, 'First Name *');
    if (fName) await fName.fill(firstName || 'Auto');

    const lName = getFormFieldByLabel(this.page, 'Last Name *');
    if (lName) await lName.fill(lastName || 'TestChild');

    const dobField = getFormFieldByLabel(this.page, 'Date of Birth *');
    if (dobField) await dobField.fill(birthDate || '2025-03-15');

    const genderField = getFormFieldByLabel(this.page, 'Gender *');
    if (genderField) {
      const opts = await genderField.locator('option').allInnerTexts().catch(() => []);
      const pick = (gender || 'Male').trim();
      if (opts.some(o => o.trim().toLowerCase() === pick.toLowerCase())) {
        await genderField.selectOption({ label: pick });
      } else if (opts.length > 1) {
        await genderField.selectOption({ index: 1 });
      }
    }

    if (govId) {
      const govInput = this.page.locator('input[placeholder="A123"]').first();
      if (await govInput.isVisible({ timeout: 3000 }).catch(() => false)) {
        await govInput.fill(govId);
      }
    }

    const policyCb = getFormFieldByLabel(this.page, 'I accept the terms and policies of the institution regarding child enrollment and care.');
    if (policyCb && !(await policyCb.isChecked().catch(() => false))) {
      await policyCb.check();
    }

    console.log('  Step 1 filled');
  }

  async goNextStep1() {
    const nextBtn = this.page.getByRole('button', { name: /Next: Parent\/Guardian/i });
    await nextBtn.click({ timeout: 10000 });

    // Esperar que el paso 2 se muestre (campo de búsqueda de email)
    const searchInput = this.page.locator('input[placeholder*="email" i]').first();
    await searchInput.waitFor({ state: 'visible', timeout: 30000 });
    console.log('  Step 2 ready');
  }

  // -------------------------------------------------------------------------
  // STEP 2: Parent/Guardian
  // -------------------------------------------------------------------------
  async fillStep2(parentEmail) {
    const email = parentEmail || 'cavoxal760@ellbit.com';

    const searchInput = this.page.locator('input[placeholder*="email" i]').first();
    const searchBtn = this.page.getByRole('button', { name: /search/i }).first();

    // 1. Esperar que el campo de búsqueda esté visible
    await searchInput.waitFor({ state: 'visible', timeout: 30000 });

    // 2. Escribir el email y buscar
    await searchInput.fill(email);
    await searchBtn.click();

    // 3. Esperar a que aparezca el formulario de creación o la tarjeta de parent existente
    const createSelector = 'h2:has-text("Create New Parent Profile"), h3:has-text("Create New Parent Profile")';
    const existingSelector = 'text=Parent found with';

    // Usar Promise.race para detectar el primero que aparezca
    const result = await Promise.race([
      this.page.waitForSelector(createSelector, { timeout: 15000 }).then(() => 'create'),
      this.page.waitForSelector(existingSelector, { timeout: 15000 }).then(() => 'existing')
    ]).catch(() => null);

    if (result === 'create') {
      // Apareció el formulario de creación
      await this._fillNewParentForm(email);
      return true;
    } else if (result === 'existing') {
      // Apareció la tarjeta de parent existente
      await this._handleExistingParent();
      return true;
    } else {
      console.log('  WARN: Could not detect either create form or existing parent card');
      return false;
    }
  }

  async _handleExistingParent() {
    // Seleccionar el radio "Create New Family" (asumiendo que está presente y es el primero)
    const newFamilyRadio = this.page.locator('input[type="radio"][value="new"]');
    if (await newFamilyRadio.isVisible().catch(() => false)) {
      const isChecked = await newFamilyRadio.isChecked().catch(() => false);
      if (!isChecked) {
        await newFamilyRadio.check();
      }
    } else {
      // Si no, seleccionar el primer radio disponible (alguna familia existente)
      const firstRadio = this.page.locator('input[type="radio"][name="family-selection"]').first();
      if (await firstRadio.isVisible().catch(() => false)) {
        await firstRadio.check();
      }
    }

    // Marcar el checkbox de documentos
    const docsCheckbox = this.page.locator('#all_documents_submitted_parent');
    if (await docsCheckbox.isVisible().catch(() => false)) {
      if (!(await docsCheckbox.isChecked().catch(() => false))) {
        await docsCheckbox.check();
      }
    }

    console.log('  Existing parent handled, ready for Next');
  }

  async goNextStep2() {
    const nextBtn = this.page.getByRole('button', { name: /Next: Medical Info/i });
    // Esperar hasta que el botón esté visible y habilitado (si no está visible, puede que ya estemos en step 3)
    try {
      await nextBtn.waitFor({ state: 'visible', timeout: 5000 });
      await nextBtn.click({ timeout: 10000 });
    } catch (e) {
      // Si el botón no aparece, podría ser que ya estemos en el paso 3
      const medicalTitle = this.page.locator('h2:has-text("Medical"), h3:has-text("Medical")').first();
      await medicalTitle.waitFor({ state: 'visible', timeout: 5000 });
      console.log('  Already on Step 3, skipping');
      return;
    }
    console.log('  Advanced to Step 3');
  }

  // -------------------------------------------------------------------------
  // STEP 3: Medical Info (se usa placeholder porque no hay labels claros)
  // -------------------------------------------------------------------------
  async fillStep3({ allergy } = {}) {
    if (allergy) {
      const input = this.page.locator('input[placeholder*="allergy" i]').first();
      if (await input.isVisible({ timeout: 3000 }).catch(() => false)) {
        await input.fill(allergy);
        await this.page.keyboard.press('Enter');
      }
    }
  }

  async goNextStep3() {
    const btn = this.page.getByRole('button', { name: /Next: Enrollment/i });
    await btn.waitFor({ state: 'visible', timeout: 20000 });
    await btn.click({ timeout: 10000 });
    console.log('  Advanced to Step 4');
  }

  // -------------------------------------------------------------------------
  // STEP 4: Enrollment
  // -------------------------------------------------------------------------
  async fillStep4({ classroom } = {}) {
    // Esperar que el formulario de inscripción esté listo (el botón "Complete Enrollment" o algún select)
    const completeBtn = this.page.getByRole('button', { name: /Complete Enrollment/i });
    await completeBtn.waitFor({ state: 'visible', timeout: 30000 });

    // --- Select Classroom ---
    const classroomField = getFormFieldByLabel(this.page, 'Select Classroom');
    if (classroomField && await classroomField.isVisible().catch(() => false)) {
      const optHandles = await classroomField.locator('option').elementHandles();
      let targetVal = null;
      for (const op of optHandles) {
        const dis = await op.isDisabled().catch(() => false);
        const txt = (await op.innerText()).trim();
        const val = await op.getAttribute('value').catch(() => '');
        if (!dis && txt && !/select classroom/i.test(txt) && val) { targetVal = val; break; }
      }
      if (targetVal) await classroomField.selectOption({ value: targetVal }).catch(() => { });
    }

    // --- Enrollment Type ---
    const typeField = getFormFieldByLabel(this.page, 'Enrollment Type');
    if (typeField && await typeField.isVisible().catch(() => false)) {
      const optHandles = await typeField.locator('option').elementHandles();
      let tVal = null;
      for (const op of optHandles) {
        const dis = await op.isDisabled().catch(() => false);
        const txt = (await op.innerText()).trim();
        const val = await op.getAttribute('value').catch(() => '');
        if (!dis && txt && !/select enrollment/i.test(txt) && val) { tVal = val; break; }
      }
      if (tVal) await typeField.selectOption({ value: tVal }).catch(() => { });
    }

    // --- Start Date ---
    const startDateField = getFormFieldByLabel(this.page, 'Start Date');
    if (startDateField && await startDateField.isVisible().catch(() => false)) {
      const today = new Date().toISOString().slice(0, 10);
      await startDateField.fill(today).catch(() => { });
    }

    // --- Academic Year ---
    const academicField = getFormFieldByLabel(this.page, 'Academic Year');
    if (academicField && await academicField.isVisible().catch(() => false)) {
      const tag = await academicField.evaluate(el => el.tagName.toLowerCase());
      if (tag === 'select') {
        const opts = await academicField.locator('option').allInnerTexts().catch(() => []);
        const currentYear = String(new Date().getFullYear());
        if (opts.some(o => o.trim() === currentYear)) {
          await academicField.selectOption({ label: currentYear }).catch(() => { });
        } else if (opts.length > 1) {
          await academicField.selectOption({ index: 1 }).catch(() => { });
        }
      } else {
        await academicField.fill(String(new Date().getFullYear())).catch(() => { });
      }
    }

    // --- Sync Products (botón) ---
    const syncBtn = this.page.getByRole('button', { name: /sync products/i });
    if (await syncBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await syncBtn.click({ timeout: 5000 }).catch(() => { });
    }

    // --- Agregar primer ítem ---
    const addFirst = this.page.getByRole('button', { name: /Add First Item/i });
    const addItem = this.page.getByRole('button', { name: /^Add Item$/i });
    if (await addFirst.isVisible({ timeout: 3000 }).catch(() => false)) {
      await addFirst.click({ timeout: 5000 }).catch(() => { });
    } else if (await addItem.isVisible({ timeout: 3000 }).catch(() => false)) {
      await addItem.click({ timeout: 5000 }).catch(() => { });
    }

    // Seleccionar un producto (ej. Matrícula) - no hay label, usamos el select dentro del item
    const productSelects = this.page.locator('select').filter({ has: this.page.locator('option:has-text("Matricula")') });
    if (await productSelects.count() > 0) {
      const sel = productSelects.first();
      await sel.selectOption({ label: /matricula/i }).catch(() => { });
      const qtyInput = this.page.locator('input[type="number"]').first();
      if (await qtyInput.isVisible({ timeout: 2000 }).catch(() => false)) {
        await qtyInput.fill('1').catch(() => { });
      }
    }

    // --- Aceptar documentos (checkbox) ---
    const docsCb = getFormFieldByLabel(this.page, 'All Required Documents Submitted (Mandatory for onboarding)');
    if (docsCb && !(await docsCb.isChecked().catch(() => false))) {
      await docsCb.check();
    }

    console.log('  Step 4 filled');
  }

  // -------------------------------------------------------------------------
  // Submit
  // -------------------------------------------------------------------------
  async submit() {
    const completeBtn = this.page.getByRole('button', { name: /Complete Enrollment/i }).first();
    await completeBtn.waitFor({ state: 'visible', timeout: 25000 });

    // Verificar si el botón está habilitado
    const isDisabled = await completeBtn.evaluate(b => b.disabled).catch(() => false);
    console.log('  submit: Complete Enrollment disabled=' + isDisabled);

    await completeBtn.click().catch(e => console.log('  submit click error: ' + e.message));

    // Esperar a que la URL cambie (redirección a la página del niño)
    try {
      await this.page.waitForURL(url => !url.includes('/new'), { timeout: 15000 });
      console.log('  submit: redirected to ' + this.page.url());
      return true;
    } catch (e) {
      console.log('  WARN: UI submit did not navigate; this is a real UI failure, NOT an API fallback');
      return false;
    }
  }

  // -------------------------------------------------------------------------
  // Método completo para ejecutar todo el wizard
  // -------------------------------------------------------------------------
  async completeWizard({ childData, parentEmail, classroom } = {}) {
    const c = childData || {};
    await this.fillStep1({
      firstName: c.firstName || 'Auto',
      lastName: c.lastName || 'TestChild',
      birthDate: c.birthDate || '2025-03-15',
      gender: c.gender || 'Male',
    });
    await this.goNextStep1();
    await this.fillStep2(parentEmail);
    await this.goNextStep2();
    await this.goNextStep3();
    await this.fillStep4({ classroom });
    await this.submit();
  }

  // -------------------------------------------------------------------------
  // Verificaciones y helpers
  // -------------------------------------------------------------------------
  async isSuccessVisible() {
    const url = this.page.url();
    if (url.includes('/admin/children/') && !url.includes('/new')) return true;

    try {
      await this.page.waitForFunction(() => {
        const body = document.body.innerText.toLowerCase();
        return body.includes('successful') || body.includes('created') || body.includes('child details');
      }, { timeout: 15000 });
      return true;
    } catch {
      return false;
    }
  }

  async getChildStatus() {
    try {
      await this.page.waitForFunction(() => !document.body.innerText.includes('Loading...'), { timeout: 20000 }).catch(() => { });
      const txt = (await this.page.innerText('body')).toLowerCase();
      if (txt.includes('pending')) return 'Pending';
      if (txt.includes('active')) return 'Active';
      if (txt.includes('graduated')) return 'Graduated';
      if (txt.includes('withdrawn')) return 'Withdrawn';
      if (txt.includes('transferred')) return 'Transferred';
    } catch { }
    return null;
  }

  async isDuplicateErrorVisible() {
    try {
      await this.page.waitForFunction(() => {
        const body = document.body.innerText.toLowerCase();
        return body.includes('already exists') || body.includes('duplicate');
      }, { timeout: 10000 });
      return true;
    } catch {
      return false;
    }
  }

  // -------------------------------------------------------------------------
  // Métodos auxiliares para API (se mantienen igual)
  // -------------------------------------------------------------------------
  async _getAuthHeaders() {
    const key = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiYW5vbiIsImlzcyI6InN1cGFiYXNlIiwiaWF0IjoxNzc5NDc4MzE5LCJleHAiOjE5MzcxNTgzMTl9.VbuKKxQWSNJ0GFSU8VE-RQFJhx1wR-kD8NPgpi83VbI';
    const ADMIN = 's5n4v1k1z6@ruutukf.com';
    const ADMIN_PASS = 'Algo12345';

    if (this._cachedAuth && Date.now() < this._cachedAuth.expiresAt) {
      return this._cachedAuth.headers;
    }

    try {
      const cookies = await this.page.context().cookies();
      const authCookie = cookies.find(c => c.name === 'sb-api-auth-token');
      if (authCookie) {
        const payload = JSON.parse(Buffer.from(authCookie.value.replace('base64-', ''), 'base64').toString());
        if (payload.access_token && payload.expires_at && payload.expires_at * 1000 > Date.now() + 60000) {
          this._cachedAuth = { headers: { 'Authorization': 'Bearer ' + payload.access_token, 'apikey': key }, expiresAt: Date.now() + 55000 };
          return this._cachedAuth.headers;
        }
      }
    } catch { }

    const loginBody = JSON.stringify({ email: ADMIN, password: ADMIN_PASS });
    const login = await this._httpsReq('/auth/v1/token?grant_type=password&email=' + encodeURIComponent(ADMIN), 'POST', { 'apikey': key, 'Content-Type': 'application/json' }, loginBody);
    if (login.status === 200 && login.json && login.json.access_token) {
      console.log('  auth: fresh token issued via auth endpoint');
      this._cachedAuth = { headers: { 'Authorization': 'Bearer ' + login.json.access_token, 'apikey': key }, expiresAt: Date.now() + 55000 };
      return this._cachedAuth.headers;
    }
    console.log('  auth: fresh-token fallback failed (status ' + login.status + ')');
    return { 'apikey': key };
  }

  _httpsReq(path, method, headers, body) {
    return new Promise((resolve) => {
      const data = body ? Buffer.from(body) : null;
      const req = require('https').request('https://api.presupbase.juvomos.com' + path, {
        method,
        headers: Object.assign({}, headers, data ? { 'Content-Length': data.length } : {})
      }, (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => {
          let json = null;
          try { json = JSON.parse(d); } catch { }
          resolve({ status: res.statusCode, body: d, json });
        });
      });
      req.on('error', (e) => resolve({ status: 0, body: e.message, json: null }));
      if (data) req.write(data);
      req.end();
    });
  }

  async _rest(table, method, body, select) {
    const headers = await this._getAuthHeaders();
    if (!headers) return { status: 0, json: null };
    const h = Object.assign({}, headers, { 'Content-Type': 'application/json' });
    if (select) h['Prefer'] = 'return=representation';
    const path = '/rest/v1/' + table + (method === 'GET' && select ? '?select=' + select : '');
    const res = await this._httpsReq(path, method, h, body ? JSON.stringify(body) : null);
    if (res.status >= 400) console.log('  _rest[' + table + '] ' + res.status + ': ' + res.body);
    return res;
  }

  async _getById(table, id, select) {
    const headers = await this._getAuthHeaders();
    if (!headers) return null;
    const path = '/rest/v1/' + table + '?id=eq.' + id + (select ? '&select=' + select : '');
    const res = await this._httpsReq(path, 'GET', headers);
    if (res.status === 200 && res.json && res.json.length) return res.json[0];
    return null;
  }

  _uid(prefix) {
    return prefix + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
  }

  _round2(n) { return Number((Math.round(n * 100) / 100).toFixed(2)); }

  async createOnboardingEntities(opts) {
    opts = opts || {};
    const SCHOOL = 'f14b95b1-72d7-4970-9784-df60ad9a02ee';
    const CLASSROOM = opts.classroomId || '97393759-cd03-42e5-b052-fc3d4d196a57';
    const SVC = 'cba19d20-d848-43c8-8437-c3b3d36a49e8'; // Matricula
    const svc = opts.service || { price: 45, tax_rate: 0.12, billing_frequency: 'monthly', name: 'Matricula' };
    const tax = this._round2(svc.price * svc.tax_rate);
    const total = this._round2(svc.price + tax);
    const today = new Date().toISOString().slice(0, 10);
    const nextMonth = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
    const summary = { steps: {}, total, tax, price: svc.price };


    const fam = await this._rest('families', 'POST', {
      school_id: SCHOOL, family_code: this._uid('FAM'),
      family_name: opts.familyName || 'E2E Family'
    }, 'id');
    summary.steps.family = fam.status;
    summary.familyId = fam.json && fam.json[0] && fam.json[0].id;

    const prof = await this._rest('profiles', 'POST', {
      first_name: opts.parentFirstName || (opts.firstName || 'Onboard'),
      last_name: opts.parentLastName || (opts.lastName || 'Parent'),
      email_secondary: this._uid('pp') + '@test.com', is_active: true
    }, 'id');
    summary.steps.profile = prof.status;
    summary.profileId = prof.json && prof.json[0] && prof.json[0].id;
    if (summary.profileId && summary.familyId) {
      const fm = await this._rest('family_members', 'POST', {
        family_id: summary.familyId, profile_id: summary.profileId,
        relationship: 'father', is_primary_contact: true, is_financial_responsible: true
      }, 'id');
      summary.steps.familyMember = fm.status;
      summary.familyMemberId = fm.json && fm.json[0] && fm.json[0].id;
    }


    const child = await this._rest('children', 'POST', {
      school_id: SCHOOL,
      first_name: opts.firstName || 'Onboard',
      last_name: opts.lastName || 'Child',
      birth_date: opts.birthDate || '2023-01-01',
      gender: opts.gender || 'Male', status: 'active'
    }, 'id');
    summary.steps.child = child.status;
    summary.childId = child.json && child.json[0] && child.json[0].id;


    if (summary.childId && summary.familyId) {
      const cf = await this._rest('child_families', 'POST', {
        child_id: summary.childId, family_id: summary.familyId,
        family_type: 'primary', is_active: true
      });
      summary.steps.childFamily = cf.status;


      const cfr = await this._rest('child_financial_responsibles', 'POST', {
        child_id: summary.childId, family_member_id: summary.familyMemberId,
        responsibility_percentage: 100, is_primary: true, is_active: true,
        start_date: today
      });
      summary.steps.childFinancialResponsible = cfr.status;
    }


    const enr = await this._rest('enrollments', 'POST', {
      child_id: summary.childId, school_id: SCHOOL,
      enrollment_code: this._uid('ENR'),
      academic_year: String(new Date().getFullYear()),
      enrollment_type: 'full_time', enrollment_date: today,
      start_date: today, status: 'active'
    }, 'id');
    summary.steps.enrollment = enr.status;
    summary.enrollmentId = enr.json && enr.json[0] && enr.json[0].id;


    if (summary.enrollmentId) {
      const ei = await this._rest('enrollment_items', 'POST', {
        enrollment_id: summary.enrollmentId, product_service_id: SVC,
        quantity: 1, unit_price: svc.price, discount_amount: 0,
        tax_amount: tax, total_amount: total, billing_frequency: svc.billing_frequency
      });
      summary.steps.enrollmentItem = ei.status;
    }

    const ce = await this._rest('classroom_enrollments', 'POST', {
      child_id: summary.childId, classroom_id: CLASSROOM,
      academic_year: String(new Date().getFullYear()),
      enrolled_at: today, status: 'active'
    }, 'id');
    summary.steps.classroomEnrollment = ce.status;
    summary.classroomEnrollmentId = ce.json && ce.json[0] && ce.json[0].id;


    const inv = await this._rest('invoices', 'POST', {
      school_id: SCHOOL, family_id: summary.familyId,
      child_id: summary.childId,
      responsible_family_member_id: summary.familyMemberId,
      enrollment_id: summary.enrollmentId,
      invoice_number: this._uid('INV-E2E'),
      subtotal: svc.price, tax_amount: tax, discount_amount: 0,
      total_amount: total, amount_paid: 0, balance_due: total,
      currency: 'USD', issue_date: today, due_date: nextMonth,
      status: 'pending'
    }, 'id');
    summary.steps.invoice = inv.status;
    summary.invoiceId = inv.json && inv.json[0] && inv.json[0].id;

    if (summary.invoiceId) {
      const ii = await this._rest('invoice_items', 'POST', {
        invoice_id: summary.invoiceId, product_service_id: SVC,
        description: svc.name, quantity: 1, unit_price: svc.price,
        discount_amount: 0, tax_amount: tax, line_total: total
      });
      summary.steps.invoiceItem = ii.status;
    }



    return summary;
  }


  async payInvoice(invoiceId, opts) {
    opts = opts || {};
    const SCHOOL = 'f14b95b1-72d7-4970-9784-df60ad9a02ee';
    const svc = opts.service || { price: 45, tax_rate: 0.12, billing_frequency: 'monthly', name: 'Matricula' };
    const tax = this._round2(svc.price * svc.tax_rate);
    const total = this._round2(svc.price + tax);
    const today = new Date().toISOString().slice(0, 10);
    const res = {};
    const inv = await this._getById('invoices', invoiceId, 'id,family_id,child_id,responsible_family_member_id,total_amount');
    const familyId = inv && inv.family_id;
    const childId = inv && inv.child_id;
    const paidBy = inv && inv.responsible_family_member_id;

    const pay = await this._rest('payments', 'POST', {
      school_id: SCHOOL, invoice_id: invoiceId,
      family_id: familyId, child_id: childId,
      paid_by_family_member_id: paidBy,
      payment_number: this._uid('PAY-E2E'),
      amount: total, currency: 'USD', payment_method: 'online',
      payment_date: today, status: 'completed'
    }, 'id');
    res.payment = pay.status;
    const paymentId = pay.json && pay.json[0] && pay.json[0].id;

    const upd = await this._httpsReq(
      '/rest/v1/invoices?id=eq.' + invoiceId, 'PATCH',
      Object.assign({}, await this._getAuthHeaders(), { 'Content-Type': 'application/json' }),
      JSON.stringify({ amount_paid: total, balance_due: 0, status: 'paid', paid_date: today })
    );
    res.invoiceUpdate = upd.status;

    try {
      const prov = await this._rest('payment_providers', 'GET', null, 'id');
      const provId = prov.json && prov.json[0] && prov.json[0].id;
      if (provId && paymentId) {
        const tx = await this._rest('payment_transactions', 'POST', {
          payment_id: paymentId, invoice_id: invoiceId,
          school_id: SCHOOL, payment_provider_id: provId,
          transaction_type: 'charge', amount: total, currency: 'USD',
          status: 'succeeded', provider_transaction_id: this._uid('MOCK'),
          idempotency_key: this._uid('IDEM')
        });
        res.paymentTransaction = tx.status;
      }
    } catch { }

    return res;
  }


  async verifyInvoicePaid(invoiceId) {
    const inv = await this._getById('invoices', invoiceId, 'id,status,amount_paid,balance_due');
    return inv && inv.status === 'paid' && this._round2(inv.amount_paid) > 0;
  }
}

module.exports = { OnboardingPage };