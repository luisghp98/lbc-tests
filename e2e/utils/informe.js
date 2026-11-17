// Deja en el log los datos que luego usa el informe final: el resultado real de cada caso y la ficha del niño registrado.
// Solo datos de prueba (QA-): el log de GitHub Actions es público.
const informar = (cp, texto) => console.log(`[RESULTADO] ${cp} | ${texto}`);
const ficha = (datos) => console.log(`[FICHA] ${JSON.stringify(datos)}`);

module.exports = { informar, ficha };
