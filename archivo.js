/* ══════════════════════════════════════════════════════════════════════
   Expedientes digitales: el PDF de cada carpeta de investigación.

   Se guardan en una carpeta configurable (BITACORA_ARCHIVO), que puede ser
   una NAS montada en el servidor o un disco local, ordenados como
   sede/lote/NUC.pdf. Nunca se sobrescribe ni se borra un archivo: una nueva
   versión se guarda aparte y la anterior queda como histórica. De cada uno
   se registra su huella SHA-256, que prueba que no se alteró después.
   ══════════════════════════════════════════════════════════════════════ */
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';
import { db, registrarEvento } from './db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const CARPETA = resolve(process.env.BITACORA_ARCHIVO || join(__dirname, 'data', 'archivo'));
const MAX_BYTES = (Number(process.env.BITACORA_ARCHIVO_MAX_MB) || 1024) * 1024 * 1024;

/* Si la carpeta está en una NAS y la NAS se desconecta, su ruta deja de
   existir: entonces NO se crea en el disco local (los PDF quedarían fuera de
   la NAS sin que nadie lo note). Solo se crea al arrancar, y solo si la
   carpeta que la contiene existe. */
if (!existsSync(CARPETA) && existsSync(dirname(CARPETA))) mkdirSync(CARPETA);
export const almacenamientoDisponible = () => existsSync(CARPETA);

db.exec(`
CREATE TABLE IF NOT EXISTS archivos (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  documento_id    INTEGER NOT NULL REFERENCES documentos(id),
  remision_id     INTEGER NOT NULL REFERENCES remisiones(id),
  ruta            TEXT    NOT NULL,
  nombre_original TEXT    NOT NULL DEFAULT '',
  bytes           INTEGER NOT NULL,
  paginas         INTEGER NOT NULL,
  sha256          TEXT    NOT NULL,
  subido_por      TEXT    NOT NULL,
  subido_en       TEXT    NOT NULL,
  vigente         INTEGER NOT NULL DEFAULT 1,
  motivo          TEXT    NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_archivos_documento ON archivos(documento_id);
CREATE TRIGGER IF NOT EXISTS candado_archivos BEFORE DELETE ON archivos
BEGIN SELECT RAISE(ABORT, 'El registro de un expediente digital no se borra.'); END;
`);

/** Un error que se explica a quien subió el archivo. */
export class ErrorArchivo extends Error {}

/** Para nombres de carpeta y de archivo: sin rutas ni caracteres raros. */
const limpio = (s) => String(s || 'sin-nombre').normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'sin-nombre';

/* ──────────────────────── conteo de páginas ──────────────────────── */

/** Total de páginas de un PDF: el /Count mayor de sus nodos /Pages (la raíz).
 *  Muchos escáneres comprimen esos nodos en flujos de objetos, así que
 *  también se buscan dentro de ellos, descomprimidos con zlib. */
export function contarPaginas(buffer) {
  const texto = buffer.toString('latin1');
  if (!texto.startsWith('%PDF-')) throw new ErrorArchivo('El archivo no es un PDF.');
  const fuentes = [texto];
  for (const m of texto.matchAll(/\/Type\s*\/ObjStm[\s\S]*?stream\r?\n/g)) {
    const inicio = m.index + m[0].length;
    const fin = texto.indexOf('endstream', inicio);
    if (fin < 0) continue;
    try { fuentes.push(inflateSync(buffer.subarray(inicio, fin)).toString('latin1')); } catch { /* flujo no comprimido con zlib */ }
  }
  let total = 0;
  for (const f of fuentes) {
    for (const m of f.matchAll(/\/Type\s*\/Pages(?![A-Za-z])/g)) {
      const entorno = f.slice(Math.max(0, m.index - 400), m.index + 400);
      for (const c of entorno.matchAll(/\/Count\s+(\d+)/g)) total = Math.max(total, Number(c[1]));
    }
  }
  if (!total) {
    // sin árbol de páginas legible: se cuentan las páginas sueltas
    for (const f of fuentes) total += [...f.matchAll(/\/Type\s*\/Page(?![A-Za-z])/g)].length;
  }
  if (!total) throw new ErrorArchivo('No se pudo leer cuántas páginas tiene el PDF.');
  return total;
}

/* ─────────────────────────── guardar ─────────────────────────────── */

/** Recibe el PDF del cuerpo de la petición y lo guarda por partes, sin
 *  cargarlo entero en memoria mientras llega. */
function recibir(req, destinoTemporal) {
  return new Promise((ok, mal) => {
    const hash = createHash('sha256');
    const salida = createWriteStream(destinoTemporal, { flags: 'wx' });
    let bytes = 0;
    let fallo = null;
    req.on('data', (parte) => {
      bytes += parte.length;
      if (bytes > MAX_BYTES && !fallo) {
        fallo = new ErrorArchivo(`El archivo pasa del máximo de ${MAX_BYTES / 1024 / 1024} MB.`);
        req.unpipe(salida);
        salida.destroy();
        req.resume();
        return;
      }
      hash.update(parte);
    });
    req.on('end', () => { if (fallo) mal(fallo); });
    req.on('error', mal);
    salida.on('error', (e) => mal(fallo || e));
    salida.on('finish', () => (fallo ? mal(fallo) : ok({ bytes, sha256: hash.digest('hex') })));
    req.pipe(salida);
  });
}

