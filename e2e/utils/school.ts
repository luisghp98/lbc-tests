// e2e/utils/school.ts
import { Page } from '@playwright/test';
import { apiGet } from './api';

/**
 * Resolución del contexto de la escuela a partir de la SESIÓN del usuario.
 *
 * La idea: NO hay UUIDs de escuela/campus/aula quemados en los tests. Todo se
 * deriva del usuario que definas en `.env` (USER / PASSWORD). La API aplica RLS,
 * así que una consulta sin filtro sólo devuelve filas del colegio al que ese
 * usuario tiene acceso — eso es lo que aprovechamos aquí.
 *
 * Para apuntar la suite a otro colegio basta con cambiar USER y PASSWORD.
 *
 * Escotilla de escape (normalmente NO la necesitas, y por defecto va vacía):
 * si el usuario tiene acceso a varios colegios, define SCHOOL_ID en el `.env`
 * para fijar cuál usar.
 */

let cachedSchoolId: string | null = null;
let cachedCampusId: string | null = null;
let cachedClassroomId: string | null = null;

/** GET que nunca lanza: devuelve el array de filas o null si la tabla/consulta falla. */
async function tryRows(page: Page, endpoint: string): Promise<any[] | null> {
  try {
    const res = await apiGet(page, endpoint);
    if (!res.ok()) return null;
    const json = await res.json();
    return Array.isArray(json) ? json : null;
  } catch {
    return null;
  }
}

/**
 * Devuelve el school_id del usuario autenticado. Se resuelve una sola vez por
 * corrida y se cachea.
 */
export async function resolveSchoolId(page: Page): Promise<string> {
  if (cachedSchoolId) return cachedSchoolId;

  // 1. Override explícito del .env (sólo para usuarios multi-colegio).
  const override = process.env.SCHOOL_ID;
  if (override) {
    cachedSchoolId = override;
    console.log(`  [school] school_id fijado por .env (SCHOOL_ID): ${override}`);
    return cachedSchoolId;
  }

  // 2. La vía limpia: /schools acotado por RLS. Pedimos 2 para detectar ambigüedad.
  const schools = await tryRows(page, '/rest/v1/schools?select=id,name&limit=2');
  if (schools && schools.length === 1) {
    cachedSchoolId = schools[0].id;
    console.log(`  [school] resuelto desde /schools: ${schools[0].name} (${cachedSchoolId})`);
    return cachedSchoolId!;
  }
  if (schools && schools.length > 1) {
    const listado = schools.map(s => `${s.name} (${s.id})`).join(', ');
    throw new Error(
      `El usuario "${process.env.USER}" tiene acceso a más de un colegio: ${listado}. ` +
      `Define SCHOOL_ID en el .env para elegir cuál usar, o usa un usuario de un solo colegio.`
    );
  }

  // 3. Respaldo: deducirlo de cualquier tabla del dominio que lleve school_id.
  //    También va acotada por RLS, así que el valor corresponde al colegio del usuario.
  for (const tabla of ['families', 'invoices', 'charges', 'children', 'enrollments']) {
    const filas = await tryRows(page, `/rest/v1/${tabla}?select=school_id&limit=1`);
    const id = filas && filas[0] && filas[0].school_id;
    if (id) {
      cachedSchoolId = id;
      console.log(`  [school] resuelto desde /${tabla}: ${cachedSchoolId}`);
      return cachedSchoolId!;
    }
  }

  throw new Error(
    `No se pudo resolver el school_id del usuario "${process.env.USER}". ` +
    `Verifica que las credenciales del .env sean válidas y que el usuario tenga ` +
    `un colegio asignado con datos, o define SCHOOL_ID en el .env.`
  );
}

/** Devuelve el campus_id del colegio del usuario (el primero disponible). */
export async function resolveCampusId(page: Page): Promise<string> {
  if (cachedCampusId) return cachedCampusId;

  const override = process.env.CAMPUS_ID;
  if (override) {
    cachedCampusId = override;
    return cachedCampusId;
  }

  const schoolId = await resolveSchoolId(page);

  const campus = await tryRows(page, `/rest/v1/campuses?school_id=eq.${schoolId}&select=id,name&limit=1`);
  if (campus && campus[0]) {
    cachedCampusId = campus[0].id;
    console.log(`  [school] campus resuelto desde /campuses: ${cachedCampusId}`);
    return cachedCampusId!;
  }

  // Respaldo: sacarlo de un aula del colegio.
  const aulas = await tryRows(page, '/rest/v1/classrooms?select=campus_id&limit=1');
  const id = aulas && aulas[0] && aulas[0].campus_id;
  if (id) {
    cachedCampusId = id;
    console.log(`  [school] campus resuelto desde /classrooms: ${cachedCampusId}`);
    return cachedCampusId!;
  }

  throw new Error(
    `No se pudo resolver el campus del colegio ${schoolId}. ` +
    `El colegio del usuario "${process.env.USER}" no tiene campus ni aulas.`
  );
}

/** Devuelve el id de la primera aula del colegio del usuario. */
export async function resolveFirstClassroomId(page: Page): Promise<string> {
  if (cachedClassroomId) return cachedClassroomId;

  const aulas = await tryRows(page, '/rest/v1/classrooms?select=id,classroom_name&limit=1');
  const id = aulas && aulas[0] && aulas[0].id;
  if (!id) {
    throw new Error(
      `El colegio del usuario "${process.env.USER}" no tiene aulas. ` +
      `Crea al menos un aula o usa otro usuario.`
    );
  }
  cachedClassroomId = id;
  return cachedClassroomId!;
}

/**
 * Devuelve el fragmento de filtro PostgREST del colegio, listo para concatenar.
 * Ej: `/rest/v1/invoices?${await schoolFilter(page)}&select=id`
 */
export async function schoolFilter(page: Page): Promise<string> {
  return `school_id=eq.${await resolveSchoolId(page)}`;
}

/** Limpia la caché. Útil si un test cambia de usuario a mitad de corrida. */
export function resetSchoolCache(): void {
  cachedSchoolId = null;
  cachedCampusId = null;
  cachedClassroomId = null;
}
