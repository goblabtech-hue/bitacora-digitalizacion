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
  organizacion: 'Bitácora de digitalización',
  folio_prefijo: 'BIT',
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
// cada carpeta pertenece a una caja; lo anterior a este cambio queda en la caja 1
agregarColumna('documentos', 'caja', 'INTEGER NOT NULL DEFAULT 1');
// situación en que sale cada carpeta al devolverla (NULL mientras no se coteje)
agregarColumna('documentos', 'situacion_devuelta', 'TEXT');
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

/* ── identificación de cada carpeta de investigación ──
   El NUC la identifica y el rango de folios permite comprobar que no falta
   ninguna hoja, no solo que el total cuadra. */
agregarColumna('documentos', 'nuc',           "TEXT NOT NULL DEFAULT ''");
agregarColumna('documentos', 'folio_inicial', 'INTEGER');
agregarColumna('documentos', 'folio_final',   'INTEGER');
db.exec("CREATE INDEX IF NOT EXISTS idx_documentos_nuc ON documentos(nuc) WHERE nuc <> '';");

/* ── tratamiento de cada carpeta durante la digitalización ──
   Preparación (descosido y revisión) y recosido con verificación final. La
   mesa y el escaneo viven en «asignaciones»; los post-its y documentos
   sueltos que se retiran, en «insertos». */
for (const [columna, definicion] of [
  ['prep_por',       "TEXT NOT NULL DEFAULT ''"],
  ['prep_en',        "TEXT NOT NULL DEFAULT ''"],
  ['prep_notas',     "TEXT NOT NULL DEFAULT ''"],
  ['recosido_por',   "TEXT NOT NULL DEFAULT ''"],
  ['recosido_en',    "TEXT NOT NULL DEFAULT ''"],
  ['recosido_notas', "TEXT NOT NULL DEFAULT ''"]
]) agregarColumna('documentos', columna, definicion);

// cancelación y eliminación: nunca se borra, solo se marca y se explica
for (const [columna, definicion] of [
  ['cancelada_por',      "TEXT NOT NULL DEFAULT ''"],
  ['cancelada_en',       "TEXT NOT NULL DEFAULT ''"],
  ['cancelacion_motivo', "TEXT NOT NULL DEFAULT ''"],
  ['eliminada_por',      "TEXT NOT NULL DEFAULT ''"],
  ['eliminada_en',       "TEXT NOT NULL DEFAULT ''"]
]) agregarColumna('remisiones', columna, definicion);

// una incidencia registrada no se borra: se anula con su motivo
for (const [columna, definicion] of [
  ['anulada_por',      "TEXT NOT NULL DEFAULT ''"],
  ['anulada_en',       "TEXT NOT NULL DEFAULT ''"],
  ['anulacion_motivo', "TEXT NOT NULL DEFAULT ''"]
]) agregarColumna('incidencias', columna, definicion);

