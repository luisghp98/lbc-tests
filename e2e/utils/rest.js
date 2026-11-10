const https = require('https');

const API_HOST = () => process.env.API_BASE_URL || 'https://api.presupbase.juvomos.com';
const tokens = new Map();

function requestOnce(pathname, { method = 'GET', headers = {}, body, timeoutMs = 120_000 } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    const req = https.request(API_HOST() + pathname, {
      method,
      headers: { ...headers, ...(data ? { 'Content-Length': data.length } : {}) },
    }, (res) => {
      let text = '';
      res.on('data', (c) => (text += c));
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(text); } catch { /* respuesta sin JSON */ }
        resolve({ status: res.statusCode, json, text });
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`timeout ${method} ${pathname}`)));
    if (data) req.write(data);
    req.end();
  });
}

// Conexión lenta: las lecturas (GET) y lo marcado `reintentar` (p. ej. el login) se reintentan; las escrituras no, para no duplicar datos.
async function request(pathname, opts = {}) {
  const intentos = (opts.method || 'GET') === 'GET' || opts.reintentar ? 3 : 1;
  for (let i = 1; ; i++) {
    try {
      return await requestOnce(pathname, opts);
    } catch (e) {
      if (i >= intentos) throw e;
    }
  }
}

/** Cabeceras de un usuario autenticado (token en caché hasta que caduque). */
async function asUser(email = process.env.USER, password = process.env.PASSWORD) {
  const apikey = process.env.API_KEY;
  if (!apikey || !email || !password) throw new Error('Faltan API_KEY, USER o PASSWORD en el .env');
  const cached = tokens.get(email);
  if (!cached || cached.expiresAt < Date.now() + 60_000) {
    const res = await request('/auth/v1/token?grant_type=password', {
      method: 'POST', reintentar: true,
      headers: { apikey, 'Content-Type': 'application/json' },
      body: { email, password },
    });
    if (res.status !== 200) throw new Error(`login API ${email}: ${res.status}`);
    tokens.set(email, { token: res.json.access_token, expiresAt: Date.now() + (res.json.expires_in || 3600) * 1000 });
  }
  return {
    apikey,
    Authorization: `Bearer ${tokens.get(email).token}`,
    'Content-Type': 'application/json',
    Prefer: 'return=representation',
  };
}

/** Cabeceras sin sesión: solo la apikey pública, como un cliente anónimo. */
function anon() {
  return { apikey: process.env.API_KEY, 'Content-Type': 'application/json' };
}

const rest = (table, { method = 'GET', headers, query = '', body } = {}) =>
  request(`/rest/v1/${table}${query ? `?${query}` : ''}`, { method, headers, body });

module.exports = { request, asUser, anon, rest };