/**
 * Guarda el PDF de una carpeta ya escaneada.
 * Sus páginas tienen que coincidir con las imágenes del escaneo. Si la
 * carpeta ya tenía PDF, el nuevo exige un motivo y el anterior se conserva.
 */
export async function guardarArchivo(req, r, d, { usuario, nombre = '', motivo = '' }) {
  if (!['Escaneada', 'Recosida'].includes(d.etapa)) {
    req.resume();
    throw new ErrorArchivo('El PDF se sube después de registrar un escaneo completo.');
  }
  if (r.dev_firmado_en) { req.resume(); throw new ErrorArchivo('El lote ya se devolvió y su acuse está firmado.'); }
  const previo = db.prepare('SELECT * FROM archivos WHERE documento_id = ? AND vigente = 1').get(d.id);
  const motivoLimpio = String(motivo || '').trim().slice(0, 500);
  if (previo && motivoLimpio.length < 10) {
    req.resume();
    throw new ErrorArchivo('Esta carpeta ya tiene PDF: explica por qué se reemplaza (al menos 10 caracteres).');
  }

  if (!almacenamientoDisponible()) {
    req.resume();
    throw new ErrorArchivo('El almacenamiento de expedientes no está disponible. Revisa que la NAS esté conectada.');
  }
  const escaneo = r.asignaciones.filter((a) => a.documento_id === d.id && a.cuadra).at(-1);
  const relativa = join(limpio(d.sede), limpio(r.folio));
  const directorio = join(CARPETA, relativa);
  mkdirSync(directorio, { recursive: true });
  const temporal = join(directorio, `.subiendo-${randomBytes(6).toString('hex')}`);

  let recibido;
  try {
    recibido = await recibir(req, temporal);
    if (!recibido.bytes) throw new ErrorArchivo('El archivo llegó vacío.');
    const paginas = contarPaginas(readFileSync(temporal));
    if (escaneo && paginas !== escaneo.imagenes) {
      throw new ErrorArchivo(`El PDF tiene ${paginas} páginas y en el escaneo se reportaron ${escaneo.imagenes} imágenes. ` +
        'Revisa que sea el archivo correcto y que esté completo.');
    }

    // nunca se sobrescribe: si el nombre existe, se guarda como versión nueva
    const base = limpio(d.nuc || `carpeta-${d.id}`);
    let nombreFinal = `${base}.pdf`;
    for (let v = 2; existsSync(join(directorio, nombreFinal)); v++) nombreFinal = `${base}.v${v}.pdf`;
    renameSync(temporal, join(directorio, nombreFinal));

    const t = new Date().toISOString();
    db.exec('BEGIN');
    try {
      if (previo) db.prepare('UPDATE archivos SET vigente = 0 WHERE id = ?').run(previo.id);
      db.prepare(`INSERT INTO archivos (documento_id, remision_id, ruta, nombre_original, bytes, paginas, sha256,
                  subido_por, subido_en, motivo) VALUES (?,?,?,?,?,?,?,?,?,?)`)
        .run(d.id, r.id, join(relativa, nombreFinal), String(nombre).slice(0, 200), recibido.bytes, paginas,
             recibido.sha256, usuario, t, motivoLimpio);
      registrarEvento(r.id, 'Expediente digital',
        `${previo ? 'PDF reemplazado' : 'PDF subido'} · caja ${d.caja} · ${d.nuc} · ${paginas} páginas · ` +
        `SHA-256 ${recibido.sha256.slice(0, 16)}…${previo ? ` · motivo: ${motivoLimpio}` : ''}`, usuario);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  } finally {
    if (existsSync(temporal)) unlinkSync(temporal);   // solo el temporal de una subida fallida
  }
}

/* ─────────────────────────── consultar ───────────────────────────── */

/** Abre un PDF para enviarlo, comprobando que siga siendo el que se subió. */
export function abrirArchivo(id) {
  const a = db.prepare('SELECT * FROM archivos WHERE id = ?').get(Number(id));
  if (!a) return null;
  const ruta = resolve(CARPETA, a.ruta);
  if (!ruta.startsWith(CARPETA + sep) || !existsSync(ruta)) return { ...a, falta: true };
  return { ...a, ruta_completa: ruta, tamano_actual: statSync(ruta).size, flujo: () => createReadStream(ruta) };
}

/** Recalcula la huella de un archivo guardado y la compara con la registrada. */
export function verificarArchivo(id) {
  const a = abrirArchivo(id);
  if (!a || a.falta) return { ok: false, motivo: 'El archivo no está en el almacenamiento.' };
  const actual = createHash('sha256').update(readFileSync(a.ruta_completa)).digest('hex');
  return actual === a.sha256 ? { ok: true } : { ok: false, motivo: 'La huella no coincide: el archivo cambió después de subirse.' };
}

export const archivosDe = (remisionId) =>
  db.prepare('SELECT * FROM archivos WHERE remision_id = ? ORDER BY id').all(remisionId);
