// e2e/utils/login.ts
import { Page, BrowserContext, expect } from '@playwright/test';

/**
 * Realiza login por UI (navegación y llenado de formulario).
 * Útil cuando necesitas simular la interacción real del usuario.
 */
export async function loginViaUI(page: Page, user?: string, password?: string) {
  user ??= process.env.USER!;
  password ??= process.env.PASSWORD!;

  await page.goto('/login');
  await page.getByRole('textbox', { name: 'Email address' }).fill(user);
  await page.getByRole('textbox', { name: 'Password' }).fill(password);
  // const authResponse = page.waitForResponse(
  //   (response) => {
  //     const url = new URL(response.url());
  //     return url.pathname === '/auth/v1/token' && response.status() === 200;
  //   }
  // );

  await page.getByRole('button', { name: 'Sign in' }).click();

  // // Espera a que la redirección al dashboard ocurra
  await page.waitForURL('/admin');

  // // Opcional: esperar a que algún elemento del dashboard sea visible
  // await page.getByRole('heading', { name: 'Dashboard' }).waitFor({ timeout: 10000 });
}

/**
 * Realiza login por API y establece las cookies en el contexto.
 * Más rápido que UI, pero no prueba la interfaz de login.
 */
export async function loginViaAPI(context: BrowserContext) {
  const email = process.env.USER!;
  const password = process.env.PASSWORD!;
  const apiBaseURL = process.env.API_BASE_URL || 'https://api.presupbase.juvomos.com';
  const baseURL = process.env.BASE_URL!;

  const response = await context.request.post(`${apiBaseURL}/auth/v1/token?grant_type=password`, {
    data: {
      email,
      password,
      gotrue_meta_security: {},
    },
  });

  if (!response.ok()) {
    throw new Error(`Login API failed: ${response.status()} ${await response.text()}`);
  }

  const data = await response.json();
  const accessToken = data.access_token;

  // Establecer la cookie que la app espera
  await context.addCookies([
    {
      name: 'sb-api-auth-token',
      value: accessToken,
      domain: new URL(baseURL).hostname,
      path: '/',
      httpOnly: false,
      secure: false,
      sameSite: 'Lax' as const,
    },
  ]);

  // Si la app usa localStorage, también lo podemos inyectar
  await context.addInitScript(() => {
    localStorage.setItem('lbc_remember_me', 'true');
  });

  // Guardar el estado en memoria (no en archivo) para este contexto
  // No es necesario guardar en disco, ya que el contexto tiene las cookies.
}