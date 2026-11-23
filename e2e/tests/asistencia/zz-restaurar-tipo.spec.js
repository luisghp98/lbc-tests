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
    const llamadas = [];
    const corto = (u) => { try { const x = new URL(u); return x.hostname.split('.')[0] + x.pathname.replace(/[0-9a-f-]{36}/g, '<id>').slice(0, 90); } catch { return u.slice(0, 60); } };
    page.on('response', (r) => { if (r.request().method() !== 'GET' && r.request().method() !== 'OPTIONS') llamadas.push(`${r.request().method()} ${corto(r.url())} -> ${r.status()}`); });
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
    const guardar = page.getByRole('button', { name: /save changes/i });
    console.log('[RESTAURAR] botón guardar deshabilitado: ' + (await guardar.isDisabled()));
    console.log('[RESTAURAR] campos inválidos: ' + JSON.stringify(await page.locator(':invalid').evaluateAll((xs) => xs.map((x) => (x.name || x.id || x.type || x.tagName) + ':' + (x.validationMessage || '').slice(0, 60)))));
    llamadas.length = 0;
    await guardar.click();
    await page.waitForTimeout(20_000);
    console.log('[RESTAURAR] llamadas que no son GET tras guardar: ' + JSON.stringify(llamadas));
    console.log('[RESTAURAR] campos inválidos tras guardar: ' + JSON.stringify(await page.locator(':invalid').evaluateAll((xs) => xs.map((x) => (x.name || x.id || x.type || x.tagName) + ':' + (x.validationMessage || '').slice(0, 60)))));
    const texto = (await page.locator('main').innerText().catch(() => '')).replace(/\s+/g, ' ');
    const i = texto.indexOf('ATTENDANCE DAYS');
    console.log('[RESTAURAR] sección de horario tras guardar: ' + texto.slice(i, i + 700));
    console.log('[RESTAURAR] campos aria-invalid: ' + JSON.stringify(await page.locator('[aria-invalid=true]').evaluateAll((xs) => xs.map((x) => (x.name || x.id || x.type || x.tagName)))));
    console.log('[RESTAURAR] mensajes de error visibles: ' + JSON.stringify((await page.getByText(/required|invalid|must|please|error|select a|obligatorio/i).allInnerTexts()).map((t) => t.replace(/\s+/g, ' ').slice(0, 120)).slice(0, 10)));
    console.log('[RESTAURAR] HTML de la fila del lunes: ' + (await fila.evaluate((el) => el.outerHTML.replace(/\s+/g, ' ').slice(0, 900)).catch(() => 'sin fila')));
    console.log('[RESTAURAR] url: ' + new URL(page.url()).pathname.replace(/[0-9a-f-]{36}/, '<id>'));
    console.log('[RESTAURAR] después: ' + await estado());
  });
});
