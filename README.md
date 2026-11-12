# LBC Tests

Suite de pruebas End-to-End para la plataforma **Little Buddy Care (LBC)**, escrita con [Playwright](https://playwright.dev/).

## Requisitos

- Node.js 18+
- npm

## Instalación

```bash
npm install
npx playwright install
```

## Configuración

Copiá `.env.example` a `.env` y completá los valores:

```bash
cp .env.example .env
```

El `.env` define el usuario con el que la suite inicia sesión, el entorno (`BASE_URL`, `API_BASE_URL`, `API_KEY`) y, opcionalmente, las credenciales de la matriz de roles. El colegio, el campus y el aula de trabajo se resuelven automáticamente a partir de la sesión de ese usuario — no hace falta fijar ningún identificador a mano salvo que el usuario tenga acceso a más de un colegio.

`.env` está excluido del control de versiones; nunca debe commitearse.

## Ejecución

```bash
# Toda la suite
npx playwright test

# Un archivo puntual
npx playwright test e2e/tests/billing/CP-746-01-to-20-billing.spec.js

# Filtrando por tag
npx playwright test --grep @billing
```

Playwright genera un reporte HTML en `playwright-report/` y un resumen en `test-results.json`.

## Organización del proyecto

```
e2e/
  pages/      Page Objects: uno por módulo de la aplicación
  tests/      Specs, agrupados por dominio funcional
  utils/      Autenticación, cliente de API y helpers compartidos
```

### Specs (`e2e/tests/`)

Los archivos de test se agrupan en una carpeta por dominio funcional, no por tipo de prueba:

| Carpeta | Módulo |
|---|---|
| `billing/` | Facturación: facturas, pagos, cargos |
| `onboarding/` | Alta de niños |
| `classrooms/` | Configuración de aulas |
| `families/` | Familias |
| `permissions/` | Control de acceso por rol |

Dentro de cada carpeta, un archivo puede agrupar varios casos relacionados (por ejemplo, todo el flujo de un módulo en un único `describe`). Cada caso se identifica con un código `CP-<módulo>-<número>` en el título del test, que es lo que aparece en los reportes y permite rastrear el caso hasta su origen (historia de usuario o ticket).

Todo spec sigue el mismo patrón de arranque: un `beforeAll` abre un contexto y una página compartida, inicia sesión una sola vez con `loginViaUI`, e instancia el o los Page Objects que va a usar. Los tests dentro del mismo `describe` reutilizan esa sesión en vez de loguearse cada uno por su cuenta.

### Page Objects (`e2e/pages/`)

Cada Page Object encapsula la interacción con un módulo de la aplicación: navegación, localización de elementos y — cuando aplica — llamadas directas a la API para preparar datos o verificar resultados sin depender de la UI. Son clases simples (`constructor(page)`), sin estado propio más allá de la página de Playwright que reciben.

| Archivo | Cubre |
|---|---|
| `BillingPage.js` | Facturas, pagos y cargos |
| `OnboardingPage.js` | Wizard de alta de niños |
| `ClassroomPage.js` | Aulas |
| `SettingsPage.js` | Configuración de la escuela |

### Utilidades (`e2e/utils/`)

| Archivo | Responsabilidad |
|---|---|
| `auth.ts` | Login por UI y por API. Es el único lugar que conoce el formulario de login y el endpoint de autenticación. |
| `api.ts` | Cliente REST autenticado contra la API (PostgREST/Supabase): agrega los headers de autorización y expone `apiGet`/`apiPost`/`apiPatch`/`apiDelete`. |
| `school.ts` | Resuelve el colegio, campus y aula de trabajo a partir de la sesión del usuario autenticado (ver más abajo). |
| `helpers.ts` | Helpers de UI de uso transversal: localizar un modal, un toast, un campo de formulario por su label, esperar una respuesta de red puntual. |

### Resolución automática de colegio

Ningún test tiene el identificador de un colegio, campus o aula escrito a mano. `school.ts` los resuelve consultando la API con la sesión del usuario definido en `.env`: como las políticas de acceso ya acotan las respuestas a los datos de ese usuario, alcanza con pedir "el colegio del usuario actual" para obtener el correcto. El resultado se cachea durante toda la corrida.

Esto significa que para correr la suite contra otro colegio no hay que tocar ningún archivo de test: basta con cambiar `USER`/`PASSWORD` en `.env`. Si una cuenta tiene acceso a más de un colegio, se puede fijar explícitamente con `SCHOOL_ID` (y opcionalmente `CAMPUS_ID`) en el mismo archivo.

### Datos de prueba

Los tests que necesitan una factura, un cargo o un pago para trabajar los crean por API antes de interactuar con la UI, y los eliminan por API al finalizar — no dependen de datos preexistentes en el ambiente ni los dejan como residuo.

## Pruebas de onboarding (LBC-1702)

Carpeta `e2e/tests/onboarding/`. Comprueban que se genera la factura de onboarding, pero no su pago: los pagos pertenecen al módulo de billing.

| Archivo | Qué cubre |
|---|---|
| `CP-ONB-wizard.spec.js` | Registro completo por el wizard (foto, familiar nuevo, medicación, aula, matrícula), tipo de enrolamiento asociado, medicación guardada, selector de fechas, formatos y tope de la foto, ACH disponible en el paso 2, aulas cerradas sin personal y secciones del detalle del niño. |
| `CP-ONB-api-seguridad.spec.js` | Llamadas directas a la API, sin formulario: sin sesión, token inválido, datos que el formulario valida, escuela ajena y permisos por rol. Etiqueta `@seguridad`. |

**Ejecutar en local**

```bash
npx playwright test e2e/tests/onboarding                          # todo
npx playwright test e2e/tests/onboarding --grep-invert @seguridad # sin las de seguridad
```

**Datos de prueba y limpieza.** Los niños llevan el apellido `QA-Lbc-…` y las aulas `QA-1702-…`. Cada prueba retira lo que crea (el niño, su matrícula en el aula y la asignación de personal) y al empezar hay un barrido de restos de corridas interrumpidas. Las matrículas activas ocupan cupo y activan el ratio, por eso siempre se retiran.

**GitHub Actions.** El workflow `E2E onboarding (preprod)` es manual (*Run workflow*). Necesita tres secretos del repositorio (no variables): `LBC_USER`, `LBC_PASSWORD` y `LBC_API_KEY`. Tiene dos entradas opcionales: `grep` (filtra pruebas) y `grep_invert` (por defecto excluye `@seguridad`). Algunas pruebas solo se ejecutan en CI (`test.fixme(!process.env.CI)`) porque dependen de una conexión estable. El workflow no sube artefactos.

