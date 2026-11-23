const { test } = require('@playwright/test');
const { loginViaUI } = require('../../utils/auth');
const { asUser, rest } = require('../../utils/rest');

// Temporal (se borra al terminar): restaura el lunes del tipo "Solo Mañana" por la interfaz web y muestra qué hace el formulario.
test.describe('RESTAURAR: horario de Solo Mañana', () => {
  test.skip(!process.env.CI, 'Solo se ejecuta en CI');
  test('RESTAURAR: marcar el lunes de Solo Mañana', async ({ page }) => {
    test.setTimeout(420_000);
    const headers = await asUser();
    const tipo = (await rest('enrollment_types', { headers, query: 'name=eq.Solo Mañana&select=id' })).json[0].id;
    const estado = async () => JSON.stringify(((await rest('enrollment_type_schedules', { headers, query: `enrollment_type_id=eq.${tipo}&deleted_at=is.null&select=day_of_week,is_attending,start_time,end_time&order=day_of_week` })).json || [])
      .map((f) => `${f.day_of_week}:${f.is_attending ? 1 : 0}:${String(f.start_time).slice(0, 5)}-${String(f.end_time).slice(0, 5)}`));
    console.log('[RESTAURAR] antes: ' + await estado());
    await loginViaUI(page);
    const posts = [];
    page.on('response', (r) => { if (r.request().method() === 'POST' && r.url().includes('/admin/enrollment-types')) posts.push(`${r.status()} ${new URL(r.url()).pathname.replace(/[0-9a-f-]{36}/, '<id>')}`); });
    await page.goto(`/admin/enrollment-types/${tipo}/edit`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: /save changes/i }).waitFor({ timeout: 180_000 });
    await page.waitForTimeout(2500);
    const dias = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
    const horas = async () => JSON.stringify(await page.locator('input[type=time]').evaluateAll((xs) => xs.map((x) => x.value)));
    console.log('[RESTAURAR] casillas: ' + JSON.stringify(await Promise.all(dias.map(async (d) => d + ':' + (await page.getByRole('checkbox', { name: d }).isChecked())))));
    console.log('[RESTAURAR] horas en el formulario: ' + await horas());
    const lunes = page.getByRole('checkbox', { name: 'Monday' });
    if (!(await lunes.isChecked())) await lunes.check();
    await page.waitForTimeout(1500);
    console.log('[RESTAURAR] horas tras marcar el lunes: ' + await horas());
    const fila = lunes.locator('xpath=ancestor::*[.//input[@type="time"]][1]');
    const horasLunes = fila.locator('input[type=time]');
    console.log('[RESTAURAR] campos de hora del lunes: ' + await horasLunes.count());
    if ((await horasLunes.count()) >= 2) { await horasLunes.nth(0).fill('08:00'); await horasLunes.nth(1).fill('12:00'); }
    console.log('[RESTAURAR] horas antes de guardar: ' + await horas());
    await page.getByRole('button', { name: /save changes/i }).click();
    await page.waitForTimeout(20_000);
    console.log('[RESTAURAR] POST recibidos: ' + JSON.stringify(posts));
    console.log('[RESTAURAR] mensajes visibles: ' + JSON.stringify((await page.locator('[role=alert], [role=status], [data-sonner-toast], .text-red-500, .text-destructive, [aria-live]').allInnerTexts()).map((t) => t.replace(/\s+/g, ' ').slice(0, 160)).filter(Boolean)));
    console.log('[RESTAURAR] url: ' + new URL(page.url()).pathname.replace(/[0-9a-f-]{36}/, '<id>'));
    console.log('[RESTAURAR] después: ' + await estado());
  });
});