db.exec(`
CREATE TABLE IF NOT EXISTS mesas (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  nombre      TEXT    NOT NULL UNIQUE,
  responsable TEXT    NOT NULL DEFAULT '',
  activa      INTEGER NOT NULL DEFAULT 1,
  creado_en   TEXT    NOT NULL
);

/* Cada paso de una carpeta por una mesa. Guarda el responsable de ese
   momento: si la mesa cambia de responsable, el historial no cambia. */
CREATE TABLE IF NOT EXISTS asignaciones (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  documento_id     INTEGER NOT NULL REFERENCES documentos(id),
  remision_id      INTEGER NOT NULL REFERENCES remisiones(id),
  mesa_id          INTEGER NOT NULL REFERENCES mesas(id),
  mesa             TEXT    NOT NULL,
  responsable      TEXT    NOT NULL,
  entrada_por      TEXT    NOT NULL DEFAULT '',
  entrada_en       TEXT    NOT NULL,
  salida_por       TEXT    NOT NULL DEFAULT '',
  salida_en        TEXT    NOT NULL DEFAULT '',
  fojas_escaneadas INTEGER,
  imagenes         INTEGER,
  cuadra           INTEGER,
  notas            TEXT    NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS insertos (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  documento_id    INTEGER NOT NULL REFERENCES documentos(id),
  remision_id     INTEGER NOT NULL REFERENCES remisiones(id),
  tipo            TEXT    NOT NULL,
  descripcion     TEXT    NOT NULL DEFAULT '',
  foja            INTEGER,
  retirado_por    TEXT    NOT NULL,
  retirado_en     TEXT    NOT NULL,
  reintegrado_por TEXT    NOT NULL DEFAULT '',
  reintegrado_en  TEXT    NOT NULL DEFAULT ''
);

/* Lo que no se puede hacer directamente se solicita y lo resuelve un
   supervisor distinto de quien lo pidió. */
CREATE TABLE IF NOT EXISTS solicitudes (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  remision_id   INTEGER NOT NULL REFERENCES remisiones(id),
  tipo          TEXT    NOT NULL,
  motivo        TEXT    NOT NULL,
  solicitada_por TEXT   NOT NULL,
  solicitada_en TEXT    NOT NULL,
  estado        TEXT    NOT NULL DEFAULT 'Pendiente',
  resuelta_por  TEXT    NOT NULL DEFAULT '',
  resuelta_en   TEXT    NOT NULL DEFAULT '',
  respuesta     TEXT    NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_asignaciones_documento ON asignaciones(documento_id);
CREATE INDEX IF NOT EXISTS idx_asignaciones_remision  ON asignaciones(remision_id);
CREATE INDEX IF NOT EXISTS idx_insertos_documento     ON insertos(documento_id);
CREATE INDEX IF NOT EXISTS idx_solicitudes_remision   ON solicitudes(remision_id);
CREATE INDEX IF NOT EXISTS idx_solicitudes_estado     ON solicitudes(estado);

/* Candados en la propia base: aunque un error de programación lo intente,
   las remisiones y su rastro no se pueden borrar ni reescribir. */
CREATE TRIGGER IF NOT EXISTS candado_remisiones BEFORE DELETE ON remisiones
BEGIN SELECT RAISE(ABORT, 'Las remisiones no se borran: se cancelan o se solicita su eliminación.'); END;

CREATE TRIGGER IF NOT EXISTS candado_eventos_borrar BEFORE DELETE ON eventos
BEGIN SELECT RAISE(ABORT, 'La bitácora de auditoría no se borra.'); END;

CREATE TRIGGER IF NOT EXISTS candado_eventos_cambiar BEFORE UPDATE ON eventos
BEGIN SELECT RAISE(ABORT, 'La bitácora de auditoría no se modifica.'); END;

CREATE TRIGGER IF NOT EXISTS candado_incidencias BEFORE DELETE ON incidencias
BEGIN SELECT RAISE(ABORT, 'Las incidencias no se borran: se anulan con su motivo.'); END;

CREATE TRIGGER IF NOT EXISTS candado_asignaciones BEFORE DELETE ON asignaciones
BEGIN SELECT RAISE(ABORT, 'El paso de una carpeta por una mesa no se borra.'); END;

CREATE TRIGGER IF NOT EXISTS candado_insertos BEFORE DELETE ON insertos
BEGIN SELECT RAISE(ABORT, 'Un inserto registrado no se borra.'); END;

CREATE TRIGGER IF NOT EXISTS candado_solicitudes BEFORE DELETE ON solicitudes
BEGIN SELECT RAISE(ABORT, 'Las solicitudes no se borran.'); END;

/* Una carpeta solo se puede quitar de una remisión mientras nadie la ha
   tocado: después de prepararla ya forma parte de la cadena de custodia. */
CREATE TRIGGER IF NOT EXISTS candado_documentos BEFORE DELETE ON documentos
WHEN OLD.prep_en <> ''
BEGIN SELECT RAISE(ABORT, 'Una carpeta que ya entró a digitalización no se puede quitar.'); END;
`);

export const TIPOS_INSERTO = ['Post-it', 'Documento suelto', 'Fotografía', 'Sobre o anexo', 'Otro'];
// dónde estaba el inserto respecto a su hoja, para devolverlo exactamente ahí
export const LADOS_INSERTO = ['Frente', 'Reverso', 'Entre esta hoja y la siguiente'];
agregarColumna('insertos', 'lado', "TEXT NOT NULL DEFAULT ''");
export const TIPOS_SOLICITUD = ['Corrección', 'Eliminación'];

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
    // la auditoría no se reescribe: queda constancia del cambio de nombre
    registrarEvento(null, 'Personal', `Nombre corregido: ${anterior} → ${nuevo}`, nuevo);
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

