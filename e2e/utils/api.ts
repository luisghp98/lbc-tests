// e2e/utils/api.ts
import { Page, APIResponse } from '@playwright/test';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';

export interface ApiRequestOptions {
  method?: HttpMethod;
  endpoint: string;
  query?: Record<string, any>;
  payload?: Record<string, any> | string;
  headers?: Record<string, string>;
  timeout?: number;
}

// Variables de entorno (asegúrate de tenerlas en .env)
const BASE_API_URL = process.env.API_BASE_URL || 'https://api.presupbase.juvomos.com';
const API_KEY = process.env.API_KEY;
const SUPABASE_USER = process.env.USER;
const SUPABASE_PASSWORD = process.env.PASSWORD;

// Validaciones al inicio
if (!API_KEY) {
  throw new Error('❌ API_KEY no definida en el entorno (archivo .env)');
}
if (!SUPABASE_USER || !SUPABASE_PASSWORD) {
  throw new Error('❌ SUPABASE_USER y SUPABASE_PASSWORD deben definirse en el entorno');
}

// Almacén del token (se reutiliza en toda la ejecución)
let accessToken: string | null = null;

/**
 * Obtiene un nuevo token de acceso usando email/contraseña.
 * Endpoint: /auth/v1/token?grant_type=password
 * Envía JSON (Content-Type: application/json)
 */
async function fetchAccessToken(page: Page): Promise<string> {
  const loginUrl = `${BASE_API_URL}/auth/v1/token?grant_type=password`;
  const headers: any = {
    'apikey': API_KEY,
    'Content-Type': 'application/json',
  };
  const payload = {
    email: SUPABASE_USER,
    password: SUPABASE_PASSWORD,
    // grant_type también se incluye en el body por si acaso
    grant_type: 'password',
  };

  try {
    const response = await page.context().request.fetch(loginUrl, {
      method: 'POST',
      headers,
      data: JSON.stringify(payload),
    });

    if (!response.ok()) {
      const errorText = await response.text();
      throw new Error(`Login falló con status ${response.status()}: ${errorText}`);
    }

    const data = await response.json();
    const token = data.access_token;
    if (!token) {
      throw new Error('No se recibió access_token en la respuesta de login');
    }
    return token;
  } catch (error: any) {
    throw new Error(`❌ Error al obtener token de acceso: ${error.message}`);
  }
}

/**
 * Asegura que tengamos un token válido (lo obtiene si no existe).
 */
async function ensureAccessToken(page: Page): Promise<string> {
  if (accessToken) {
    // Podrías añadir lógica de expiración aquí si lo deseas
    return accessToken;
  }
  accessToken = await fetchAccessToken(page);
  return accessToken;
}

// Función principal para hacer peticiones con autenticación automática
export const apiRequest = async (
  page: Page,
  options: ApiRequestOptions
): Promise<APIResponse> => {
  const {
    method = 'GET',
    endpoint,
    query,
    payload,
    headers = {},
    timeout = 30000,
  } = options;

  let url = endpoint.startsWith('http') ? endpoint : `${BASE_API_URL}${endpoint}`;

  // Agregar query params si existen
  if (query && Object.keys(query).length > 0) {
    const searchParams = new URLSearchParams();

    for (const [key, value] of Object.entries(query)) {
      // Si el valor es un array o objeto, Supabase espera notación como 'column=in.(1,2,3)'
      // o bien se puede pasar como JSON string, pero lo más común es usar strings simples.
      if (Array.isArray(value)) {
        // Ejemplo: { filter: ['eq', 'value'] } -> filter=eq.value
        // Pero para simplificar, puedes unir con coma si es un array de valores
        searchParams.append(key, value.join(','));
      } else if (typeof value === 'object' && value !== null) {
        // Para objetos, se puede convertir a JSON o usar notación punto, según lo que espere Supabase
        searchParams.append(key, JSON.stringify(value));
      } else {
        searchParams.append(key, String(value));
      }
    }

    const queryString = searchParams.toString();
    url += (url.includes('?') ? '&' : '?') + queryString;
  }

  // Headers base
  const defaultHeaders: any = {
    'apikey': API_KEY,
    'Content-Type': 'application/json',
    'Content-Profile': 'public',
    'Prefer': 'return=representation',
  };

  // Verificar si el usuario ya pasó un header 'Authorization' explícito
  const hasAuthHeader = Object.keys(headers).some(
    (key) => key.toLowerCase() === 'authorization'
  );

  // Si no hay header Authorization, obtenemos el token y lo añadimos
  let finalHeaders = { ...defaultHeaders };
  if (!hasAuthHeader) {
    const token = await ensureAccessToken(page);
    finalHeaders['Authorization'] = `Bearer ${token}`;
  }

  // Sobrescribir con los headers proporcionados (pueden añadir o reemplazar)
  finalHeaders = { ...finalHeaders, ...headers };

  // Preparar body
  let body: string | undefined;
  if (payload) {
    body = typeof payload === 'string' ? payload : JSON.stringify(payload);
  }

  const requestOptions = {
    method,
    headers: finalHeaders,
    data: body,
    timeout,
  };

  try {
    const response = await page.context().request.fetch(url, requestOptions);
    return response;
  } catch (error: any) {
    throw new Error(`❌ apiRequest falló: ${method} ${url} - ${error.message}`);
  }
};

// Helpers (sin cambios)
export const apiGet = (page: Page, endpoint: string, query?: Record<string, any>, headers?: Record<string, string>) =>
  apiRequest(page, { method: 'GET', endpoint, query, headers });

export const apiPost = (page: Page, endpoint: string, payload: any, headers?: Record<string, string>) =>
  apiRequest(page, { method: 'POST', endpoint, payload, headers });

export const apiPut = (page: Page, endpoint: string, payload: any, headers?: Record<string, string>) =>
  apiRequest(page, { method: 'PUT', endpoint, payload, headers });

export const apiDelete = (page: Page, endpoint: string, headers?: Record<string, string>) =>
  apiRequest(page, { method: 'DELETE', endpoint, headers });

export const apiPatch = (page: Page, endpoint: string, payload: any, headers?: Record<string, string>) =>
  apiRequest(page, { method: 'PATCH', endpoint, payload, headers });

export const waitForResponse = (page: Page, endpoint: string, method: HttpMethod) => {
  const url = endpoint.startsWith('http') ? endpoint : `${BASE_API_URL}${endpoint}`;
  const responsePromise = page.waitForResponse(
    response =>
      response.url().includes(url) && response.request().method() === method
  );
  return responsePromise
}

