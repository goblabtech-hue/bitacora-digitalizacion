import { createServer } from 'node:http';
import { createServer as createServerTLS } from 'node:https';
import { readFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { readFile } from 'node:fs/promises';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  db, ESTADOS, SITUACIONES, ROLES, TIPOS_INCIDENCIA, GRAVEDADES, MEDIOS_ENTREGA,
  ACEPTACIONES, TIPOS_INSERTO, LADOS_INSERTO, TIPOS_SOLICITUD, nuevoFolio, leerConfig, guardarConfig, registrarEvento,
  renombrarPersona, asegurarDependencia, dependenciaPorLlave, regenerarLlave, sqlVivas,
  MODULOS, permisosDe, permisosPorRol, limpiarPermisos
} from './db.js';
import {
  ErrorRegla, ETAPAS, completarCustodia, bloqueada, prepararCarpeta, enviarAMesa, registrarEscaneo,
  recoserCarpeta, listarMesas, guardarMesa, cancelarRemision, crearSolicitud, resolverSolicitud,
  consumirCorreccion, solicitudesPendientes, nombreCarpeta, iniciada, trabajoDigitalizacion,
  crearTraslado, recibirTraslado, listarTraslados, listarCarpetas
} from './custodia.js';
import { reportePeriodo, rango } from './reporte.js';
import {
  guardarArchivo, abrirArchivo, verificarArchivo, ErrorArchivo, almacenamientoDisponible, CARPETA as CARPETA_ARCHIVO
} from './archivo.js';
import { crearRespaldo, listarRespaldos, programarRespaldos, rutaRespaldo, createReadStream } from './respaldo.js';
import {
  ssoActivo, pruebaActiva, accesoActivo, iniciar, regresar, sesionDe, salir, baseUrl,
  sembrarPrueba, usuariosPrueba, entrarPrueba, esCuentaPrueba
} from './auth.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, 'public');
const PORT = Number(process.env.PORT) || 4321;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json'
};

/* ---------------------------------------------------------------- helpers */

const ahora = () => new Date().toISOString();
/** Quién realiza la acción. Sale siempre de la sesión verificada: nunca de
 *  lo que mande el navegador, para que nadie firme a nombre de otro. */
const usuarioDe = (req) => sesionDe(req)?.nombre || '';
const rolDe = (req) => sesionDe(req)?.rol || '';
const esSupervisor = (req) => rolDe(req) === 'Supervisor';
/** Sede a la que se limita lo que ve una persona; null para un supervisor,
 *  que ve todas. Quien trabaja en una mesa pertenece a la sede de su mesa. */
const sedeDe = (req) => {
  const s = sesionDe(req);
  if (!s || s.rol === 'Supervisor') return null;
  if (s.rol === 'Mesa') return db.prepare('SELECT sede_id FROM mesas WHERE id = ?').get(s.mesa_id)?.sede_id ?? -1;
  return s.sede_id ?? -1;
};
const mesaDe = (req) => (rolDe(req) === 'Mesa' ? sesionDe(req).mesa_id ?? -1 : null);

/* Quien trabaja en una mesa solo usa lo indispensable para su mesa. */
const RUTAS_DE_MESA = [
  ['GET', /^\/api\/(config|sugerencias|digitalizacion)$/],
  ['GET', /^\/api\/remisiones\/\d+$/],
  ['POST', /^\/api\/remisiones\/\d+\/carpetas\/\d+\/(preparacion|escaneo|recosido|archivo)$/],
  ['GET', /^\/api\/archivos\/\d+$/],
  ['POST', /^\/api\/remisiones\/\d+\/incidencias$/]
];

/* Qué sección hace falta para cada ruta. Una ruta que no aparece aquí la
   usan varias secciones (catálogos, detalle de un lote…) y la cuidan sus
   propias reglas. */
const SECCION_DE_RUTA = [
  ['GET', /^\/api\/(estadisticas|eventos|dependencias)$/, ['panel']],
  ['GET', /^\/api\/reporte$/, ['reporte']],
  ['*', /^\/api\/(digitalizacion|traslados)/, ['digitalizacion']],
  ['POST', /^\/api\/remisiones\/\d+\/(mesa|carpetas\/)/, ['digitalizacion']],
  ['POST', /^\/api\/remisiones$/, ['recepcion']],
  ['PUT', /^\/api\/remisiones\/\d+(\/validacion)?$/, ['recepcion']],
  ['POST', /^\/api\/remisiones\/\d+\/(firma|cancelacion)$/, ['recepcion']],
  ['*', /^\/api\/remisiones\/\d+\/(devolucion|cotejo)/, ['devueltas']],
  ['GET', /^\/api\/remisiones$/, ['panel', 'bitacora', 'devueltas', 'recepcion']],
  ['GET', /^\/api\/usuarios$/, ['personal']],
  ['GET', /^\/api\/carpetas$/, ['panel', 'bitacora', 'expedientes']],
  ['GET', /^\/api\/incidencias$/, ['panel', 'bitacora']],
  ['GET', /^\/api\/archivos\/\d+/, ['expedientes']]
];

/** ¿Tiene esta persona la sección que pide la ruta? */
function seccionPermitida(req, ruta) {
  const regla = SECCION_DE_RUTA.find(([m, r]) => (m === '*' || m === req.method) && r.test(ruta));
  if (!regla) return true;
  const propias = permisosDe(sesionDe(req));
  return regla[2].some((s) => propias.includes(s));
}

/** ¿Puede esta persona ver esta remisión? Por sede, o por mesa. */
function puedeVer(req, remisionId) {
  const mesa = mesaDe(req);
  if (mesa !== null) {
    return Boolean(db.prepare('SELECT 1 FROM asignaciones WHERE remision_id = ? AND mesa_id = ?').get(remisionId, mesa));
  }
  const sede = sedeDe(req);
  if (sede === null) return true;
  return Boolean(db.prepare(`SELECT 1 FROM (${sqlVivas(sede)}) v WHERE v.id = ?`).get(remisionId));
}

/** Sede y mesa de una persona según su rol. */
function lugarDePersona(cuerpo, rol) {
  if (rol === 'Mesa') {
    const mesa = db.prepare('SELECT * FROM mesas WHERE id = ? AND activa = 1').get(Number(cuerpo.mesa_id));
    if (!mesa) throw new ErrorRegla('Elige la mesa en la que trabaja esta persona.');
    return { sede_id: mesa.sede_id, mesa_id: mesa.id };
  }
  const sede = db.prepare('SELECT id FROM sedes WHERE id = ? AND activa = 1').get(Number(cuerpo.sede_id))
    || db.prepare('SELECT id FROM sedes ORDER BY id LIMIT 1').get();
  return { sede_id: sede.id, mesa_id: null };
}
const texto = (v, max = 300) => String(v ?? '').trim().slice(0, max);
const entero = (v, min = 0) => {
  const n = Math.trunc(Number(v));
  return Number.isFinite(n) && n >= min ? n : min;
};

/** Valida una firma capturada en el navegador (PNG en base64). */
function imagenFirma(v) {
  const dato = String(v ?? '');
  if (!dato) return '';
  if (!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(dato)) throw new Error('Firma no válida.');
  if (dato.length > 400_000) throw new Error('La firma es demasiado pesada.');
  return dato;
}

function json(res, code, data) {
  const body = JSON.stringify(data);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function leerCuerpo(req) {
  return new Promise((resolve, reject) => {
    let bruto = '';
    req.on('data', (c) => {
      bruto += c;
      if (bruto.length > 2_000_000) reject(new Error('Cuerpo demasiado grande'));
    });
    req.on('end', () => {
      try {
        resolve(bruto ? JSON.parse(bruto) : {});
      } catch {
        reject(new Error('JSON inválido'));
      }
    });
    req.on('error', reject);
  });
}

/* ------------------------------------------------------------ validación */

function validarRemision(datos) {
  const errores = [];
  const fecha = texto(datos.fecha, 10) || ahora().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) errores.push('La fecha no es válida.');
  if (!texto(datos.dependencia)) errores.push('Indica la dependencia que entrega.');
  if (!texto(datos.entrega_nombre)) errores.push('Indica quién entrega los documentos.');
  if (!texto(datos.recibe_nombre)) errores.push('Indica quién recepciona los documentos.');

  /* Cada documento es una carpeta de investigación dentro de una caja. Las
     filas en blanco se descartan y las cajas se renumeran 1, 2, 3… en el
     orden en que llegan. El NUC la identifica y el rango de folios permite
     comprobar después que no falta ninguna hoja. */
  const documentos = Array.isArray(datos.documentos) ? datos.documentos : [];
  const folio = (v) => (v === '' || v === null || v === undefined ? null : entero(v, 0));
  const limpios = documentos
    .map((d) => ({
      id: Number(d.id) || null,
      caja: entero(d.caja, 1),
      nuc: texto(d.nuc, 60).toUpperCase(),
      descripcion: texto(d.descripcion, 400),
      tipo: texto(d.tipo, 120),
      cantidad: entero(d.cantidad ?? 1, 1),
      folio_inicial: folio(d.folio_inicial),
      folio_final: folio(d.folio_final),
      fojas: entero(d.fojas, 0),
      situacion: texto(d.situacion, 120) || 'Buen estado',
      observaciones: texto(d.observaciones, 600)
    }))
    .filter((d) => d.nuc || d.descripcion || d.fojas || d.observaciones || d.folio_inicial !== null);

  const numeroCaja = new Map();
  const carpetasPorCaja = new Map();
  limpios.forEach((d, i) => {
    if (!numeroCaja.has(d.caja)) numeroCaja.set(d.caja, numeroCaja.size + 1);
    d.caja = numeroCaja.get(d.caja);
    d.orden = i;
    const n = (carpetasPorCaja.get(d.caja) || 0) + 1;
    carpetasPorCaja.set(d.caja, n);
    const cual = `la carpeta ${n} de la caja ${d.caja}`;

    if (!d.nuc) errores.push(`Escribe el NUC de ${cual}.`);
    if (d.fojas < 1) errores.push(`Indica las fojas de ${cual}.`);
    if (d.situacion === 'Sin foliar') return;
    if (d.folio_inicial === null || d.folio_final === null) {
      errores.push(`Indica el folio inicial y final de ${cual} (o marca su situación como «Sin foliar»).`);
    } else if (d.folio_final < d.folio_inicial) {
      errores.push(`En ${cual} el folio final es menor que el inicial.`);
    } else if (d.fojas !== d.folio_final - d.folio_inicial + 1 && !d.observaciones) {
      // folios «bis», saltos de numeración…: se admite, pero explicado
      errores.push(`En ${cual} los folios ${d.folio_inicial}–${d.folio_final} suman ` +
        `${d.folio_final - d.folio_inicial + 1} fojas y se asentaron ${d.fojas}: explica la diferencia en observaciones.`);
    }
  });

  if (limpios.length === 0) errores.push('Registra al menos una caja con sus carpetas.');

  return {
    errores,
    valor: {
      fecha,
      hora: texto(datos.hora, 5),
      dependencia: texto(datos.dependencia),
      area: texto(datos.area),
      entrega_nombre: texto(datos.entrega_nombre),
      entrega_cargo: texto(datos.entrega_cargo),
      recibe_nombre: texto(datos.recibe_nombre),
      recibe_cargo: texto(datos.recibe_cargo),
      sede_id: Number(datos.sede_id) || null,
      // se calculan de las carpetas capturadas, para que siempre cuadren
      cajas: numeroCaja.size,
      carpetas: limpios.length,
      observaciones: texto(datos.observaciones, 2000),
      documentos: limpios
    }
  };
}

