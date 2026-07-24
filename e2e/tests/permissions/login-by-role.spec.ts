// e2e/login.spec.ts
import { test, expect, BrowserContext, Page } from '@playwright/test';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { sanitizeTitle, takeScreenshot } from '../../utils/helpers';

// Cargar variables de entorno
dotenv.config({ path: path.resolve(__dirname, '../.env') });

// Contraseña común para la mayoría de los usuarios
const COMMON_PASSWORD = process.env.TEST_USER_PASSWORD ?? '';

if (!COMMON_PASSWORD) {
  throw new Error('❌ TEST_USER_PASSWORD no está definida en el entorno');
}

// Definición de usuarios: 
// - envKey: variable de entorno que contiene el email
// - role: descripción del rol (se muestra en el título)
// - shouldSucceed: true si debe acceder a /admin, false si debe ir a /unauthorized
// - passwordEnv: (opcional) variable de entorno con la contraseña específica; si no se define, se usa COMMON_PASSWORD
const userDefinitions = [
  // Roles con acceso permitido
  { envKey: 'TEST_USER_ACCOUNTANT', role: 'Accountant (Contador)', shouldSucceed: true },
  { envKey: 'TEST_USER_RECEPCIONIST', role: 'Recepcionist (Recepcionista)', shouldSucceed: true },
  { envKey: 'TEST_USER_SCHOOL_ADMIN', role: 'School Administrator (Administrador escuela)', shouldSucceed: true },
  { envKey: 'TEST_USER_PRINCIPAL', role: 'Principal', shouldSucceed: true },
  { envKey: 'TEST_USER_SUPER_ADMIN', role: 'SuperAdmin', shouldSucceed: true, passwordEnv: 'TEST_USER_SUPER_ADMIN_PASSWORD' },
  { envKey: 'TEST_USER_ORGANIZATION_ADMIN', role: 'Organization Administrator (Administrador Organización)', shouldSucceed: true, passwordEnv: 'TEST_USER_ORGANIZATION_ADMIN_PASSWORD' },

  // Roles sin acceso (deben redirigir a /unauthorized)
  { envKey: 'TEST_USER_ASSISTANT_TEACHER', role: 'Assistant Teacher', shouldSucceed: false },
  { envKey: 'TEST_USER_PARENT_GUARDIAN', role: 'Parent/Guardian', shouldSucceed: false },
  { envKey: 'TEST_USER_STAFF', role: 'Staff', shouldSucceed: false },
  { envKey: 'TEST_USER_TEACHER', role: 'Teacher', shouldSucceed: false },
  { envKey: 'TEST_USER_CUSTOM_ROLE', role: 'Custom Role', shouldSucceed: false },
  { envKey: 'TEST_USER_PARENT', role: 'Parent', shouldSucceed: false },
];

// Construir la lista de usuarios con email y password resueltos
const users = userDefinitions
  .map(def => {
    const email = process.env[def.envKey];
    if (!email) return null; // Si no está definido, se omite

    // Determinar la contraseña
    let password: string;
    if (def.passwordEnv) {
      const pwd = process.env[def.passwordEnv];
      if (!pwd) {
        throw new Error(`❌ La variable de entorno ${def.passwordEnv} no está definida para el usuario ${def.role}`);
      }
      password = pwd;
    } else {
      password = COMMON_PASSWORD;
    }

    return {
      email,
      password,
      role: def.role,
      shouldSucceed: def.shouldSucceed,
    };
  })
  .filter((u): u is { email: string; password: string; role: string; shouldSucceed: boolean } => u !== null);

if (users.length === 0) {
  throw new Error('❌ No se encontraron usuarios definidos en el entorno. Asegúrate de definir las variables TEST_USER_*');
}

test.describe('Login de usuarios por rol', () => {
  let context: BrowserContext;
  let page: Page;

  // Define la ruta de la carpeta de screenshots (ajústala según tu proyecto)
  const TEST_SCREENSHOTS_DIR = 'permissions/login_by_role';

  const SCREENSHOTS_DIR = path.join(__dirname, 'screenshots/' + TEST_SCREENSHOTS_DIR); // o './screenshots'

  test.beforeAll(async ({ browser }) => {
    // 🔥 Limpiar la carpeta de screenshots antes de todas las pruebas
    if (fs.existsSync(SCREENSHOTS_DIR)) {
      // Elimina la carpeta y todo su contenido recursivamente
      fs.rmSync(SCREENSHOTS_DIR, { recursive: true, force: true });
    }
    // Crear la carpeta nuevamente (vacía) para que las próximas capturas tengan un lugar donde guardarse
    fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
    context = await browser.newContext();
    page = await context.newPage();
  });

  test.beforeEach(async () => {
    await context.clearCookies();
    await page.goto('/login');
    await page.waitForLoadState('networkidle');
  });

  test.afterEach(async ({ }, testInfo) => {
    // Tomar screenshot solo si el test falló
    const safeTitle = sanitizeTitle(testInfo.title);
    if (testInfo.status !== 'passed') {
      // Sanitizar el título para usarlo como nombre de archivo
      await takeScreenshot(page, `${TEST_SCREENSHOTS_DIR}/failure_${safeTitle}`);
    } else
      await takeScreenshot(page, `${TEST_SCREENSHOTS_DIR}/ok_${safeTitle}`);
  });

  test.afterAll(async () => {
    await context.close();
  });

  async function loginAs(email: string, password: string) {
    await page.getByRole('textbox', { name: 'Email address' }).fill(email);
    await page.getByRole('textbox', { name: 'Password' }).fill(password);
    await page.getByRole('button', { name: 'Sign in' }).click();

    // Esperar a que la URL cambie a /admin, /unauthorized o /login (si hay error)
    await page.waitForURL(/\/admin|\/unauthorized|\/login/);

    // Verificar si hay un toast de error
    const errorToast = page.getByText(/Invalid login credentials|Error/i);
    if (await errorToast.isVisible()) {
      throw new Error(`❌ Credenciales inválidas para ${email}. Verifica que el usuario exista y la contraseña sea correcta.`);
    }
  }

  for (const user of users) {
    // Título claro: indica si se permite o deniega el acceso
    const accessText = user.shouldSucceed ? 'Acceso permitido' : 'Acceso denegado';
    test(`${accessText} - ${user.role} (${user.email})`, async () => {
      await loginAs(user.email, user.password);

      if (user.shouldSucceed) {
        // Debe redirigir a /admin
        await page.waitForURL('/admin');
        const dashboardHeading = page.getByRole('heading', { name: 'Little Buddy', exact: true }).first();
        await expect(dashboardHeading).toBeVisible();
      } else {
        // Debe redirigir a /unauthorized
        await page.waitForURL('/unauthorized');
        await expect(page.getByRole('heading', { name: 'Access Denied', exact: false })).toBeVisible();
      }
    });
  }
});