// «Mesa»: personal de una mesa de digitalización; solo ve y trabaja lo de su mesa
export const ROLES = ['Recepción', 'Operador', 'Mesa', 'Supervisor'];

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

// el estado lo mueve el propio flujo; «Cancelado» queda fuera de la secuencia
export const ESTADOS = ['Recibido', 'En digitalización', 'Digitalizado', 'Devuelto', 'Cancelado'];

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

/* ── sedes y ubicación física de cada carpeta ─────────────────────────────
   Una remisión se recibe en una sede; cada carpeta sabe en qué sede está
   ahora. Las cajas se mueven entre sedes con un traslado formal: mientras
   viajan nadie puede trabajarlas, y la sede destino confirma la llegada. */
db.exec(`
CREATE TABLE IF NOT EXISTS sedes (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  nombre    TEXT    NOT NULL UNIQUE,
  direccion TEXT    NOT NULL DEFAULT '',
  activa    INTEGER NOT NULL DEFAULT 1,
  creado_en TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS traslados (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  origen_id       INTEGER NOT NULL REFERENCES sedes(id),
  destino_id      INTEGER NOT NULL REFERENCES sedes(id),
  envia_por       TEXT    NOT NULL,
  enviado_en      TEXT    NOT NULL,
  transporta      TEXT    NOT NULL DEFAULT '',
  notas           TEXT    NOT NULL DEFAULT '',
  estado          TEXT    NOT NULL DEFAULT 'En tránsito',
  recibido_por    TEXT    NOT NULL DEFAULT '',
  recibido_en     TEXT    NOT NULL DEFAULT '',
  notas_recepcion TEXT    NOT NULL DEFAULT ''
);

/* lo que viaja en cada traslado: cajas completas, con lo que llevaban al
   salir y lo que se contó al llegar */
CREATE TABLE IF NOT EXISTS traslado_cajas (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  traslado_id        INTEGER NOT NULL REFERENCES traslados(id),
  remision_id        INTEGER NOT NULL REFERENCES remisiones(id),
  caja               INTEGER NOT NULL,
  carpetas           INTEGER NOT NULL,
  fojas              INTEGER NOT NULL,
  carpetas_recibidas INTEGER,
  fojas_recibidas    INTEGER
);

CREATE INDEX IF NOT EXISTS idx_traslado_cajas ON traslado_cajas(remision_id, caja);

CREATE TRIGGER IF NOT EXISTS candado_traslados BEFORE DELETE ON traslados
BEGIN SELECT RAISE(ABORT, 'Un traslado no se borra.'); END;
CREATE TRIGGER IF NOT EXISTS candado_traslado_cajas BEFORE DELETE ON traslado_cajas
BEGIN SELECT RAISE(ABORT, 'Un traslado no se borra.'); END;
`);
agregarColumna('remisiones', 'sede_id', 'INTEGER REFERENCES sedes(id)');
agregarColumna('documentos', 'sede_id', 'INTEGER REFERENCES sedes(id)');
agregarColumna('mesas', 'sede_id', 'INTEGER REFERENCES sedes(id)');
agregarColumna('usuarios', 'sede_id', 'INTEGER REFERENCES sedes(id)');
// quien tiene el rol «Mesa» trabaja solo lo que llega a su mesa
agregarColumna('usuarios', 'mesa_id', 'INTEGER REFERENCES mesas(id)');

/* Lo que existía antes de haber sedes queda en una «Sede principal», para que
   nada quede sin ubicación. */
if (!db.prepare('SELECT COUNT(*) AS n FROM sedes').get().n) {
  db.prepare('INSERT INTO sedes (nombre, creado_en) VALUES (?, ?)').run('Sede principal', new Date().toISOString());
}
{
  const principal = db.prepare('SELECT id FROM sedes ORDER BY id LIMIT 1').get().id;
  for (const tabla of ['remisiones', 'documentos', 'mesas', 'usuarios']) {
    db.prepare(`UPDATE ${tabla} SET sede_id = ? WHERE sede_id IS NULL`).run(principal);
  }
}

/* Cada sede tiene sus propias «Mesa 1, Mesa 2…»: el nombre deja de ser único
   en todo el sistema y pasa a ser único dentro de su sede. */
