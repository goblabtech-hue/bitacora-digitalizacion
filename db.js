import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.BITACORA_DB || join(__dirname, 'data', 'bitacora.db');

mkdirSync(dirname(DB_PATH), { recursive: true });

export const db = new DatabaseSync(DB_PATH);

db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS remisiones (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  folio          TEXT    NOT NULL UNIQUE,
  fecha          TEXT    NOT NULL,
  hora           TEXT    NOT NULL DEFAULT '',
  dependencia    TEXT    NOT NULL,
  area           TEXT    NOT NULL DEFAULT '',
  entrega_nombre TEXT    NOT NULL,
  entrega_cargo  TEXT    NOT NULL DEFAULT '',
  recibe_nombre  TEXT    NOT NULL,
  recibe_cargo   TEXT    NOT NULL DEFAULT '',
  estado         TEXT    NOT NULL DEFAULT 'Recibido',
  observaciones  TEXT    NOT NULL DEFAULT '',
  creado_en      TEXT    NOT NULL,
  actualizado_en TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS documentos (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  remision_id   INTEGER NOT NULL REFERENCES remisiones(id) ON DELETE CASCADE,
  orden         INTEGER NOT NULL DEFAULT 0,
  descripcion   TEXT    NOT NULL,
  tipo          TEXT    NOT NULL DEFAULT '',
  cantidad      INTEGER NOT NULL DEFAULT 1,
  fojas         INTEGER NOT NULL DEFAULT 0,
  situacion     TEXT    NOT NULL DEFAULT 'Buen estado',
  observaciones TEXT    NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_documentos_remision ON documentos(remision_id);
CREATE INDEX IF NOT EXISTS idx_remisiones_fecha     ON remisiones(fecha);
CREATE INDEX IF NOT EXISTS idx_remisiones_estado    ON remisiones(estado);
`);

/* ── migraciones incrementales ── */
function columnas(tabla) {
  return db.prepare(`PRAGMA table_info(${tabla})`).all().map((c) => c.name);
}
function agregarColumna(tabla, nombre, definicion) {
  if (!columnas(tabla).includes(nombre)) {
    db.exec(`ALTER TABLE ${tabla} ADD COLUMN ${nombre} ${definicion}`);
  }
}

agregarColumna('remisiones', 'cajas',          "INTEGER NOT NULL DEFAULT 0");
agregarColumna('remisiones', 'carpetas',       "INTEGER NOT NULL DEFAULT 0");
agregarColumna('remisiones', 'firma_entrega',  "TEXT NOT NULL DEFAULT ''");
agregarColumna('remisiones', 'firma_recibe',   "TEXT NOT NULL DEFAULT ''");
agregarColumna('remisiones', 'firmado_en',     "TEXT NOT NULL DEFAULT ''");

db.exec(`
CREATE TABLE IF NOT EXISTS config (
  clave TEXT PRIMARY KEY,
  valor TEXT NOT NULL DEFAULT ''
);`);

export const CONFIG_POR_DEFECTO = {
  organizacion: 'Centro de Tecnologías del Sureste',
  folio_prefijo: 'CTS',
  leyenda_acuse: 'Recibí los documentos descritos en este acuse, en la cantidad y situación asentadas.'
};

export function leerConfig() {
  const filas = db.prepare('SELECT clave, valor FROM config').all();
  const valores = { ...CONFIG_POR_DEFECTO };
  for (const f of filas) if (f.clave in valores) valores[f.clave] = f.valor;
  return valores;
}

/** El prefijo va en cada folio, así que se limita a letras y dígitos. */
function limpiarPrefijo(valor) {
  const limpio = String(valor ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
  return limpio || CONFIG_POR_DEFECTO.folio_prefijo;
}

export function guardarConfig(cambios) {
  const stmt = db.prepare(
    'INSERT INTO config (clave, valor) VALUES (?, ?) ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor'
  );
  for (const clave of Object.keys(CONFIG_POR_DEFECTO)) {
    if (!(clave in cambios)) continue;
    const valor = clave === 'folio_prefijo'
      ? limpiarPrefijo(cambios[clave])
      : String(cambios[clave] ?? '').trim().slice(0, 300);
    stmt.run(clave, valor);
  }
  return leerConfig();
}

/* ── seguimiento de la digitalización, incidencias y devolución ── */

db.exec(`
CREATE TABLE IF NOT EXISTS usuarios (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  nombre    TEXT    NOT NULL UNIQUE,
  rol       TEXT    NOT NULL DEFAULT 'Operador',
  activo    INTEGER NOT NULL DEFAULT 1,
  creado_en TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS capturas (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  remision_id INTEGER NOT NULL REFERENCES remisiones(id) ON DELETE CASCADE,
  operador    TEXT    NOT NULL,
  inicio      TEXT    NOT NULL,
  fin         TEXT    NOT NULL DEFAULT '',
  imagenes    INTEGER NOT NULL DEFAULT 0,
  notas       TEXT    NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS incidencias (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  remision_id   INTEGER NOT NULL REFERENCES remisiones(id) ON DELETE CASCADE,
  tipo          TEXT    NOT NULL,
  gravedad      TEXT    NOT NULL DEFAULT 'Media',
  descripcion   TEXT    NOT NULL,
  reportada_por TEXT    NOT NULL DEFAULT '',
  reportada_en  TEXT    NOT NULL,
  estado        TEXT    NOT NULL DEFAULT 'Abierta',
  resolucion    TEXT    NOT NULL DEFAULT '',
  resuelta_por  TEXT    NOT NULL DEFAULT '',
  resuelta_en   TEXT    NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS eventos (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  remision_id INTEGER REFERENCES remisiones(id) ON DELETE CASCADE,
  tipo        TEXT    NOT NULL,
  detalle     TEXT    NOT NULL DEFAULT '',
  usuario     TEXT    NOT NULL DEFAULT '',
  fecha       TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_capturas_remision    ON capturas(remision_id);
CREATE INDEX IF NOT EXISTS idx_incidencias_remision ON incidencias(remision_id);
CREATE INDEX IF NOT EXISTS idx_incidencias_estado   ON incidencias(estado);
CREATE INDEX IF NOT EXISTS idx_eventos_remision     ON eventos(remision_id);
CREATE INDEX IF NOT EXISTS idx_eventos_fecha        ON eventos(fecha);
`);

/* Cotejo: lo que se asentó al recibir, lo que se verificó físicamente y lo
   que se devolvió. Quedan en NULL mientras nadie las revise, para poder
   distinguir «sin verificar» de «verificado en cero». */
for (const columna of ['cantidad_verificada', 'fojas_verificadas',
                       'cantidad_devuelta', 'fojas_devueltas']) {
  agregarColumna('documentos', columna, 'INTEGER');
}
for (const [columna, definicion] of [
  ['validada_por',     "TEXT NOT NULL DEFAULT ''"],
  ['validada_en',      "TEXT NOT NULL DEFAULT ''"],
  ['validacion_notas', "TEXT NOT NULL DEFAULT ''"],
  ['cotejo_por',       "TEXT NOT NULL DEFAULT ''"],
  ['cotejo_en',        "TEXT NOT NULL DEFAULT ''"],
  ['cotejo_notas',     "TEXT NOT NULL DEFAULT ''"]
]) agregarColumna('remisiones', columna, definicion);

// datos de la devolución y el punto de aceptación
for (const [columna, definicion] of [
  ['dev_fecha',          "TEXT NOT NULL DEFAULT ''"],
  ['dev_entrega_nombre', "TEXT NOT NULL DEFAULT ''"],
  ['dev_entrega_cargo',  "TEXT NOT NULL DEFAULT ''"],
  ['dev_recibe_nombre',  "TEXT NOT NULL DEFAULT ''"],
  ['dev_recibe_cargo',   "TEXT NOT NULL DEFAULT ''"],
  ['dev_medio',          "TEXT NOT NULL DEFAULT ''"],
  ['dev_archivos',       "INTEGER NOT NULL DEFAULT 0"],
  ['dev_aceptacion',     "TEXT NOT NULL DEFAULT ''"],
  ['dev_observaciones',  "TEXT NOT NULL DEFAULT ''"],
  ['dev_firma_entrega',  "TEXT NOT NULL DEFAULT ''"],
  ['dev_firma_recibe',   "TEXT NOT NULL DEFAULT ''"],
  ['dev_firmado_en',     "TEXT NOT NULL DEFAULT ''"]
]) agregarColumna('remisiones', columna, definicion);

/* La identidad pasó a ser el correo de Google: el nombre deja de ser único
   (dos personas pueden llamarse igual) y se agregan los datos de la cuenta. */
const defUsuarios = db.prepare(
  "SELECT sql FROM sqlite_master WHERE type='table' AND name='usuarios'").get()?.sql || '';
if (/nombre\s+TEXT\s+NOT NULL UNIQUE/i.test(defUsuarios)) {
  db.exec(`
    CREATE TABLE usuarios_nueva (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      nombre        TEXT    NOT NULL,
      email         TEXT    NOT NULL DEFAULT '',
      foto          TEXT    NOT NULL DEFAULT '',
      rol           TEXT    NOT NULL DEFAULT 'Operador',
      activo        INTEGER NOT NULL DEFAULT 1,
      ultimo_acceso TEXT    NOT NULL DEFAULT '',
      creado_en     TEXT    NOT NULL
    );
    INSERT INTO usuarios_nueva (id, nombre, rol, activo, creado_en)
      SELECT id, nombre, rol, activo, creado_en FROM usuarios;
    DROP TABLE usuarios;
    ALTER TABLE usuarios_nueva RENAME TO usuarios;
  `);
}
agregarColumna('usuarios', 'email',         "TEXT NOT NULL DEFAULT ''");
agregarColumna('usuarios', 'cargo',         "TEXT NOT NULL DEFAULT ''");
agregarColumna('usuarios', 'telefono',      "TEXT NOT NULL DEFAULT ''");
agregarColumna('usuarios', 'foto',          "TEXT NOT NULL DEFAULT ''");
agregarColumna('usuarios', 'ultimo_acceso', "TEXT NOT NULL DEFAULT ''");
db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_usuarios_email ON usuarios(email) WHERE email <> '';");

/** Secreto con el que se firman las cookies de sesión. Se crea al vuelo y
 *  vive en la base, nunca se expone por la API. */
export function secretoSesion() {
  const fila = db.prepare("SELECT valor FROM config WHERE clave = 'sesion_secreto'").get();
  if (fila?.valor) return fila.valor;
  const secreto = randomBytes(48).toString('base64url');
  db.prepare('INSERT INTO config (clave, valor) VALUES (?, ?)').run('sesion_secreto', secreto);
  return secreto;
}

/** Al corregir el nombre de alguien, su historial debe seguirle.
 *  Los campos afectados son los que guardan personal propio, nunca
 *  los de quien entrega, que es gente de la dependencia. */
export function renombrarPersona(anterior, nuevo) {
  if (!anterior || !nuevo || anterior === nuevo) return;
  db.exec('BEGIN');
  try {
    db.prepare('UPDATE remisiones SET recibe_nombre = ? WHERE recibe_nombre = ?').run(nuevo, anterior);
    db.prepare('UPDATE remisiones SET dev_entrega_nombre = ? WHERE dev_entrega_nombre = ?').run(nuevo, anterior);
    db.prepare('UPDATE capturas   SET operador = ?       WHERE operador = ?').run(nuevo, anterior);
    db.prepare('UPDATE eventos    SET usuario = ?        WHERE usuario = ?').run(nuevo, anterior);
    db.prepare('UPDATE incidencias SET reportada_por = ? WHERE reportada_por = ?').run(nuevo, anterior);
    db.prepare('UPDATE incidencias SET resuelta_por = ?  WHERE resuelta_por = ?').run(nuevo, anterior);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

/* ── dependencias y su tablero ──────────────────────────────────────────
   Cada dependencia tiene un enlace propio, con una llave larga y revocable,
   para consultar el avance de sus documentos sin necesidad de una cuenta. */
db.exec(`
CREATE TABLE IF NOT EXISTS dependencias (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  nombre    TEXT    NOT NULL UNIQUE,
  llave     TEXT    NOT NULL UNIQUE,
  activo    INTEGER NOT NULL DEFAULT 1,
  creado_en TEXT    NOT NULL
);`);

const nuevaLlave = () => randomBytes(24).toString('base64url');

/** Registra la dependencia si es la primera vez que aparece. */
export function asegurarDependencia(nombre) {
  const limpio = String(nombre || '').trim();
  if (!limpio) return null;
  const existente = db.prepare('SELECT * FROM dependencias WHERE nombre = ?').get(limpio);
  if (existente) return existente;
  db.prepare('INSERT INTO dependencias (nombre, llave, creado_en) VALUES (?,?,?)')
    .run(limpio, nuevaLlave(), new Date().toISOString());
  return db.prepare('SELECT * FROM dependencias WHERE nombre = ?').get(limpio);
}

export function dependenciaPorLlave(llave) {
  if (!llave || llave.length < 20) return null;
  const fila = db.prepare('SELECT * FROM dependencias WHERE llave = ?').get(llave);
  return fila && fila.activo ? fila : null;
}

export function regenerarLlave(id) {
  db.prepare('UPDATE dependencias SET llave = ? WHERE id = ?').run(nuevaLlave(), id);
  return db.prepare('SELECT * FROM dependencias WHERE id = ?').get(id);
}

export const ROLES = ['Recepción', 'Operador', 'Supervisor'];

export const TIPOS_INCIDENCIA = [
  'Faltante respecto al inventario',
  'Documento en mal estado',
  'Documento ilegible',
  'Daño ocurrido en el proceso',
  'Error de foliación',
  'Falla de equipo o escáner',
  'Documento fuera de orden',
  'Otra'
];

export const GRAVEDADES = ['Baja', 'Media', 'Alta'];

export const MEDIOS_ENTREGA = [
  'Disco duro externo', 'Memoria USB', 'Almacenamiento en la nube',
  'DVD', 'Entrega en servidor del cliente'
];

export const ACEPTACIONES = ['Aceptado', 'Aceptado con observaciones', 'Rechazado'];

/** Deja constancia de un movimiento en la bitácora de auditoría. */
export function registrarEvento(remisionId, tipo, detalle = '', usuario = '') {
  db.prepare('INSERT INTO eventos (remision_id, tipo, detalle, usuario, fecha) VALUES (?,?,?,?,?)')
    .run(remisionId, tipo, detalle, usuario, new Date().toISOString());
}

export const ESTADOS = ['Recibido', 'En digitalización', 'Digitalizado', 'Devuelto'];

export const SITUACIONES = [
  'Buen estado',
  'Regular',
  'Deteriorado',
  'Incompleto',
  'Húmedo o manchado',
  'Roto o frágil',
  'Empastado',
  'Con grapas o clips',
  'Foliado',
  'Sin foliar'
];

export function nuevoFolio(fecha) {
  const anio = String(fecha || '').slice(0, 4) || String(new Date().getFullYear());
  const prefijo = `${leerConfig().folio_prefijo}-${anio}-`;
  const row = db
    .prepare(
      `SELECT MAX(CAST(substr(folio, ?) AS INTEGER)) AS ultimo
         FROM remisiones WHERE folio LIKE ?`
    )
    .get(prefijo.length + 1, prefijo + '%');
  const siguiente = (row?.ultimo || 0) + 1;
  return prefijo + String(siguiente).padStart(4, '0');
}