/* --------------------------------------------------------------- consultas */

const SQL_TOTALES = `
  (SELECT COALESCE(SUM(d.cantidad), 0) FROM documentos d WHERE d.remision_id = r.id) AS total_documentos,
  (SELECT COALESCE(SUM(d.fojas), 0)    FROM documentos d WHERE d.remision_id = r.id) AS total_fojas,
  (SELECT COUNT(*)                     FROM documentos d WHERE d.remision_id = r.id) AS total_partidas,
  (SELECT COALESCE(SUM(a.imagenes), 0) FROM asignaciones a WHERE a.remision_id = r.id AND a.cuadra = 1) AS total_imagenes,
  (SELECT COUNT(*) FROM asignaciones a WHERE a.remision_id = r.id AND a.salida_en = '')   AS capturas_abiertas,
  (SELECT COUNT(*) FROM documentos d WHERE d.remision_id = r.id AND d.recosido_en <> '')  AS carpetas_terminadas,
  (SELECT COUNT(*) FROM incidencias i WHERE i.remision_id = r.id AND i.estado = 'Abierta')  AS incidencias_abiertas`;

/* Las remisiones eliminadas no aparecen en ninguna lista; solo un
   supervisor las consulta, pidiéndolas expresamente. */
function listarRemisiones({ q = '', estado = '', desde = '', hasta = '', dependencia = '', eliminadas = '' }, sedeId = null) {
  const filtros = [eliminadas === '1' ? "r.eliminada_en <> ''" : "r.eliminada_en = ''"];
  if (sedeId !== null) filtros.push(`r.id IN (${sqlVivas(sedeId)})`);
  const params = [];

  if (q) {
    filtros.push(`(r.folio LIKE ? OR r.dependencia LIKE ? OR r.area LIKE ?
      OR r.entrega_nombre LIKE ? OR r.recibe_nombre LIKE ?
      OR EXISTS (SELECT 1 FROM documentos d WHERE d.remision_id = r.id
                 AND (d.descripcion LIKE ? OR d.nuc LIKE ?)))`);
    const like = `%${q}%`;
    params.push(like, like, like, like, like, like, like);
  }
  if (estado === 'en_proceso') filtros.push("r.estado IN ('Recibido', 'En digitalización')");
  else if (estado) { filtros.push('r.estado = ?'); params.push(estado); }
  if (dependencia) { filtros.push('r.dependencia = ?'); params.push(dependencia); }
  if (desde) { filtros.push('r.fecha >= ?'); params.push(desde); }
  if (hasta) { filtros.push('r.fecha <= ?'); params.push(hasta); }

  const where = filtros.length ? `WHERE ${filtros.join(' AND ')}` : '';
  return db
    .prepare(`SELECT r.*, ${SQL_TOTALES} FROM remisiones r ${where}
              ORDER BY r.fecha DESC, r.id DESC LIMIT 500`)
    .all(...params);
}

function obtenerRemision(id) {
  const remision = db
    .prepare(`SELECT r.*, ${SQL_TOTALES} FROM remisiones r WHERE r.id = ?`)
    .get(id);
  if (!remision) return null;
  remision.documentos = db
    .prepare('SELECT * FROM documentos WHERE remision_id = ? ORDER BY orden, id')
    .all(id);
  remision.incidencias = db
    .prepare('SELECT * FROM incidencias WHERE remision_id = ? ORDER BY reportada_en DESC, id DESC')
    .all(id);
  remision.eventos = db
    .prepare('SELECT * FROM eventos WHERE remision_id = ? ORDER BY fecha DESC, id DESC LIMIT 200')
    .all(id);
  remision.validacion = diferencias(remision.documentos, CAMPOS_COTEJO.validacion);
  remision.cotejo = diferencias(remision.documentos, CAMPOS_COTEJO.cotejo);
  return completarCustodia(remision);
}