const defMesas = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='mesas'").get()?.sql || '';
if (/nombre\s+TEXT\s+NOT NULL UNIQUE/i.test(defMesas)) {
  db.exec('PRAGMA foreign_keys = OFF;');
  db.exec(`
    BEGIN;
    CREATE TABLE mesas_nueva (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      nombre      TEXT    NOT NULL,
      responsable TEXT    NOT NULL DEFAULT '',
      activa      INTEGER NOT NULL DEFAULT 1,
      creado_en   TEXT    NOT NULL,
      sede_id     INTEGER REFERENCES sedes(id)
    );
    INSERT INTO mesas_nueva (id, nombre, responsable, activa, creado_en, sede_id)
      SELECT id, nombre, responsable, activa, creado_en, sede_id FROM mesas;
    DROP TABLE mesas;
    ALTER TABLE mesas_nueva RENAME TO mesas;
    COMMIT;`);
  db.exec('PRAGMA foreign_keys = ON;');
}
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_mesas_sede_nombre ON mesas(sede_id, nombre);');

/** Subconsulta con las remisiones vigentes que le corresponden a una sede:
 *  las recibidas ahí, las que tienen cajas ahí y las que van en camino hacia
 *  ella. Con sedeId null, todas las vigentes. Los id son enteros de la propia
 *  base, así que se pueden escribir en la consulta. */
export function sqlVivas(sedeId = null) {
  if (sedeId === null) return "SELECT id FROM remisiones WHERE eliminada_en = ''";
  const ids = db.prepare(`
    SELECT r.id FROM remisiones r WHERE r.eliminada_en = '' AND (r.sede_id = ?
       OR EXISTS (SELECT 1 FROM documentos d WHERE d.remision_id = r.id AND d.sede_id = ?)
       OR EXISTS (SELECT 1 FROM traslado_cajas tc JOIN traslados t ON t.id = tc.traslado_id
                   WHERE tc.remision_id = r.id AND t.estado = 'En tránsito' AND t.destino_id = ?))`)
    .all(sedeId, sedeId, sedeId).map((x) => x.id);
  return `SELECT id FROM remisiones WHERE id IN (${ids.join(',') || 'NULL'})`;
}

/* ── qué secciones puede ver cada persona ──────────────────────────────────
   El rol propone las secciones y un supervisor las ajusta por persona. Se
   guardan como lista separada por comas; vacío = las del rol. */
export const MODULOS = [
  ['panel', 'Panel'], ['recepcion', 'Recepción'], ['digitalizacion', 'Digitalización'],
  ['devueltas', 'Devueltas'], ['personal', 'Personal'], ['bitacora', 'Bitácora'], ['reporte', 'Reporte del día'],
  // abrir los PDF de las carpetas: se da solo a quien lo necesita
  ['expedientes', 'Expedientes digitales']
];
const CLAVES_MODULOS = MODULOS.map(([clave]) => clave);
const POR_ROL = {
  Supervisor: CLAVES_MODULOS,
  Recepción: ['panel', 'recepcion', 'digitalizacion', 'devueltas', 'bitacora', 'reporte'],
  Operador: ['panel', 'digitalizacion', 'devueltas', 'bitacora', 'reporte'],
  Mesa: ['digitalizacion']
};
agregarColumna('usuarios', 'permisos', "TEXT NOT NULL DEFAULT ''");

export const permisosPorRol = (rol) => POR_ROL[rol] || [];

/** Secciones efectivas de una persona. El supervisor y la mesa son fijos:
 *  uno para que nadie pierda la administración, la otra porque solo trabaja
 *  lo de su mesa. */
export function permisosDe(persona) {
  if (!persona) return [];
  if (persona.rol === 'Supervisor' || persona.rol === 'Mesa') return permisosPorRol(persona.rol);
  const propios = String(persona.permisos || '').split(',').filter((p) => CLAVES_MODULOS.includes(p));
  return propios.length ? propios : permisosPorRol(persona.rol);
}

/** Limpia lo que llega del formulario: solo claves conocidas. */
export const limpiarPermisos = (lista) =>
  (Array.isArray(lista) ? lista : []).filter((p) => CLAVES_MODULOS.includes(p)).join(',');
