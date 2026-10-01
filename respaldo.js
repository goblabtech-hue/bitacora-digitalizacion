import { readdirSync, statSync, unlinkSync, mkdirSync, existsSync, createReadStream } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { db } from './db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
export { createReadStream };
export const CARPETA = process.env.BITACORA_RESPALDOS || join(__dirname, 'respaldos');
const CONSERVAR = Number(process.env.BITACORA_RESPALDOS_CONSERVAR) || 30;

mkdirSync(CARPETA, { recursive: true });

const marcaLocal = (d = new Date()) => {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
};

export function listarRespaldos() {
  return readdirSync(CARPETA)
    .filter((f) => f.startsWith('bitacora-') && f.endsWith('.db'))
    .map((archivo) => {
      const info = statSync(join(CARPETA, archivo));
      return {
        archivo,
        fecha: archivo.slice(9, 19),
        creado_en: info.mtime.toISOString(),
        bytes: info.size
      };
    })
    .sort((a, b) => b.archivo.localeCompare(a.archivo));
}

/** Ruta de una copia, validando el nombre para que no se salga de la carpeta. */
export function rutaRespaldo(archivo) {
  if (!/^bitacora-\d{4}-\d{2}-\d{2}-\d{4}\.db$/.test(String(archivo || ''))) return null;
  const destino = join(CARPETA, archivo);
  return destino.startsWith(CARPETA) && existsSync(destino) ? destino : null;
}

export function crearRespaldo() {
  const destino = join(CARPETA, `bitacora-${marcaLocal()}.db`);
  // VACUUM INTO produce una copia íntegra y compactada, segura con WAL activo
  db.exec(`VACUUM INTO '${destino.replace(/'/g, "''")}'`);
  purgar();
  const info = statSync(destino);
  return { archivo: destino.split('/').pop(), creado_en: info.mtime.toISOString(), bytes: info.size };
}

function purgar() {
  const sobran = listarRespaldos().slice(CONSERVAR);
  for (const r of sobran) {
    try { unlinkSync(join(CARPETA, r.archivo)); } catch { /* ignorar */ }
  }
}

/** Respalda si aún no hay copia del día de hoy. Devuelve la copia creada o null. */
export function respaldarSiHaceFalta() {
  const hoy = marcaLocal().slice(0, 10);
  if (listarRespaldos().some((r) => r.fecha === hoy)) return null;
  return crearRespaldo();
}

/** Arranca el respaldo diario automático: al iniciar y cada hora se revisa la fecha. */
export function programarRespaldos() {
  const intentar = () => {
    try {
      const r = respaldarSiHaceFalta();
      if (r) console.log(`  Respaldo automático: ${r.archivo} (${(r.bytes / 1024).toFixed(0)} KB)`);
    } catch (e) {
      console.error('  No se pudo respaldar:', e.message);
    }
  };
  intentar();
  setInterval(intentar, 60 * 60 * 1000).unref();
}
