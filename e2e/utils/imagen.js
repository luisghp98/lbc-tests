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

const archivo = (name, mimeType, buffer) => ({ name, mimeType, buffer });

module.exports = { png, archivo };
