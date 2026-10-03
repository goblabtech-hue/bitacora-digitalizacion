/* Flujo completo contra el servidor real: recepción, validación, mesas,
   escaneo, PDF, traslados entre sedes, solicitudes, devolución y permisos
   por rol. Arranca su propio servidor con una base y carpetas temporales,
   corre flujo-completo.mjs y convierte cada comprobación en una prueba. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Un puerto libre que el sistema presta y se devuelve enseguida. */
const puertoLibre = () => new Promise((ok) => {
  const s = createServer().listen(0, () => { const { port } = s.address(); s.close(() => ok(port)); });
});

async function esperarServidor(base) {
  for (let i = 0; i < 100; i++) {
    try { await fetch(base); return; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  throw new Error('El servidor de prueba no arrancó.');
}

test('flujo completo contra el servidor', async (t) => {
  const temporal = mkdtempSync(join(tmpdir(), 'bitacora-flujo-'));
  const base = join(temporal, 'bitacora.db');
  const puerto = await puertoLibre();
  const entorno = {
    ...process.env, PORT: String(puerto), BITACORA_ACCESO_PRUEBA: '1', BITACORA_DB: base,
    BITACORA_RESPALDOS: join(temporal, 'respaldos'), BITACORA_ARCHIVO: join(temporal, 'archivo')
  };
  const servidor = spawn(process.execPath, ['server.js'], { cwd: RAIZ, env: entorno, stdio: 'ignore' });
  t.after(() => servidor.kill());
  await esperarServidor(`http://localhost:${puerto}`);

  const { stdout } = await promisify(execFile)(process.execPath, ['test/flujo-completo.mjs', base], {
    cwd: RAIZ, env: { ...entorno, BASE_PRUEBAS: `http://localhost:${puerto}` }
  }).catch((e) => e);   // con fallas sale con código 1, pero su salida dice cuáles

  const comprobaciones = [...stdout.matchAll(/^([✔✘]) (.+?)(?: {2}→ (.*))?$/gm)]
    .filter(([, , nombre]) => !/^(todo en orden|\d+ fallas)$/.test(nombre));   // la línea del resumen final
  assert.ok(comprobaciones.length > 100, `La batería no corrió completa:\n${stdout}`);
  for (const [, marca, nombre, detalle] of comprobaciones) {
    await t.test(nombre, () => assert.equal(marca, '✔', detalle || 'la regla no se cumplió'));
  }
});
