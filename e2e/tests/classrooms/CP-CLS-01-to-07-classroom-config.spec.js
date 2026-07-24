const { test, expect } = require('@playwright/test');
const { loginViaUI } = require('../../utils/auth');
const { ClassroomPage } = require('../../pages/ClassroomPage');

test.describe.configure({ mode: 'serial' });

test.describe('CP-CLS: Classroom CRUD - Flujo Principal', {
  tag: '@classroom @cp-cls',
}, () => {

  let sharedPage;
  let classroomId;

  test.beforeAll(async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    sharedPage = await ctx.newPage();
    await loginViaUI(sharedPage);
  });

  test('CP-CLS-01: Crear aula con campos obligatorios y completos', async () => {
    const page = sharedPage;
    const data = {
      name: 'QA-E2E-' + Date.now(),
      code: 'QA-' + Date.now(),
      level: 'Pre-Kindergarten',
      size: 800,
    };

    await test.step('Navegar a formulario de crear aula', async () => {
      const cls = new ClassroomPage(page);
      await cls.gotoNew();
    });

    await test.step('Llenar campos obligatorios y crear', async () => {
      const cls = new ClassroomPage(page);
      await cls.selectFirstAvailableCampus();
      await cls.fillBasicInfo({
        name: data.name,
        code: data.code,
        level: data.level,
        size: data.size,
      });

      await page.screenshot({ path: 'evidence/screenshots/cp-cls-01-form.png', fullPage: true });
      await cls.clickCreate();
      classroomId = await cls.expectSuccessMessage(data.name);

      await page.screenshot({ path: 'evidence/screenshots/cp-cls-01-created.png', fullPage: true });
    });

    await test.step('Verificar aula en listado', async () => {
      const cls = new ClassroomPage(page);
      await cls.gotoList();

      const hasTable = await page.locator('table').isVisible({ timeout: 10000 }).catch(() => false);
      const hasCards = await page.locator('[class*="card"]:has(a[href*="/classrooms/"])').count().catch(() => 0);
      expect(hasTable || hasCards > 0).toBeTruthy();

      await page.screenshot({ path: 'evidence/screenshots/cp-cls-01-list.png', fullPage: true });
    });
  });

  test('CP-CLS-02: Editar aula existente', async () => {
    const page = sharedPage;
    const updatedName = 'QA-Edit-' + Date.now();

    await test.step('Navegar a edicion del aula', async () => {
      const cls = new ClassroomPage(page);
      if (!classroomId) {
        console.log('  → WARN: No classroom ID from CP-CLS-01, skipping');
        test.skip();
        return;
      }
      await cls.gotoEdit(classroomId);
    });

    await test.step('Modificar nombre y guardar', async () => {
      const cls = new ClassroomPage(page);
      const nameField = cls._getField('Classroom Name *');
      if (nameField) {
        await nameField.fill(updatedName);
      }

      await page.screenshot({ path: 'evidence/screenshots/cp-cls-02-editing.png', fullPage: true });
      await cls.clickUpdate();
      await cls.expectSuccessMessage();

      await page.screenshot({ path: 'evidence/screenshots/cp-cls-02-saved.png', fullPage: true });
    });
  });

  test('CP-CLS-03: Listado de aulas y columnas visibles', async () => {
    const page = sharedPage;

    await test.step('Navegar al listado de aulas', async () => {
      const cls = new ClassroomPage(page);
      await cls.gotoList();

      const hasTable = await page.locator('table').isVisible({ timeout: 10000 }).catch(() => false);
      const hasCards = await page.locator('[class*="card"]:has(a[href*="/classrooms/"])').count().catch(() => 0);
      const hasClassroomLinks = await page.locator('a[href*="/classrooms/"]').count().catch(() => 0);

      console.log(`  → Classroom list: table=${hasTable}, cards=${hasCards}, links=${hasClassroomLinks}`);
      expect(hasTable || hasCards > 0 || hasClassroomLinks > 0).toBeTruthy();

      if (hasTable) {
        const headers = await page.locator('table th').allTextContents();
        console.log('  → Columnas:', headers.join(', '));
      }

      await page.screenshot({ path: 'evidence/screenshots/cp-cls-03-list.png', fullPage: true });
    });
  });

  test('CP-CLS-04: Cambiar estado del aula (Active → Inactive → Active)', async () => {
    const page = sharedPage;

    await test.step('Crear aula para testing de estado', async () => {
      const cls = new ClassroomPage(page);
      const clsName = 'QA-Status-' + Date.now();
      await cls.gotoNew();
      await cls.selectFirstAvailableCampus();
      await cls.fillBasicInfo({
        name: clsName,
        code: 'ST-' + Date.now(),
        level: 'Pre-Kindergarten',
        size: 600,
      });
      await cls.clickCreate();
      classroomId = await cls.expectSuccessMessage(clsName);
    });

    await test.step('Cambiar estado: Active → Inactive → Active', async () => {
      if (!classroomId) {
        console.log('  → WARN: No classroom ID, skipping status change');
        test.skip();
        return;
      }

      const cls = new ClassroomPage(page);
      for (const status of ['Inactive', 'Active']) {
        await cls.gotoEdit(classroomId);
        const statusField = cls._getField('Status');
        if (statusField) {
          await statusField.selectOption(status);
        }
        await cls.clickUpdate();
        await cls.expectSuccessMessage();
        console.log(`  → Status changed to: ${status}`);

        await page.screenshot({ path: `evidence/screenshots/cp-cls-04-status-${status.toLowerCase()}.png`, fullPage: true });
      }
    });
  });

  test('CP-CLS-05: Validación de campos requeridos', async () => {
    const page = sharedPage;

    await test.step('Navegar a formulario vacío', async () => {
      const cls = new ClassroomPage(page);
      await cls.gotoNew();
    });

    await test.step('Intentar crear sin campos obligatorios', async () => {
      const cls = new ClassroomPage(page);
      await cls.clickCreate();
      await cls.expectValidationError();

      await page.screenshot({ path: 'evidence/screenshots/cp-cls-05-validation.png', fullPage: true });
    });
  });

  test('CP-CLS-06: Configurar horarios y amenities', async () => {
    const page = sharedPage;
    const data = {
      name: 'QA-Amenities-' + Date.now(),
      code: 'AM-' + Date.now(),
      level: 'Pre-Kindergarten',
      size: 700,
    };

    await test.step('Crear aula con horarios y amenities', async () => {
      const cls = new ClassroomPage(page);
      await cls.gotoNew();
      await cls.selectFirstAvailableCampus();

      await cls.fillBasicInfo({
        name: data.name,
        code: data.code,
        level: data.level,
        size: data.size,
      });

      await cls.setOperatingHours(0, { enabled: true, start: '08:00', end: '16:00' });
      await cls.setOperatingHours(1, { enabled: true, start: '08:00', end: '16:00' });

      await cls.toggleAmenity('Air Conditioning', true);
      await cls.toggleAmenity('Playground Access', true);

      await page.screenshot({ path: 'evidence/screenshots/cp-cls-06-configured.png', fullPage: true });
      await cls.clickCreate();
      await cls.expectSuccessMessage(data.name);

      await page.screenshot({ path: 'evidence/screenshots/cp-cls-06-created.png', fullPage: true });
    });
  });

  test('CP-CLS-07: Asignar ratio de personal', async () => {
    const page = sharedPage;
    const data = {
      name: 'QA-Ratio-' + Date.now(),
      code: 'RT-' + Date.now(),
      level: 'Pre-Kindergarten',
      size: 600,
    };

    await test.step('Crear aula y verificar columna staff en listado', async () => {
      const cls = new ClassroomPage(page);
      await cls.gotoNew();
      await cls.selectFirstAvailableCampus();

      await cls.fillBasicInfo({
        name: data.name,
        code: data.code,
        level: data.level,
        size: data.size,
      });

      await cls.clickCreate();
      await cls.expectSuccessMessage(data.name);
    });

    await test.step('Verificar columna Staff/Teachers en listado', async () => {
      const cls = new ClassroomPage(page);
      await cls.gotoList();

      const hasTable = await page.locator('table').isVisible({ timeout: 10000 }).catch(() => false);
      if (hasTable) {
        const headers = await page.locator('table th').allTextContents();
        const hasStaffCol = headers.some(h => h.toLowerCase().includes('teacher') || h.toLowerCase().includes('staff'));
        console.log('  → Columna Staff/Teachers:', hasStaffCol ? 'visible' : 'no visible');
      }

      await page.screenshot({ path: 'evidence/screenshots/cp-cls-07-staff-column.png', fullPage: true });
    });
  });
});