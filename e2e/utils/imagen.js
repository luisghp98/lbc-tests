const zlib = require('zlib');
const crypto = require('crypto');

/** PNG válido de ~bytes (ruido sin comprimir) para probar topes de tamaño. */
function png(bytes) {
  const w = 1000;
  const fila = w * 3 + 1;
  const h = Math.max(1, Math.round(bytes / fila));
  const raw = crypto.randomBytes(fila * h);
  for (let y = 0; y < h; y++) raw[y * fila] = 0;
  const chunk = (tipo, datos) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(datos.length);
    const cuerpo = Buffer.concat([Buffer.from(tipo), datos]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(cuerpo) >>> 0);
    return Buffer.concat([len, cuerpo, crc]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const firma = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([firma, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 0 })), chunk('IEND', Buffer.alloc(0))]);
}

/** Imagen real (jpeg o webp) codificada por el propio navegador con un canvas de ruido. */
async function desdeNavegador(page, mimeType, ancho = 400, alto = 400) {
  const base64 = await page.evaluate(({ mimeType, ancho, alto }) => new Promise((resolve) => {
    const c = document.createElement('canvas');
    c.width = ancho; c.height = alto;
    const ctx = c.getContext('2d');
    for (let i = 0; i < 400; i++) {
      ctx.fillStyle = `hsl(${Math.random() * 360} 70% 50%)`;
      ctx.fillRect(Math.random() * ancho, Math.random() * alto, 60, 60);
    }
    c.toBlob((b) => { const r = new FileReader(); r.onload = () => resolve(String(r.result).split(',')[1]); r.readAsDataURL(b); }, mimeType, 0.9);
  }), { mimeType, ancho, alto });
  return Buffer.from(base64, 'base64');
}

const archivo = (name, mimeType, buffer) => ({ name, mimeType, buffer });

module.exports = { png, desdeNavegador, archivo };