function crearRemision(v) {
  db.exec('BEGIN');
  try {
    const t = ahora();
    asegurarDependencia(v.dependencia);
    const folio = nuevoFolio(v.fecha);
    const { lastInsertRowid } = db
      .prepare(
        `INSERT INTO remisiones
         (folio, fecha, hora, dependencia, area, entrega_nombre, entrega_cargo,
          recibe_nombre, recibe_cargo, estado, cajas, carpetas, observaciones,
          creado_en, actualizado_en, sede_id)
         VALUES (?,?,?,?,?,?,?,?,?,'Recibido',?,?,?,?,?,?)`
      )
      .run(folio, v.fecha, v.hora, v.dependencia, v.area, v.entrega_nombre,
           v.entrega_cargo, v.recibe_nombre, v.recibe_cargo, v.cajas,
           v.carpetas, v.observaciones, t, t, v.sede_id);

    const alta = db.prepare(SQL_ALTA_CARPETA);
    for (const d of v.documentos) alta.run(...valoresCarpeta(Number(lastInsertRowid), d, v.sede_id));
    db.exec('COMMIT');
    return Number(lastInsertRowid);
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

const SQL_ALTA_CARPETA = `INSERT INTO documentos
  (remision_id, orden, caja, nuc, descripcion, tipo, cantidad, folio_inicial, folio_final, fojas, situacion,
   observaciones, sede_id)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`;
const valoresCarpeta = (remisionId, d, sedeId) => [remisionId, d.orden, d.caja, d.nuc, d.descripcion, d.tipo,
  d.cantidad, d.folio_inicial, d.folio_final, d.fojas, d.situacion, d.observaciones, sedeId];

const CAMPOS_REMISION = {
  fecha: 'Fecha', hora: 'Hora', dependencia: 'Dependencia', area: 'Área',
  entrega_nombre: 'Entrega', entrega_cargo: 'Cargo de quien entrega',
  recibe_nombre: 'Recibe', recibe_cargo: 'Cargo de quien recibe', observaciones: 'Observaciones'
};
const CAMPOS_CARPETA = {
  caja: 'caja', nuc: 'NUC', descripcion: 'descripción', folio_inicial: 'folio inicial',
  folio_final: 'folio final', fojas: 'fojas', situacion: 'situación', observaciones: 'observaciones'
};

/** Describe, campo por campo, qué cambia entre lo guardado y lo nuevo. */
function describirCambios(previa, v) {
  const cambios = [];
  const ver = (v) => (v === '' || v === null || v === undefined ? '—' : v);
  for (const [campo, nombre] of Object.entries(CAMPOS_REMISION)) {
    if (String(previa[campo] ?? '') !== String(v[campo] ?? '')) {
      cambios.push(`${nombre}: «${ver(previa[campo])}» → «${ver(v[campo])}»`);
    }
  }
  const nuevas = new Map(v.documentos.filter((d) => d.id).map((d) => [d.id, d]));
  for (const d of previa.documentos) {
    const n = nuevas.get(d.id);
    if (!n) { cambios.push(`Se quitó la carpeta ${d.nuc || d.descripcion} (caja ${d.caja}, ${d.fojas} fojas)`); continue; }
    const difs = Object.entries(CAMPOS_CARPETA)
      .filter(([campo]) => String(d[campo] ?? '') !== String(n[campo] ?? ''))
      .map(([campo, nombre]) => `${nombre} ${ver(d[campo])} → ${ver(n[campo])}`);
    if (difs.length) cambios.push(`Carpeta ${d.nuc || d.descripcion}: ${difs.join(', ')}`);
  }
  for (const n of v.documentos.filter((d) => !d.id)) {
    cambios.push(`Se agregó la carpeta ${n.nuc} (caja ${n.caja}, ${n.fojas} fojas)`);
  }
  return cambios;
}

/* La edición actualiza cada carpeta en su lugar: conservan su identidad y
   su historial. Si se edita con una corrección autorizada, lo ya validado o
   firmado deja de corresponder y se tiene que volver a hacer. */
function actualizarRemision(previa, v, reiniciar) {
  const id = previa.id;
  db.exec('BEGIN');
  try {
    asegurarDependencia(v.dependencia);
    db.prepare(
      `UPDATE remisiones SET fecha=?, hora=?, dependencia=?, area=?, entrega_nombre=?,
        entrega_cargo=?, recibe_nombre=?, recibe_cargo=?, cajas=?, carpetas=?,
        observaciones=?, firma_entrega='', firma_recibe='', firmado_en='', actualizado_en=?
       WHERE id=?`
    ).run(v.fecha, v.hora, v.dependencia, v.area, v.entrega_nombre, v.entrega_cargo,
          v.recibe_nombre, v.recibe_cargo, v.cajas, v.carpetas, v.observaciones, ahora(), id);
    if (reiniciar) {
      db.prepare(`UPDATE remisiones SET validada_por='', validada_en='', validacion_notas='' WHERE id = ?`).run(id);
    }

    const conservadas = new Set(v.documentos.map((d) => d.id).filter(Boolean));
    for (const d of previa.documentos) {
      if (!conservadas.has(d.id)) db.prepare('DELETE FROM documentos WHERE id = ?').run(d.id);
    }
    const cambiar = db.prepare(`UPDATE documentos SET orden=?, caja=?, nuc=?, descripcion=?, tipo=?, cantidad=?,
      folio_inicial=?, folio_final=?, fojas=?, situacion=?, observaciones=?
      ${reiniciar ? ', cantidad_verificada = NULL, fojas_verificadas = NULL' : ''}
      WHERE id=? AND remision_id=?`);
    const alta = db.prepare(SQL_ALTA_CARPETA);
    for (const d of v.documentos) {
      if (d.id && previa.documentos.some((x) => x.id === d.id)) {
        cambiar.run(d.orden, d.caja, d.nuc, d.descripcion, d.tipo, d.cantidad, d.folio_inicial,
          d.folio_final, d.fojas, d.situacion, d.observaciones, d.id, id);
      } else {
        alta.run(...valoresCarpeta(id, d, previa.sede_id));
      }
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

/** Estado que le corresponde a un lote según el avance de sus carpetas.
 *  Sirve para regresarlo a resguardo si se cancela la devolución. */
function estadoSegunAvance(id) {
  const c = db.prepare(`SELECT COUNT(*) AS total,
                          SUM(CASE WHEN prep_en <> '' OR EXISTS (SELECT 1 FROM asignaciones a
                                    WHERE a.documento_id = documentos.id) THEN 1 ELSE 0 END) AS iniciadas,
                          SUM(CASE WHEN recosido_en <> '' THEN 1 ELSE 0 END) AS terminadas
                          FROM documentos WHERE remision_id = ?`).get(id);
  if (c.total && c.terminadas === c.total) return 'Digitalizado';
  return c.iniciadas ? 'En digitalización' : 'Recibido';
}

/* Campos de cada cotejo. La devolución también asienta la situación en que
   sale cada carpeta, para dejar constancia de que se entrega como se recibió. */
const CAMPOS_COTEJO = {
  validacion: ['cantidad_verificada', 'fojas_verificadas'],
  cotejo: ['cantidad_devuelta', 'fojas_devueltas', 'situacion_devuelta']
};

/** Diferencias entre lo asentado y lo verificado o devuelto. */
function diferencias(documentos, [campoCantidad, campoFojas, campoSituacion]) {
  const revisados = documentos.filter((d) => d[campoCantidad] !== null && d[campoCantidad] !== undefined);
  return {
    revisadas: revisados.length,
    total: documentos.length,
    completo: revisados.length === documentos.length,
    documentos: revisados.reduce((a, d) => a + (d[campoCantidad] - d.cantidad), 0),
    fojas: revisados.reduce((a, d) => a + ((d[campoFojas] ?? d.fojas) - d.fojas), 0),
    // carpetas cuya situación cambió entre la recepción y la devolución
    cambios: campoSituacion
      ? revisados.filter((d) => d[campoSituacion] && d[campoSituacion] !== d.situacion).length
      : 0
  };
}

/** Aplica lo capturado sobre las carpetas, sin escribir todavía. */
function proyectarCotejo(documentos, capturas, [campoCantidad, campoFojas, campoSituacion]) {
  const capturado = new Map(
    (Array.isArray(capturas) ? capturas : []).map((p) => [Number(p.id), p]));
  return documentos.map((d) => {
    const p = capturado.get(d.id);
    if (!p) return d;
    const proyectado = { ...d, [campoCantidad]: entero(p.cantidad, 0), [campoFojas]: entero(p.fojas, 0) };
    if (campoSituacion) proyectado[campoSituacion] = texto(p.situacion, 120) || d.situacion;
    return proyectado;
  });
}

/** Escribe el cotejo ya validado. */
function guardarCotejo(id, proyectados, [campoCantidad, campoFojas, campoSituacion]) {
  db.exec('BEGIN');
  try {
    const stmt = db.prepare(
      `UPDATE documentos SET ${campoCantidad} = ?, ${campoFojas} = ?
         ${campoSituacion ? `, ${campoSituacion} = ?` : ''} WHERE id = ? AND remision_id = ?`);
    for (const d of proyectados) {
      if (d[campoCantidad] === null || d[campoCantidad] === undefined) continue;
      const valores = [d[campoCantidad], d[campoFojas]];
      if (campoSituacion) valores.push(d[campoSituacion]);
      stmt.run(...valores, d.id, id);
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

/** Mueve el estado del lote solo cuando corresponde avanzar. */
function avanzarEstado(id, nuevoEstado, usuario) {
  const actual = db.prepare('SELECT estado FROM remisiones WHERE id = ?').get(id)?.estado;
  if (actual === nuevoEstado) return;
  const orden = ESTADOS.indexOf(nuevoEstado);
  if (orden < ESTADOS.indexOf(actual)) return;          // nunca retrocede solo
  db.prepare('UPDATE remisiones SET estado = ?, actualizado_en = ? WHERE id = ?')
    .run(nuevoEstado, ahora(), id);
  registrarEvento(id, 'Estado', `${actual} → ${nuevoEstado}`, usuario);
}

function validarDevolucion(datos) {
  const errores = [];
  const fecha = texto(datos.dev_fecha, 10) || ahora().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) errores.push('La fecha de devolución no es válida.');
  if (!texto(datos.dev_entrega_nombre)) errores.push('Indica quién entrega la devolución.');
  if (!texto(datos.dev_recibe_nombre)) errores.push('Indica quién recibe de la dependencia.');
  const aceptacion = texto(datos.dev_aceptacion);
  if (!ACEPTACIONES.includes(aceptacion)) errores.push('Indica el resultado de la aceptación.');
  return {
    errores,
    valor: {
      dev_fecha: fecha,
      dev_entrega_nombre: texto(datos.dev_entrega_nombre),
      dev_entrega_cargo: texto(datos.dev_entrega_cargo),
      dev_recibe_nombre: texto(datos.dev_recibe_nombre),
      dev_recibe_cargo: texto(datos.dev_recibe_cargo),
      dev_medio: texto(datos.dev_medio, 120),
      dev_archivos: entero(datos.dev_archivos, 0),
      dev_aceptacion: aceptacion,
      dev_observaciones: texto(datos.dev_observaciones, 2000)
    }
  };
}

/** Personal con lo que ha hecho: recepciones atendidas y captura realizada. */
function listarPersonal(sedeId = null) {
  return db.prepare(`
    SELECT u.*, (SELECT nombre FROM sedes s WHERE s.id = u.sede_id) AS sede,
      (SELECT nombre FROM mesas m WHERE m.id = u.mesa_id) AS mesa,
      (SELECT COUNT(*) FROM remisiones r WHERE r.recibe_nombre = u.nombre)              AS recepciones,
      (SELECT COUNT(*) FROM asignaciones a WHERE a.responsable = u.nombre AND a.cuadra = 1) AS sesiones,
      (SELECT COALESCE(SUM(a.imagenes), 0) FROM asignaciones a
        WHERE a.responsable = u.nombre AND a.cuadra = 1)                                  AS imagenes,
      (SELECT MAX(e.fecha) FROM eventos e WHERE e.usuario = u.nombre)                   AS ultima_actividad
      FROM usuarios u
     ${sedeId === null ? '' : 'WHERE u.sede_id = ?'}
     ORDER BY u.activo DESC, u.nombre`).all(...(sedeId === null ? [] : [sedeId]))
    .map((u) => ({ ...u, secciones: permisosDe(u) }));
}

/** Vista de una dependencia sobre sus propios lotes. Solo lectura y sin
 *  datos internos: ni firmas, ni auditoría, ni notas de otras dependencias. */
function tableroDe(dependencia) {
  const lotes = db.prepare(`
    SELECT r.id, r.folio, r.fecha, r.hora, r.area, r.estado, r.cajas, r.carpetas,
           r.recibe_nombre, r.creado_en,
           r.dev_fecha, r.dev_aceptacion, r.dev_archivos, r.dev_medio,
           ${SQL_TOTALES}
      FROM remisiones r
     WHERE r.dependencia = ? AND r.eliminada_en = ''
     ORDER BY r.fecha DESC, r.id DESC`).all(dependencia.nombre);

  /* Por confidencialidad el tablero solo muestra cifras: ni NUC, ni
     descripciones de carpetas, ni el texto de las incidencias. */
  const incidencias = db.prepare(`
    SELECT i.remision_id, i.tipo, i.gravedad, i.estado, i.reportada_en
      FROM incidencias i
      JOIN remisiones r ON r.id = i.remision_id
     WHERE r.dependencia = ? AND i.anulada_en = ''
     ORDER BY i.reportada_en DESC`).all(dependencia.nombre);

  for (const lote of lotes) {
    lote.incidencias = incidencias.filter((i) => i.remision_id === lote.id);
    delete lote.id;
    lote.incidencias.forEach((i) => delete i.remision_id);
  }

  const suma = (campo) => lotes.reduce((a, l) => a + (l[campo] || 0), 0);
  return {
    dependencia: dependencia.nombre,
    organizacion: leerConfig().organizacion,
    generado_en: ahora(),
    resumen: {
      lotes: lotes.length,
      documentos: suma('total_documentos'),
      fojas: suma('total_fojas'),
      imagenes: suma('total_imagenes'),
      cajas: suma('cajas'),
      carpetas: suma('carpetas'),
      en_proceso: lotes.filter((l) => l.estado === 'Recibido' || l.estado === 'En digitalización').length,
      devueltos: lotes.filter((l) => l.estado === 'Devuelto').length,
      incidencias_abiertas: incidencias.filter((i) => i.estado === 'Abierta').length
    },
    lotes
  };
}

/* Las cifras solo cuentan remisiones vigentes: las eliminadas no existen
   para la operación, aunque sigan guardadas. */
/** Periodo pedido: desde–hasta (o una sola fecha), en días locales. */
function periodoDe(p) {
  const valida = (f) => /^\d{4}-\d{2}-\d{2}$/.test(f || '');
  let desde = valida(p.desde) ? p.desde : valida(p.fecha) ? p.fecha : ahora().slice(0, 10);
  let hasta = valida(p.hasta) ? p.hasta : valida(p.fecha) ? p.fecha : desde;
  if (hasta < desde) [desde, hasta] = [hasta, desde];
  return { desde, hasta, desfase: Math.max(-840, Math.min(840, Number(p.desfase) || 0)) };
}

/* Las cifras de actividad (recibido, escaneado, producción) son del periodo;
   las de estado (lotes, incidencias, acumulado) son de este momento. */
function estadisticas(sedeId = null, { desde, hasta, desfase }) {
  const [ini, fin] = rango(desde, hasta, desfase);
  const VIVAS = sqlVivas(sedeId);
  const g = db.prepare(`
    SELECT (SELECT COUNT(*) FROM remisiones WHERE id IN (${VIVAS})) AS remisiones,
           COALESCE(SUM(cantidad),0) AS documentos, COALESCE(SUM(fojas),0) AS fojas
      FROM documentos WHERE remision_id IN (${VIVAS})`).get();
  const hoyRow = db.prepare(`
    SELECT (SELECT COUNT(*) FROM remisiones WHERE id IN (${VIVAS}) AND fecha BETWEEN ? AND ?) AS remisiones,
           COALESCE(SUM(d.cantidad),0) AS documentos, COALESCE(SUM(d.fojas),0) AS fojas
      FROM documentos d JOIN remisiones r ON r.id = d.remision_id
     WHERE r.id IN (${VIVAS}) AND r.fecha BETWEEN ? AND ?`).get(desde, hasta, desde, hasta);
  const porEstado = db.prepare(`SELECT estado, COUNT(*) AS total FROM remisiones
                                 WHERE id IN (${VIVAS}) GROUP BY estado`).all();
  const porDependencia = db.prepare(`
    SELECT r.dependencia,
           COUNT(*) AS remisiones,
           COALESCE(SUM((SELECT SUM(d.cantidad) FROM documentos d WHERE d.remision_id = r.id)), 0) AS documentos,
           COALESCE(SUM((SELECT SUM(d.fojas)    FROM documentos d WHERE d.remision_id = r.id)), 0) AS fojas
      FROM remisiones r WHERE r.id IN (${VIVAS})
     GROUP BY r.dependencia ORDER BY documentos DESC LIMIT 8`).all();
  const porSituacion = db.prepare(`
    SELECT situacion, COALESCE(SUM(cantidad),0) AS documentos
      FROM documentos WHERE remision_id IN (${VIVAS})
     GROUP BY situacion ORDER BY documentos DESC`).all();

  // la producción sale de las carpetas escaneadas en las mesas
  const produccion = db.prepare(`
    SELECT COALESCE(SUM(CASE WHEN cuadra = 1 THEN imagenes END), 0) AS imagenes,
           SUM(CASE WHEN salida_en = '' THEN 1 ELSE 0 END)          AS capturas_abiertas,
           COALESCE(SUM(CASE WHEN cuadra = 1 AND salida_en >= ? AND salida_en < ? THEN imagenes END), 0) AS imagenes_hoy
      FROM asignaciones WHERE remision_id IN (${VIVAS})`).get(ini, fin);
  produccion.capturas_abiertas ||= 0;

  const incidencias = db.prepare(`
    SELECT COUNT(*) AS total,
           SUM(CASE WHEN estado = 'Abierta' THEN 1 ELSE 0 END) AS abiertas
      FROM incidencias WHERE anulada_en = '' AND remision_id IN (${VIVAS})`).get();

  const porOperador = db.prepare(`
    SELECT responsable AS operador,
           COUNT(*) AS sesiones,
           COALESCE(SUM(imagenes), 0) AS imagenes
      FROM asignaciones WHERE cuadra = 1 AND remision_id IN (${VIVAS}) AND salida_en >= ? AND salida_en < ?
     GROUP BY responsable ORDER BY imagenes DESC LIMIT 8`).all(ini, fin);

  return { global: g, hoy: hoyRow, porEstado, porDependencia, porSituacion,
           produccion, incidencias, porOperador };
}

function sugerencias() {
  const col = (tabla, campo) =>
    db.prepare(`SELECT DISTINCT ${campo} AS v FROM ${tabla} WHERE ${campo} <> '' ORDER BY ${campo}`)
      .all().map((r) => r.v);
  return {
    dependencias: col('remisiones', 'dependencia'),
    areas: col('remisiones', 'area'),
    entregan: col('remisiones', 'entrega_nombre'),
    reciben: col('remisiones', 'recibe_nombre'),
    cargos: [...new Set([...col('remisiones', 'entrega_cargo'), ...col('remisiones', 'recibe_cargo')])].sort(),
    tipos: col('documentos', 'tipo'),
    estados: ESTADOS,
    etapas: ETAPAS,
    tipos_inserto: TIPOS_INSERTO,
    lados_inserto: LADOS_INSERTO,
    tipos_solicitud: TIPOS_SOLICITUD,
    mesas: listarMesas(),
    situaciones: SITUACIONES,
    roles: ROLES,
    tipos_incidencia: TIPOS_INCIDENCIA,
    gravedades: GRAVEDADES,
    medios_entrega: MEDIOS_ENTREGA,
    aceptaciones: ACEPTACIONES,
    usuarios: db.prepare('SELECT id, nombre, email, rol, cargo, activo, sede_id, mesa_id FROM usuarios ORDER BY nombre').all(),
    sedes: db.prepare('SELECT id, nombre, activa FROM sedes ORDER BY nombre').all(),
    modulos: MODULOS,
    permisos_por_rol: Object.fromEntries(ROLES.map((r) => [r, permisosPorRol(r)]))
  };
}

function csv(filtros) {
  const escapar = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const encabezados = ['Folio', 'Fecha', 'Hora', 'Dependencia', 'Área', 'Entrega', 'Cargo entrega',
    'Recibe', 'Cargo recibe', 'Estado', 'Cajas', 'Carpetas', 'Caja', 'Carpeta', 'NUC', 'Descripción',
    'Folio inicial', 'Folio final', 'Fojas', 'Situación', 'Preparada', 'Escaneada', 'Recosida',
    'Situación al devolver', 'Observaciones carpeta', 'Observaciones remisión'];
  const lineas = [encabezados.join(',')];
  for (const r of listarRemisiones(filtros)) {
    const docs = db.prepare('SELECT * FROM documentos WHERE remision_id = ? ORDER BY orden, id').all(r.id);
    const escaneo = new Map(db.prepare(
      'SELECT documento_id, MAX(salida_en) AS fin FROM asignaciones WHERE remision_id = ? AND cuadra = 1 GROUP BY documento_id'
    ).all(r.id).map((a) => [a.documento_id, a.fin]));
    docs.forEach((d, i) => {
      lineas.push([r.folio, r.fecha, r.hora, r.dependencia, r.area, r.entrega_nombre, r.entrega_cargo,
        r.recibe_nombre, r.recibe_cargo, r.estado, r.cajas, r.carpetas, d.caja, i + 1, d.nuc, d.descripcion,
        d.folio_inicial, d.folio_final, d.fojas, d.situacion, d.prep_en, escaneo.get(d.id) || '', d.recosido_en,
        d.situacion_devuelta || '', d.observaciones, r.observaciones].map(escapar).join(','));
    });
  }
  return '﻿' + lineas.join('\r\n');
}

/* ---------------------------------------------------------------- estático */

async function servirEstatico(res, ruta) {
  const limpia = normalize(ruta === '/' ? '/index.html' : ruta).replace(/^(\.\.[/\\])+/, '');
  const archivo = join(PUBLIC_DIR, limpia);
  if (!archivo.startsWith(PUBLIC_DIR)) return json(res, 403, { error: 'Prohibido' });
  try {
    const contenido = await readFile(archivo);
    res.writeHead(200, { 'Content-Type': MIME[extname(archivo)] || 'application/octet-stream' });
    res.end(contenido);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('No encontrado');
  }
}

/* ------------------------------------------------------------------- rutas */

/* Con certificado, el sistema habla HTTPS: es lo que exige el acceso con
   Google fuera de localhost, y de paso cifra el tráfico en la red. */
const TLS = process.env.BITACORA_TLS_CERT && process.env.BITACORA_TLS_KEY
  ? {
      cert: readFileSync(process.env.BITACORA_TLS_CERT),
      key: readFileSync(process.env.BITACORA_TLS_KEY)
    }
  : null;

const atender = async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const ruta = url.pathname;
  const p = Object.fromEntries(url.searchParams);

  try {
    /* ── tablero de la dependencia: público, de solo lectura, por llave ── */
    const tableroWeb = ruta.match(/^\/tablero\/([\w-]{20,})$/);
    if (tableroWeb && req.method === 'GET') return servirEstatico(res, '/tablero.html');

    const tableroApi = ruta.match(/^\/api\/tablero\/([\w-]{20,})$/);
    if (tableroApi && req.method === 'GET') {
      const dependencia = dependenciaPorLlave(tableroApi[1]);
      if (!dependencia) return json(res, 404, { error: 'Este enlace no es válido o fue revocado.' });
      return json(res, 200, tableroDe(dependencia));
    }

    /* señal de vida para el servicio que lo aloja */
    if (ruta === '/salud') {
      const n = db.prepare('SELECT COUNT(*) AS n FROM remisiones').get().n;
      return json(res, 200, { ok: true, remisiones: n });
    }

    /* ── acceso con Google ── */
    if (ruta === '/auth/google' && req.method === 'GET') {
      if (!ssoActivo()) return json(res, 400, { error: 'El acceso con Google no está configurado.' });
      return iniciar(req, res);
    }
    if (ruta === '/auth/google/callback' && req.method === 'GET') {
      try {
        await regresar(req, url, res);
        res.writeHead(302, { Location: '/' });
        return res.end();
      } catch (e) {
        res.writeHead(302, { Location: `/?acceso=${encodeURIComponent(e.message)}` });
        return res.end();
      }
    }
    if (ruta === '/auth/salir' && req.method === 'POST') {
      salir(req, res);
      return json(res, 200, { ok: true });
    }
    if (ruta === '/auth/prueba' && req.method === 'POST') {
      try {
        const cuerpo = await leerCuerpo(req);
        const persona = entrarPrueba(req, res, cuerpo.email);
        return json(res, 200, { nombre: persona.nombre, rol: persona.rol });
      } catch (e) {
        return json(res, 400, { errores: [e.message] });
      }
    }
    if (ruta === '/api/sesion' && req.method === 'GET') {
      const persona = accesoActivo() ? sesionDe(req) : null;
      return json(res, 200, {
        sso: ssoActivo(),
        prueba: pruebaActiva(),
        acceso: accesoActivo(),
        configurado: accesoActivo(),
        cuentas_prueba: usuariosPrueba(),
        usuario: persona
          ? {
              nombre: persona.nombre, email: persona.email, rol: persona.rol,
              foto: persona.foto, es_prueba: esCuentaPrueba(persona.email),
              sede_id: sedeDe(req), mesa_id: mesaDe(req), permisos: permisosDe(persona),
              sede: db.prepare('SELECT nombre FROM sedes WHERE id = ?').get(sedeDe(req))?.nombre || '',
              mesa: db.prepare('SELECT nombre FROM mesas WHERE id = ?').get(mesaDe(req))?.nombre || ''
            }
          : null
      });
    }

    if (!ruta.startsWith('/api/')) return servirEstatico(res, ruta);

    /* Sin acceso configurado no se trabaja: cada registro tiene que quedar a
       nombre de una persona verificada. Y la API solo responde a sesiones. */
    if (!accesoActivo()) {
      return json(res, 503, { error: 'El acceso con Google no está configurado. Consulta el README.' });
    }
    if (!sesionDe(req)) return json(res, 401, { error: 'Inicia sesión para continuar.' });
    if (rolDe(req) === 'Mesa' && !RUTAS_DE_MESA.some(([m, r]) => m === req.method && r.test(ruta))) {
      return json(res, 403, { errores: ['Desde una mesa solo se trabajan las carpetas asignadas a ella.'] });
    }
    if (rolDe(req) !== 'Mesa' && !seccionPermitida(req, ruta)) {
      return json(res, 403, { errores: ['No tienes acceso a esa sección. Pídeselo a un supervisor.'] });
    }
    const remisionDeRuta = ruta.match(/^\/api\/remisiones\/(\d+)/);
    if (remisionDeRuta && !puedeVer(req, Number(remisionDeRuta[1]))) {
      return json(res, 404, { error: 'Remisión no encontrada' });
    }

    if (ruta === '/api/estadisticas' && req.method === 'GET') {
      return json(res, 200, estadisticas(sedeDe(req), periodoDe(p)));
    }

    /* ── listados para ir del Panel al detalle ── */
    if (ruta === '/api/carpetas' && req.method === 'GET') {
      // recibidas en un periodo (desde/hasta, o fecha) y escaneadas en otro (escaneadas_desde/hasta)
      const recibidas = p.desde || p.fecha ? periodoDe(p) : null;
      const escaneo = p.escaneadas_desde || p.escaneadas
        ? periodoDe({ desde: p.escaneadas_desde || p.escaneadas, hasta: p.escaneadas_hasta || p.escaneadas, desfase: p.desfase })
        : null;
      const escaneadas = escaneo ? rango(escaneo.desde, escaneo.hasta, escaneo.desfase) : null;
      const lotes = db.prepare(`SELECT id FROM remisiones WHERE id IN (${sqlVivas(sedeDe(req))})
        ${recibidas ? 'AND fecha BETWEEN ? AND ?' : ''} ORDER BY fecha DESC, id DESC`)
        .all(...(recibidas ? [recibidas.desde, recibidas.hasta] : [])).map((x) => x.id);
      return json(res, 200, listarCarpetas(lotes, {
        situacion: texto(p.situacion, 120), etapa: texto(p.etapa, 40), q: texto(p.q, 80),
        responsable: texto(p.responsable, 120), escaneadas, conArchivo: p.con_archivo === '1'
      }));
    }
    if (ruta === '/api/incidencias' && req.method === 'GET') {
      return json(res, 200, db.prepare(`
        SELECT i.*, r.folio, r.dependencia FROM incidencias i JOIN remisiones r ON r.id = i.remision_id
         WHERE r.id IN (${sqlVivas(sedeDe(req))}) AND i.anulada_en = ''
           ${p.estado === 'Abierta' ? "AND i.estado = 'Abierta'" : ''}
         ORDER BY i.reportada_en DESC LIMIT 500`).all());
    }

    if (ruta === '/api/config') {
      if (req.method === 'GET') {
        return json(res, 200, leerConfig());
      }
      if (req.method === 'PUT') {
        if (!esSupervisor(req)) return json(res, 403, { errores: ['Solo un supervisor cambia los ajustes.'] });
        const cambios = await leerCuerpo(req);
        const previa = leerConfig();
        const nueva = guardarConfig(cambios);
        const difs = Object.keys(nueva).filter((k) => previa[k] !== nueva[k])
          .map((k) => `${k}: «${previa[k]}» → «${nueva[k]}»`);
        if (difs.length) registrarEvento(null, 'Ajustes', difs.join(' · '), usuarioDe(req));
        return json(res, 200, nueva);
      }
    }

    if (ruta === '/api/respaldos') {
      if (req.method === 'GET') return json(res, 200, listarRespaldos());
      if (req.method === 'POST') return json(res, 201, crearRespaldo());
    }

    /* Descargar una copia: con el sistema alojado fuera, es la manera de
       tener el respaldo en un disco propio. */
    const bajarRespaldo = ruta.match(/^\/api\/respaldos\/([\w.-]+)$/);
    if (bajarRespaldo && req.method === 'GET') {
      if (!esSupervisor(req)) return json(res, 403, { error: 'Solo un supervisor descarga respaldos.' });
      const archivo = rutaRespaldo(decodeURIComponent(bajarRespaldo[1]));
      if (!archivo) return json(res, 404, { error: 'Ese respaldo no existe.' });
      res.writeHead(200, {
        'Content-Type': 'application/vnd.sqlite3',
        'Content-Disposition': `attachment; filename="${archivo.split('/').pop()}"`
      });
      return createReadStream(archivo).pipe(res);
    }
    if (ruta === '/api/sugerencias' && req.method === 'GET') return json(res, 200, sugerencias());

    if (ruta === '/api/exportar.csv' && req.method === 'GET') {
      if (!esSupervisor(req)) return json(res, 403, { error: 'Solo un supervisor exporta la información.' });
      if (p.eliminadas === '1') delete p.eliminadas;
      const cuerpo = csv(p);
      registrarEvento(null, 'Exportación', `CSV · ${new URLSearchParams(p).toString() || 'sin filtros'}`, usuarioDe(req));
      res.writeHead(200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="bitacora-${new Date().toISOString().slice(0, 10)}.csv"`
      });
      return res.end(cuerpo);
    }

    if (ruta === '/api/remisiones') {
      if (req.method === 'GET') {
        if (p.eliminadas === '1' && !esSupervisor(req)) {
          return json(res, 403, { error: 'Solo un supervisor consulta las remisiones eliminadas.' });
        }
        return json(res, 200, listarRemisiones(p, sedeDe(req)));
      }
      if (req.method === 'POST') {
        const { errores, valor } = validarRemision(await leerCuerpo(req));
        if (sedeDe(req) !== null) valor.sede_id = sedeDe(req);
        if (!db.prepare('SELECT 1 FROM sedes WHERE id = ? AND activa = 1').get(valor.sede_id)) {
          errores.push('Elige la sede donde se recibe.');
        }
        if (errores.length) return json(res, 400, { errores });
        const nuevoId = crearRemision(valor);
        registrarEvento(nuevoId, 'Recepción',
          `${valor.cajas} caja${valor.cajas === 1 ? '' : 's'} · ${valor.carpetas} carpeta${valor.carpetas === 1 ? '' : 's'} · ${valor.dependencia}`,
          usuarioDe(req));
        return json(res, 201, obtenerRemision(nuevoId));
      }
    }

    /* ¿Ese NUC ya está registrado? Una carpeta puede volver en otro lote o
       venir en varios tomos, así que se avisa sin impedirlo. */
    if (ruta === '/api/nuc' && req.method === 'GET') {
      const valor = texto(p.valor, 60).toUpperCase();
      if (!valor) return json(res, 200, []);
      return json(res, 200, db.prepare(`
        SELECT r.id, r.folio, r.estado, r.dependencia, d.caja, d.fojas FROM documentos d
          JOIN remisiones r ON r.id = d.remision_id
         WHERE d.nuc = ? AND r.eliminada_en = '' AND r.id <> ?
         ORDER BY r.fecha DESC LIMIT 10`).all(valor, entero(p.excluir, 0)));
    }

    /* ── usuarios del equipo ── */
    if (ruta === '/api/usuarios') {
      if (req.method === 'GET') return json(res, 200, listarPersonal(sedeDe(req)));
      if (req.method === 'POST') {
        if (!esSupervisor(req)) return json(res, 403, { errores: ['Solo un supervisor da de alta personas.'] });
        const cuerpo = await leerCuerpo(req);
        const nombre = texto(cuerpo.nombre, 120);
        const email = texto(cuerpo.email, 160).toLowerCase();
        const rol = ROLES.includes(texto(cuerpo.rol)) ? texto(cuerpo.rol) : 'Operador';

        if (accesoActivo() && !email) {
          return json(res, 400, { errores: ['Escribe el correo de Google de la persona.'] });
        }
        if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
          return json(res, 400, { errores: ['Ese correo no tiene un formato válido.'] });
        }
        if (!nombre && !email) return json(res, 400, { errores: ['Escribe el nombre de la persona.'] });
        if (email && db.prepare('SELECT 1 FROM usuarios WHERE lower(email) = ?').get(email)) {
          return json(res, 400, { errores: ['Ese correo ya está dado de alta.'] });
        }
        const lugar = lugarDePersona(cuerpo, rol);
        const permisos = limpiarPermisos(cuerpo.permisos);
        if (Array.isArray(cuerpo.permisos) && !permisos && !['Supervisor', 'Mesa'].includes(rol)) {
          return json(res, 400, { errores: ['Marca al menos una sección que pueda ver.'] });
        }
        db.prepare(`INSERT INTO usuarios (nombre, email, rol, cargo, telefono, creado_en, sede_id, mesa_id, permisos)
                    VALUES (?,?,?,?,?,?,?,?,?)`)
          .run(nombre || email, email, rol, texto(cuerpo.cargo, 120), texto(cuerpo.telefono, 40), ahora(),
               lugar.sede_id, lugar.mesa_id, permisos);
        registrarEvento(null, 'Personal', `Alta de ${nombre || email} · ${rol}`, usuarioDe(req));
        return json(res, 201, listarPersonal());
      }
    }

    const usuario = ruta.match(/^\/api\/usuarios\/(\d+)$/);
    if (usuario) {
      const id = Number(usuario[1]);
      if (!db.prepare('SELECT 1 FROM usuarios WHERE id = ?').get(id)) {
        return json(res, 404, { error: 'Persona no encontrada' });
      }
      if (req.method === 'PUT') {
        if (!esSupervisor(req)) return json(res, 403, { errores: ['Solo un supervisor edita personas.'] });
        const cuerpo = await leerCuerpo(req);
        const previa = db.prepare('SELECT * FROM usuarios WHERE id = ?').get(id);
        const rol = ROLES.includes(texto(cuerpo.rol)) ? texto(cuerpo.rol) : previa.rol;
        const nombre = texto(cuerpo.nombre, 120) || previa.nombre;
        const email = texto(cuerpo.email, 160).toLowerCase();

        if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
          return json(res, 400, { errores: ['Ese correo no tiene un formato válido.'] });
        }
        if (email && db.prepare('SELECT 1 FROM usuarios WHERE lower(email) = ? AND id <> ?').get(email, id)) {
          return json(res, 400, { errores: ['Ese correo ya está dado de alta.'] });
        }
        if (nombre !== previa.nombre &&
            db.prepare('SELECT 1 FROM usuarios WHERE nombre = ? AND id <> ?').get(nombre, id)) {
          return json(res, 400, { errores: ['Ya hay otra persona con ese nombre.'] });
        }

        const lugar = lugarDePersona({ sede_id: previa.sede_id, mesa_id: previa.mesa_id, ...cuerpo }, rol);
        const permisos = Array.isArray(cuerpo.permisos) ? limpiarPermisos(cuerpo.permisos) : previa.permisos;
        if (Array.isArray(cuerpo.permisos) && !permisos && !['Supervisor', 'Mesa'].includes(rol)) {
          return json(res, 400, { errores: ['Marca al menos una sección que pueda ver.'] });
        }
        db.prepare(`UPDATE usuarios SET nombre = ?, email = ?, rol = ?, cargo = ?, telefono = ?, activo = ?,
                     sede_id = ?, mesa_id = ?, permisos = ? WHERE id = ?`)
          .run(nombre, email, rol, texto(cuerpo.cargo, 120), texto(cuerpo.telefono, 40),
               cuerpo.activo === false ? 0 : 1, lugar.sede_id, lugar.mesa_id, permisos, id);
        const cambios = [
          previa.rol !== rol && `rol ${previa.rol} → ${rol}`,
          previa.sede_id !== lugar.sede_id && 'cambió de sede',
          previa.mesa_id !== lugar.mesa_id && 'cambió de mesa',
          previa.permisos !== permisos && `secciones: ${permisosDe({ rol, permisos }).join(', ')}`
        ].filter(Boolean);
        if (cambios.length) registrarEvento(null, 'Personal', `${nombre}: ${cambios.join(' · ')}`, usuarioDe(req));
        if (nombre !== previa.nombre) renombrarPersona(previa.nombre, nombre);
        return json(res, 200, listarPersonal());
      }
      if (req.method === 'DELETE') {
        if (!esSupervisor(req)) return json(res, 403, { errores: ['Solo un supervisor da de baja personas.'] });
        if (accesoActivo() && sesionDe(req)?.id === id) {
          return json(res, 400, { errores: ['No puedes darte de baja a ti mismo.'] });
        }
        // nadie se borra del padrón: se da de baja y su historial sigue a su nombre
        const persona = db.prepare('SELECT nombre, activo FROM usuarios WHERE id = ?').get(id);
        if (persona?.activo) {
          db.prepare('UPDATE usuarios SET activo = 0 WHERE id = ?').run(id);
          registrarEvento(null, 'Personal', `Baja de ${persona.nombre}`, usuarioDe(req));
        }
        return json(res, 200, listarPersonal());
      }
    }

    /* ── dependencias y sus enlaces ── */
    if (ruta === '/api/dependencias' && req.method === 'GET') {
      return json(res, 200, db.prepare(`
        SELECT d.*,
          (SELECT COUNT(*) FROM remisiones r WHERE r.dependencia = d.nombre) AS lotes
          FROM dependencias d ORDER BY d.nombre`).all());
    }
    const dependencia = ruta.match(/^\/api\/dependencias\/(\d+)$/);
    if (dependencia) {
      const id = Number(dependencia[1]);
      if (!db.prepare('SELECT 1 FROM dependencias WHERE id = ?').get(id)) {
        return json(res, 404, { error: 'Dependencia no encontrada' });
      }
      if (!esSupervisor(req)) {
        return json(res, 403, { errores: ['Solo un supervisor administra los enlaces.'] });
      }
      if (req.method === 'POST') return json(res, 200, regenerarLlave(id));
      if (req.method === 'PATCH') {
        const cuerpo = await leerCuerpo(req);
        db.prepare('UPDATE dependencias SET activo = ? WHERE id = ?')
          .run(cuerpo.activo === false ? 0 : 1, id);
        return json(res, 200, db.prepare('SELECT * FROM dependencias WHERE id = ?').get(id));
      }
    }

    /* ── actividad reciente de toda la operación ── */
    if (ruta === '/api/eventos' && req.method === 'GET') {
      const sedeId = sedeDe(req);
      return json(res, 200, db.prepare(`
        SELECT e.*, r.folio FROM eventos e
          LEFT JOIN remisiones r ON r.id = e.remision_id
         ${sedeId === null ? '' : `WHERE e.remision_id IN (${sqlVivas(sedeId)})`}
         ORDER BY e.fecha DESC, e.id DESC LIMIT ?`).all(Math.min(entero(p.limite, 0) || 40, 200)));
    }

    /* ── reporte por etapa de un periodo ── */
    if (ruta === '/api/reporte' && req.method === 'GET') {
      const { desde, hasta, desfase } = periodoDe(p);
      return json(res, 200, reportePeriodo(desde, hasta, desfase, sedeDe(req)));
    }

    /* ── trabajo pendiente de todas las mesas ── */
    if (ruta === '/api/digitalizacion' && req.method === 'GET') {
      return json(res, 200, trabajoDigitalizacion({ sedeId: sedeDe(req), mesaId: mesaDe(req) }));
    }

    /* ── sedes ── */
    if (ruta === '/api/sedes') {
      if (req.method === 'GET') return json(res, 200, db.prepare('SELECT * FROM sedes ORDER BY activa DESC, nombre').all());
      if (req.method === 'POST') {
        if (!esSupervisor(req)) return json(res, 403, { errores: ['Solo un supervisor da de alta sedes.'] });
        const cuerpo = await leerCuerpo(req);
        const nombre = texto(cuerpo.nombre, 80);
        if (!nombre) return json(res, 400, { errores: ['Escribe el nombre de la sede.'] });
        if (db.prepare('SELECT 1 FROM sedes WHERE nombre = ?').get(nombre)) {
          return json(res, 400, { errores: ['Ya existe una sede con ese nombre.'] });
        }
        db.prepare('INSERT INTO sedes (nombre, direccion, creado_en) VALUES (?,?,?)')
          .run(nombre, texto(cuerpo.direccion, 300), ahora());
        registrarEvento(null, 'Sede', `Alta de ${nombre}`, usuarioDe(req));
        return json(res, 201, db.prepare('SELECT * FROM sedes ORDER BY activa DESC, nombre').all());
      }
    }
    const sede = ruta.match(/^\/api\/sedes\/(\d+)$/);
    if (sede && req.method === 'PUT') {
      if (!esSupervisor(req)) return json(res, 403, { errores: ['Solo un supervisor edita sedes.'] });
      const id = Number(sede[1]);
      const previa = db.prepare('SELECT * FROM sedes WHERE id = ?').get(id);
      if (!previa) return json(res, 404, { error: 'Sede no encontrada' });
      const cuerpo = await leerCuerpo(req);
      const nombre = texto(cuerpo.nombre, 80) || previa.nombre;
      const activa = cuerpo.activa === false ? 0 : 1;
      if (!activa && db.prepare('SELECT 1 FROM documentos WHERE sede_id = ? AND recosido_en = \'\'').get(id)) {
        return json(res, 400, { errores: ['Esa sede tiene carpetas sin terminar: no se puede desactivar.'] });
      }
      db.prepare('UPDATE sedes SET nombre = ?, direccion = ?, activa = ? WHERE id = ?')
        .run(nombre, texto(cuerpo.direccion, 300), activa, id);
      registrarEvento(null, 'Sede', `${previa.nombre}: ${nombre !== previa.nombre ? `nombre → ${nombre}` : 'datos actualizados'}` +
        (previa.activa !== activa ? (activa ? ' · reactivada' : ' · desactivada') : ''), usuarioDe(req));
      return json(res, 200, db.prepare('SELECT * FROM sedes ORDER BY activa DESC, nombre').all());
    }

    /* ── traslados de cajas entre sedes ── */
    if (ruta === '/api/traslados') {
      if (req.method === 'GET') return json(res, 200, listarTraslados(sedeDe(req)));
      if (req.method === 'POST') {
        const id = crearTraslado(await leerCuerpo(req), usuarioDe(req), sedeDe(req));
        return json(res, 201, { id });
      }
    }
    const recepcionTraslado = ruta.match(/^\/api\/traslados\/(\d+)\/recepcion$/);
    if (recepcionTraslado && req.method === 'PUT') {
      recibirTraslado(Number(recepcionTraslado[1]), await leerCuerpo(req), usuarioDe(req), sedeDe(req));
      return json(res, 200, { ok: true });
    }

    /* ── mesas de digitalización ── */
    if (ruta === '/api/mesas') {
      if (req.method === 'GET') {
        const sedeId = sedeDe(req);
        return json(res, 200, listarMesas().filter((m) => sedeId === null || m.sede_id === sedeId));
      }
      if (req.method === 'POST') {
        if (!esSupervisor(req)) return json(res, 403, { errores: ['Solo un supervisor administra las mesas.'] });
        return json(res, 201, guardarMesa(null, await leerCuerpo(req), usuarioDe(req)));
      }
    }
    const mesa = ruta.match(/^\/api\/mesas\/(\d+)$/);
    if (mesa && req.method === 'PUT') {
      if (!esSupervisor(req)) return json(res, 403, { errores: ['Solo un supervisor administra las mesas.'] });
      return json(res, 200, guardarMesa(Number(mesa[1]), await leerCuerpo(req), usuarioDe(req)));
    }

    /* ── expediente digital: el PDF de cada carpeta ── */
    const subida = ruta.match(/^\/api\/remisiones\/(\d+)\/carpetas\/(\d+)\/archivo$/);
    if (subida && req.method === 'POST') {
      const r = obtenerRemision(Number(subida[1]));
      const d = r?.documentos.find((x) => x.id === Number(subida[2]));
      if (!d) { req.resume(); return json(res, 404, { error: 'Carpeta no encontrada' }); }
      if (mesaDe(req) !== null && d.mesa_id !== mesaDe(req)
          && r.asignaciones.filter((a) => a.documento_id === d.id).at(-1)?.mesa_id !== mesaDe(req)) {
        req.resume();
        return json(res, 403, { errores: ['Esa carpeta no es de tu mesa.'] });
      }
      if (sedeDe(req) !== null && d.sede_id !== sedeDe(req)) {
        req.resume();
        return json(res, 403, { errores: [`Esa carpeta está en ${d.sede}: su PDF lo sube esa sede.`] });
      }
      await guardarArchivo(req, r, d, { usuario: usuarioDe(req), nombre: texto(p.nombre, 200), motivo: texto(p.motivo, 500) });
      return json(res, 201, obtenerRemision(r.id));
    }
    const archivo = ruta.match(/^\/api\/archivos\/(\d+)(\/verificacion)?$/);
    if (archivo && req.method === 'GET') {
      const a = abrirArchivo(archivo[1]);
      if (!a || !puedeVer(req, a.remision_id)) return json(res, 404, { error: 'Archivo no encontrado' });
      if (mesaDe(req) !== null) {
        const ultima = db.prepare('SELECT mesa_id FROM asignaciones WHERE documento_id = ? ORDER BY id DESC LIMIT 1').get(a.documento_id);
        if (ultima?.mesa_id !== mesaDe(req)) return json(res, 403, { errores: ['Ese PDF no es de tu mesa.'] });
      }
      if (archivo[2]) {
        if (!esSupervisor(req)) return json(res, 403, { errores: ['Solo un supervisor verifica la integridad.'] });
        const v = verificarArchivo(a.id);
        registrarEvento(a.remision_id, 'Expediente digital',
          `Verificación de integridad · ${a.ruta} · ${v.ok ? 'correcta' : `FALLA: ${v.motivo}`}`, usuarioDe(req));
        return json(res, 200, v);
      }
      if (a.falta) return json(res, 410, { error: 'El PDF no está en el almacenamiento. Revisa la conexión con la NAS.' });
      // cada consulta de un expediente queda registrada
      registrarEvento(a.remision_id, 'Consulta', `Abrió el PDF ${a.ruta}${a.vigente ? '' : ' (versión anterior)'}`, usuarioDe(req));
      res.writeHead(200, {
        'Content-Type': 'application/pdf',
        'Content-Length': a.tamano_actual,
        'Content-Disposition': `inline; filename="${a.ruta.split(/[\\/]/).pop()}"`,
        'Cache-Control': 'no-store'
      });
      return a.flujo().pipe(res);
    }

    /* ── custodia de cada carpeta: preparación, mesa, escaneo y recosido ── */
    const paso = ruta.match(/^\/api\/remisiones\/(\d+)\/carpetas\/(\d+)\/(preparacion|escaneo|recosido)$/);
    if (paso && req.method === 'POST') {
      const r = obtenerRemision(Number(paso[1]));
      if (!r) return json(res, 404, { error: 'Remisión no encontrada' });
      const accion = { preparacion: prepararCarpeta, escaneo: registrarEscaneo, recosido: recoserCarpeta }[paso[3]];
      const carpeta = r.documentos.find((d) => d.id === Number(paso[2]));
      if (mesaDe(req) !== null && carpeta?.mesa_id !== mesaDe(req)) {
        return json(res, 403, { errores: ['Esa carpeta no está en tu mesa.'] });
      }
      // una carpeta solo la trabaja la sede donde está físicamente
      if (sedeDe(req) !== null && carpeta && carpeta.sede_id !== sedeDe(req)) {
        return json(res, 403, { errores: [`Esa carpeta está en ${carpeta.sede}: la trabaja esa sede.`] });
      }
      accion(r, Number(paso[2]), await leerCuerpo(req), usuarioDe(req));
      return json(res, 200, obtenerRemision(r.id));
    }
    const aMesa = ruta.match(/^\/api\/remisiones\/(\d+)\/mesa$/);
    if (aMesa && req.method === 'POST') {
      const r = obtenerRemision(Number(aMesa[1]));
      if (!r) return json(res, 404, { error: 'Remisión no encontrada' });
      const cuerpo = await leerCuerpo(req);
      const ajenas = r.documentos.filter((d) => (cuerpo.documentos || []).map(Number).includes(d.id)
        && sedeDe(req) !== null && d.sede_id !== sedeDe(req));
      if (ajenas.length) {
        return json(res, 403, { errores: [`Esas carpetas están en ${ajenas[0].sede}: las asigna esa sede.`] });
      }
      enviarAMesa(r, cuerpo.documentos, cuerpo.mesa, usuarioDe(req));
      return json(res, 200, obtenerRemision(r.id));
    }

    /* ── cancelación y solicitudes (sustituyen a cualquier borrado) ── */
    const cancelar = ruta.match(/^\/api\/remisiones\/(\d+)\/cancelacion$/);
    if (cancelar && req.method === 'POST') {
      if (!['Supervisor', 'Recepción'].includes(rolDe(req))) {
        return json(res, 403, { errores: ['Solo recepción o un supervisor cancelan una recepción.'] });
      }
      const r = obtenerRemision(Number(cancelar[1]));
      if (!r) return json(res, 404, { error: 'Remisión no encontrada' });
      cancelarRemision(r, (await leerCuerpo(req)).motivo, usuarioDe(req));
      return json(res, 200, obtenerRemision(r.id));
    }
    const solicitar = ruta.match(/^\/api\/remisiones\/(\d+)\/solicitudes$/);
    if (solicitar && req.method === 'POST') {
      const r = obtenerRemision(Number(solicitar[1]));
      if (!r) return json(res, 404, { error: 'Remisión no encontrada' });
      crearSolicitud(r, await leerCuerpo(req), usuarioDe(req));
      return json(res, 201, obtenerRemision(r.id));
    }
    if (ruta === '/api/solicitudes' && req.method === 'GET') {
      return json(res, 200, esSupervisor(req) ? solicitudesPendientes() : []);
    }
    const resolver = ruta.match(/^\/api\/solicitudes\/(\d+)$/);
    if (resolver && req.method === 'PUT') {
      if (!esSupervisor(req)) return json(res, 403, { errores: ['Solo un supervisor resuelve solicitudes.'] });
      const remisionId = resolverSolicitud(Number(resolver[1]), await leerCuerpo(req), usuarioDe(req));
      return json(res, 200, obtenerRemision(remisionId));
    }

    /* ── incidencias del servicio ── */
    const incidencias = ruta.match(/^\/api\/remisiones\/(\d+)\/incidencias$/);
    if (incidencias && req.method === 'POST') {
      const id = Number(incidencias[1]);
      const r = obtenerRemision(id);
      if (!r) return json(res, 404, { error: 'Remisión no encontrada' });
      if (r.eliminada_en) return json(res, 400, { errores: ['Esta remisión fue eliminada.'] });
      const cuerpo = await leerCuerpo(req);
      const tipo = TIPOS_INCIDENCIA.includes(texto(cuerpo.tipo)) ? texto(cuerpo.tipo) : 'Otra';
      const gravedad = GRAVEDADES.includes(texto(cuerpo.gravedad)) ? texto(cuerpo.gravedad) : 'Media';
      const descripcion = texto(cuerpo.descripcion, 2000);
      if (!descripcion) return json(res, 400, { errores: ['Describe la incidencia.'] });
      db.prepare(`INSERT INTO incidencias
        (remision_id, tipo, gravedad, descripcion, reportada_por, reportada_en)
        VALUES (?,?,?,?,?,?)`)
        .run(id, tipo, gravedad, descripcion, usuarioDe(req), ahora());
      registrarEvento(id, 'Incidencia', `${tipo} · gravedad ${gravedad.toLowerCase()} · ${descripcion}`, usuarioDe(req));
      return json(res, 201, obtenerRemision(id));
    }

    const incidencia = ruta.match(/^\/api\/incidencias\/(\d+)$/);
    if (incidencia && req.method === 'PATCH') {
      const id = Number(incidencia[1]);
      const fila = db.prepare('SELECT * FROM incidencias WHERE id = ?').get(id);
      if (!fila) return json(res, 404, { error: 'Incidencia no encontrada' });
      if (fila.anulada_en) return json(res, 400, { errores: ['Esa incidencia está anulada.'] });
      const cuerpo = await leerCuerpo(req);

      // una incidencia no se borra: se anula, con motivo y a nombre de quien lo hace
      if (cuerpo.anular === true) {
        const motivo = texto(cuerpo.motivo, 1000);
        if (motivo.length < 10) return json(res, 400, { errores: ['Explica por qué se anula (al menos 10 caracteres).'] });
        db.prepare('UPDATE incidencias SET anulada_por = ?, anulada_en = ?, anulacion_motivo = ? WHERE id = ?')
          .run(usuarioDe(req), ahora(), motivo, id);
        registrarEvento(fila.remision_id, 'Incidencia', `Anulada · ${fila.tipo} · ${motivo}`, usuarioDe(req));
        return json(res, 200, obtenerRemision(fila.remision_id));
      }

      const resolucion = texto(cuerpo.resolucion, 2000);
      if (!resolucion) return json(res, 400, { errores: ['Escribe cómo se resolvió.'] });
      if (fila.estado !== 'Abierta') return json(res, 400, { errores: ['Esa incidencia ya está resuelta.'] });
      db.prepare(`UPDATE incidencias SET estado='Resuelta', resolucion=?, resuelta_por=?, resuelta_en=?
                   WHERE id = ?`)
        .run(resolucion, usuarioDe(req), ahora(), id);
      registrarEvento(fila.remision_id, 'Incidencia', `Resuelta · ${fila.tipo} · ${resolucion}`, usuarioDe(req));
      return json(res, 200, obtenerRemision(fila.remision_id));
    }

    /* ── validación de la recepción y cotejo de la devolución ── */
    const cotejo = ruta.match(/^\/api\/remisiones\/(\d+)\/(validacion|cotejo)$/);
    if (cotejo && req.method === 'PUT') {
      const id = Number(cotejo[1]);
      const esValidacion = cotejo[2] === 'validacion';
      const r = obtenerRemision(id);
      if (!r) return json(res, 404, { error: 'Remisión no encontrada' });
      if (bloqueada(r)) return json(res, 400, { errores: ['Esta remisión está cancelada o eliminada.'] });
      if (esValidacion && iniciada(r)) {
        return json(res, 400, { errores: ['Las carpetas ya entraron a digitalización: la validación quedó cerrada.'] });
      }
      if (!esValidacion && r.documentos.some((d) => d.etapa !== 'Recosida')) {
        return json(res, 400, { errores: ['Todas las carpetas tienen que estar recosidas y verificadas antes de cotejar la devolución.'] });
      }

      const cuerpo = await leerCuerpo(req);
      const campos = CAMPOS_COTEJO[cotejo[2]];

      // se comprueba sobre el resultado propuesto: nada se guarda si no procede
      const proyectados = proyectarCotejo(r.documentos, cuerpo.documentos, campos);
      const resumen = diferencias(proyectados, campos);
      const notas = texto(cuerpo.notas, 2000);
      const hayDiferencia = resumen.documentos !== 0 || resumen.fojas !== 0 || resumen.cambios !== 0;

      if (resumen.completo && hayDiferencia && !notas) {
        return json(res, 400, {
          errores: [resumen.cambios
            ? 'Hay carpetas que no salen en la misma situación en que se recibieron: explica a qué se debe antes de guardar.'
            : 'Hay diferencias contra lo asentado: explica a qué se deben antes de guardar.']
        });
      }

      guardarCotejo(id, proyectados, campos);

      const quien = usuarioDe(req);
      if (esValidacion) {
        db.prepare(`UPDATE remisiones SET validada_por = ?, validada_en = ?, validacion_notas = ?,
                     actualizado_en = ? WHERE id = ?`)
          .run(quien, resumen.completo ? ahora() : '', notas, ahora(), id);
      } else {
        db.prepare(`UPDATE remisiones SET cotejo_por = ?, cotejo_en = ?, cotejo_notas = ?,
                     actualizado_en = ? WHERE id = ?`)
          .run(quien, resumen.completo ? ahora() : '', notas, ahora(), id);
      }

      const conSigno = (v) => `${v > 0 ? '+' : ''}${v}`;
      const detalle = [
        resumen.documentos || resumen.fojas
          ? `${conSigno(resumen.documentos)} carpetas · ${conSigno(resumen.fojas)} fojas` : '',
        resumen.cambios ? `${resumen.cambios} con cambio de situación` : ''
      ].filter(Boolean).join(' · ') || 'sin diferencias';
      registrarEvento(id, esValidacion ? 'Validación' : 'Cotejo',
        `${resumen.revisadas} de ${resumen.total} carpetas · ${detalle}${notas ? ` · ${notas}` : ''}`, quien);

      return json(res, 200, obtenerRemision(id));
    }

    /* ── devolución y punto de aceptación ── */
    const devFirma = ruta.match(/^\/api\/remisiones\/(\d+)\/devolucion\/firma$/);
    if (devFirma && req.method === 'POST') {
      const id = Number(devFirma[1]);
      const r = obtenerRemision(id);
      if (!r) return json(res, 404, { error: 'Remisión no encontrada' });
      if (!r.dev_fecha) return json(res, 400, { errores: ['Primero registra los datos de la devolución.'] });
      if (!r.cotejo_en) {
        return json(res, 400, {
          errores: ['Antes de firmar hay que cotejar la devolución contra lo recibido, carpeta por carpeta.']
        });
      }
      const cuerpo = await leerCuerpo(req);
      const entrega = imagenFirma(cuerpo.firma_entrega);
      const recibe = imagenFirma(cuerpo.firma_recibe);
      if (!entrega && !recibe) return json(res, 400, { errores: ['No se recibió ninguna firma.'] });
      db.prepare(`UPDATE remisiones SET dev_firma_entrega=?, dev_firma_recibe=?, dev_firmado_en=?,
                   actualizado_en=? WHERE id=?`).run(entrega, recibe, ahora(), ahora(), id);
      registrarEvento(id, 'Firma', 'Acuse de devolución firmado', usuarioDe(req));
      return json(res, 200, obtenerRemision(id));
    }

    const devolucion = ruta.match(/^\/api\/remisiones\/(\d+)\/devolucion$/);
    if (devolucion) {
      const id = Number(devolucion[1]);
      const r = obtenerRemision(id);
      if (!r) return json(res, 404, { error: 'Remisión no encontrada' });
      if (bloqueada(r)) return json(res, 400, { errores: ['Esta remisión está cancelada o eliminada.'] });

      if (req.method === 'PUT') {
        if (r.documentos.some((d) => d.en_transito)) {
          return json(res, 400, { errores: ['Hay cajas en tránsito: hay que recibirlas antes de devolver el lote.'] });
        }
        const sedesDelLote = new Set(r.documentos.map((d) => d.sede));
        if (sedesDelLote.size > 1) {
          return json(res, 400, { errores: [`Las cajas están en sedes distintas (${[...sedesDelLote].join(', ')}): ` +
            'trasládalas a una sola sede antes de devolver el lote.'] });
        }
        // no sale nada que no haya terminado su tratamiento completo
        const pendientes = r.documentos.filter((d) => d.etapa !== 'Recosida');
        if (pendientes.length) {
          return json(res, 400, { errores: [
            `Faltan ${pendientes.length} carpeta${pendientes.length === 1 ? '' : 's'} por terminar (recoser y verificar): ` +
            pendientes.slice(0, 5).map(nombreCarpeta).join('; ') + (pendientes.length > 5 ? '…' : '')
          ] });
        }
        if (r.dev_firmado_en) {
          return json(res, 400, { errores: ['El acuse de devolución ya está firmado: los datos quedaron cerrados.'] });
        }
        const { errores, valor } = validarDevolucion(await leerCuerpo(req));
        if (errores.length) return json(res, 400, { errores });
        db.prepare(`UPDATE remisiones SET dev_fecha=?, dev_entrega_nombre=?, dev_entrega_cargo=?,
                     dev_recibe_nombre=?, dev_recibe_cargo=?, dev_medio=?, dev_archivos=?,
                     dev_aceptacion=?, dev_observaciones=?,
                     dev_firma_entrega='', dev_firma_recibe='', dev_firmado_en='', actualizado_en=?
                    WHERE id=?`)
          .run(valor.dev_fecha, valor.dev_entrega_nombre, valor.dev_entrega_cargo,
               valor.dev_recibe_nombre, valor.dev_recibe_cargo, valor.dev_medio, valor.dev_archivos,
               valor.dev_aceptacion, valor.dev_observaciones, ahora(), id);
        registrarEvento(id, 'Devolución', `${valor.dev_aceptacion} · ${valor.dev_recibe_nombre}`, usuarioDe(req));
        // si la dependencia rechaza la entrega, las carpetas siguen en nuestro poder
        if (valor.dev_aceptacion === 'Rechazado') {
          const actual = db.prepare('SELECT estado FROM remisiones WHERE id = ?').get(id).estado;
          if (actual === 'Devuelto') {
            db.prepare('UPDATE remisiones SET estado = ? WHERE id = ?').run('Digitalizado', id);
            registrarEvento(id, 'Estado', 'Devuelto → Digitalizado (entrega rechazada)', usuarioDe(req));
          }
        } else {
          avanzarEstado(id, 'Devuelto', usuarioDe(req));
        }
        return json(res, 200, obtenerRemision(id));
      }
      if (req.method === 'DELETE') {
        if (!esSupervisor(req)) return json(res, 403, { errores: ['Solo un supervisor cancela una devolución.'] });
        const previo = db.prepare('SELECT estado FROM remisiones WHERE id = ?').get(id).estado;
        db.prepare(`UPDATE remisiones SET dev_fecha='', dev_entrega_nombre='', dev_entrega_cargo='',
                     dev_recibe_nombre='', dev_recibe_cargo='', dev_medio='', dev_archivos=0,
                     dev_aceptacion='', dev_observaciones='', dev_firma_entrega='', dev_firma_recibe='',
                     dev_firmado_en='', actualizado_en=? WHERE id=?`).run(ahora(), id);

        // el lote vuelve a estar en nuestro poder: no puede seguir «Devuelto»
        if (previo === 'Devuelto') {
          const regresa = estadoSegunAvance(id);
          db.prepare('UPDATE remisiones SET estado = ? WHERE id = ?').run(regresa, id);
          registrarEvento(id, 'Estado', `${previo} → ${regresa}`, usuarioDe(req));
        }
        registrarEvento(id, 'Devolución',
          `Devolución cancelada (antes: ${r.dev_aceptacion} · ${r.dev_recibe_nombre} · ${r.dev_fecha})`, usuarioDe(req));
        return json(res, 200, obtenerRemision(id));
      }
    }

    const firma = ruta.match(/^\/api\/remisiones\/(\d+)\/firma$/);
    if (firma && req.method === 'POST') {
      const id = Number(firma[1]);
      const r = obtenerRemision(id);
      if (!r) return json(res, 404, { error: 'Remisión no encontrada' });
      if (bloqueada(r)) return json(res, 400, { errores: ['Esta remisión está cancelada o eliminada.'] });
      if (r.firmado_en) return json(res, 400, { errores: ['El acuse ya está firmado. Para cambiarlo, solicita una corrección.'] });
      const cuerpo = await leerCuerpo(req);
      const entrega = imagenFirma(cuerpo.firma_entrega);
      const recibe = imagenFirma(cuerpo.firma_recibe);
      if (!entrega && !recibe) return json(res, 400, { errores: ['No se recibió ninguna firma.'] });
      db.prepare('UPDATE remisiones SET firma_entrega=?, firma_recibe=?, firmado_en=?, actualizado_en=? WHERE id=?')
        .run(entrega, recibe, ahora(), ahora(), id);
      registrarEvento(id, 'Firma', 'Acuse de recepción firmado', usuarioDe(req));
      return json(res, 200, obtenerRemision(id));
    }

    const m = ruta.match(/^\/api\/remisiones\/(\d+)$/);
    if (m) {
      const id = Number(m[1]);
      const previa = obtenerRemision(id);
      if (!previa) return json(res, 404, { error: 'Remisión no encontrada' });

      if (req.method === 'GET') {
        if (previa.eliminada_en && !esSupervisor(req)) return json(res, 404, { error: 'Remisión no encontrada' });
        return json(res, 200, previa);
      }
      if (req.method === 'PUT') {
        const motivos = {
          bloqueada: 'Esta remisión está cancelada o eliminada; solo se puede consultar.',
          en_proceso: 'Las carpetas ya entraron a digitalización: los datos de la recepción no se modifican. Registra una incidencia.',
          requiere_solicitud: 'La recepción ya está validada o firmada: para corregirla, solicita una corrección a un supervisor.'
        };
        if (motivos[previa.edicion]) return json(res, 400, { errores: [motivos[previa.edicion]] });

        const { errores, valor } = validarRemision(await leerCuerpo(req));
        if (errores.length) return json(res, 400, { errores });
        const cambios = describirCambios(previa, valor);
        if (!cambios.length) return json(res, 200, previa);

        const autorizada = previa.edicion === 'autorizada';
        actualizarRemision(previa, valor, autorizada);
        if (autorizada) consumirCorreccion(previa, usuarioDe(req));
        registrarEvento(id, 'Edición', cambios.join(' · ') +
          (autorizada ? ' · se anularon firmas y validación: hay que volver a hacerlas' : ''), usuarioDe(req));
        return json(res, 200, obtenerRemision(id));
      }
    }

    return json(res, 404, { error: 'Ruta no encontrada' });
  } catch (e) {
    // una regla del proceso no se cumplió: se explica a quien lo intentó
    if (e instanceof ErrorRegla || e instanceof ErrorArchivo) return json(res, 400, { errores: [e.message] });
    console.error(e);
    return json(res, 500, { error: e.message || 'Error interno' });
  }
};

const servidor = TLS ? createServerTLS(TLS, atender) : createServer(atender);

function direccionesDeRed() {
  const salida = [];
  for (const interfaces of Object.values(networkInterfaces())) {
    for (const i of interfaces || []) {
      if (i.family === 'IPv4' && !i.internal) salida.push(i.address);
    }
  }
  return salida;
}

// escucha en todas las interfaces para que otros equipos de la red puedan entrar
servidor.listen(PORT, '0.0.0.0', () => {
  const esquema = TLS ? 'https' : 'http';
  console.log(`\n  Bitácora de digitalización  ·  este equipo:  ${esquema}://localhost:${PORT}`);
  for (const ip of direccionesDeRed()) {
    console.log(`                        ·  en la red:    ${esquema}://${ip}:${PORT}`);
  }
  const comoSeEntra = ssoActivo()
    ? `Google · redirección ${baseUrl({ headers: {} })}/auth/google/callback`
    : pruebaActiva()
      ? 'cuentas de prueba (Google todavía no configurado)'
      : 'SIN CONFIGURAR';
  console.log(`                        ·  acceso:       ${comoSeEntra}`);
  console.log(`                        ·  expedientes:  ${CARPETA_ARCHIVO}${almacenamientoDisponible() ? '' : '  ⚠ NO DISPONIBLE'}`);
  if (!accesoActivo()) {
    console.log('\n  ⚠  El sistema no atiende a nadie hasta configurar el acceso con Google');
    console.log('     (GOOGLE_CLIENT_ID y GOOGLE_CLIENT_SECRET): cada registro tiene que quedar');
    console.log('     a nombre de una persona verificada. Para conocerlo: npm run prueba');
  }
  if (pruebaActiva()) {
    sembrarPrueba();
    console.log('\n  ⚠  ENTRADA DE PRUEBA ENCENDIDA: se puede entrar sin Google con cuentas');
    console.log('     @prueba.local. Es para conocer el sistema; apágala quitando');
    console.log('     BITACORA_ACCESO_PRUEBA antes de usarlo con documentos reales.');
  }
  programarRespaldos();
  console.log('');
});

/* Cierre ordenado: los servicios de hospedaje mandan SIGTERM en cada
   despliegue, y la base debe cerrarse antes de que muera el proceso. */
for (const senal of ['SIGTERM', 'SIGINT']) {
  process.on(senal, () => {
    console.log(`\n  ${senal} · cerrando`);
    servidor.close(() => {
      try { db.close(); } catch { /* ya estaba cerrada */ }
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
