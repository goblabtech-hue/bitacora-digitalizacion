import { createServer } from 'node:http';
import { createServer as createServerTLS } from 'node:https';
import { readFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  db, ESTADOS, SITUACIONES, ROLES, TIPOS_INCIDENCIA, GRAVEDADES, MEDIOS_ENTREGA,
  ACEPTACIONES, nuevoFolio, leerConfig, guardarConfig, registrarEvento, renombrarPersona,
  asegurarDependencia, dependenciaPorLlave, regenerarLlave
} from './db.js';
import { crearRespaldo, listarRespaldos, programarRespaldos, rutaRespaldo, createReadStream } from './respaldo.js';
import {
  ssoActivo, pruebaActiva, accesoActivo, iniciar, regresar, sesionDe, salir, baseUrl,
  sembrarPrueba, usuariosPrueba, entrarPrueba, esCuentaPrueba
} from './auth.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, 'public');
const PORT = Number(process.env.PORT) || 4321;

/* Logotipo de la organización: basta con dejar el archivo en public/. */
const buscarLogo = (nombres) => {
  const archivo = nombres.find((n) => existsSync(join(PUBLIC_DIR, n)));
  return archivo ? `/${archivo}` : '';
};
const logoUrl = buscarLogo(['logo.svg', 'logo.png', 'logo.jpg']);
// versión de sólo símbolo, para la barra lateral y el membrete impreso
const logoMarcaUrl = buscarLogo(['logo-marca.svg', 'logo-marca.png', 'logo-marca.jpg']) || logoUrl;

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
/** Quién realiza la acción: la sesión de Google si el acceso está activo,
 *  o el nombre declarado desde el equipo cuando se trabaja en modo local. */
const usuarioDe = (req) => {
  if (accesoActivo()) return sesionDe(req)?.nombre || '';
  try { return decodeURIComponent(req.headers['x-usuario'] || '').trim().slice(0, 120); }
  catch { return ''; }
};

const esSupervisor = (req) => !accesoActivo() || sesionDe(req)?.rol === 'Supervisor';
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

  const documentos = Array.isArray(datos.documentos) ? datos.documentos : [];
  const limpios = documentos
    .map((d, i) => ({
      orden: i,
      descripcion: texto(d.descripcion, 400),
      tipo: texto(d.tipo, 120),
      cantidad: entero(d.cantidad, 0),
      fojas: entero(d.fojas, 0),
      situacion: texto(d.situacion, 120) || 'Buen estado',
      observaciones: texto(d.observaciones, 600)
    }))
    .filter((d) => d.descripcion || d.cantidad || d.fojas);

  if (limpios.length === 0) errores.push('Registra al menos un lote de documentos.');
  limpios.forEach((d, i) => {
    if (!d.descripcion) errores.push(`Describe el documento de la partida ${i + 1}.`);
    if (d.cantidad < 1) errores.push(`La cantidad de la partida ${i + 1} debe ser mayor a 0.`);
  });

  const estado = ESTADOS.includes(texto(datos.estado)) ? texto(datos.estado) : 'Recibido';

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
      estado,
      cajas: entero(datos.cajas, 0),
      carpetas: entero(datos.carpetas, 0),
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
  (SELECT COALESCE(SUM(c.imagenes), 0) FROM capturas c   WHERE c.remision_id = r.id) AS total_imagenes,
  (SELECT COUNT(*) FROM capturas c   WHERE c.remision_id = r.id AND c.fin = '')             AS capturas_abiertas,
  (SELECT COUNT(*) FROM incidencias i WHERE i.remision_id = r.id AND i.estado = 'Abierta')  AS incidencias_abiertas`;

function listarRemisiones({ q = '', estado = '', desde = '', hasta = '', dependencia = '' }) {
  const filtros = [];
  const params = [];

  if (q) {
    filtros.push(`(r.folio LIKE ? OR r.dependencia LIKE ? OR r.area LIKE ?
      OR r.entrega_nombre LIKE ? OR r.recibe_nombre LIKE ?
      OR EXISTS (SELECT 1 FROM documentos d WHERE d.remision_id = r.id AND d.descripcion LIKE ?))`);
    const like = `%${q}%`;
    params.push(like, like, like, like, like, like);
  }
  if (estado) { filtros.push('r.estado = ?'); params.push(estado); }
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
  remision.capturas = db
    .prepare('SELECT * FROM capturas WHERE remision_id = ? ORDER BY inicio, id')
    .all(id);
  remision.incidencias = db
    .prepare('SELECT * FROM incidencias WHERE remision_id = ? ORDER BY reportada_en DESC, id DESC')
    .all(id);
  remision.eventos = db
    .prepare('SELECT * FROM eventos WHERE remision_id = ? ORDER BY fecha DESC, id DESC LIMIT 200')
    .all(id);
  remision.validacion = diferencias(remision.documentos, 'cantidad_verificada', 'fojas_verificadas');
  remision.cotejo = diferencias(remision.documentos, 'cantidad_devuelta', 'fojas_devueltas');
  return remision;
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
          creado_en, actualizado_en)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(folio, v.fecha, v.hora, v.dependencia, v.area, v.entrega_nombre,
           v.entrega_cargo, v.recibe_nombre, v.recibe_cargo, v.estado, v.cajas,
           v.carpetas, v.observaciones, t, t);

    const insDoc = db.prepare(
      `INSERT INTO documentos (remision_id, orden, descripcion, tipo, cantidad, fojas, situacion, observaciones)
       VALUES (?,?,?,?,?,?,?,?)`
    );
    for (const d of v.documentos) {
      insDoc.run(lastInsertRowid, d.orden, d.descripcion, d.tipo, d.cantidad, d.fojas, d.situacion, d.observaciones);
    }
    db.exec('COMMIT');
    return Number(lastInsertRowid);
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

function actualizarRemision(id, v) {
  db.exec('BEGIN');
  try {
    asegurarDependencia(v.dependencia);
    // al modificar una remisión las firmas dejan de corresponder al acuse: se anulan
    db.prepare(
      `UPDATE remisiones SET fecha=?, hora=?, dependencia=?, area=?, entrega_nombre=?,
        entrega_cargo=?, recibe_nombre=?, recibe_cargo=?, estado=?, cajas=?, carpetas=?,
        observaciones=?, firma_entrega='', firma_recibe='', firmado_en='', actualizado_en=?
       WHERE id=?`
    ).run(v.fecha, v.hora, v.dependencia, v.area, v.entrega_nombre, v.entrega_cargo,
          v.recibe_nombre, v.recibe_cargo, v.estado, v.cajas, v.carpetas, v.observaciones,
          ahora(), id);

    db.prepare('DELETE FROM documentos WHERE remision_id = ?').run(id);
    const insDoc = db.prepare(
      `INSERT INTO documentos (remision_id, orden, descripcion, tipo, cantidad, fojas, situacion, observaciones)
       VALUES (?,?,?,?,?,?,?,?)`
    );
    for (const d of v.documentos) {
      insDoc.run(id, d.orden, d.descripcion, d.tipo, d.cantidad, d.fojas, d.situacion, d.observaciones);
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

/** Estado que le corresponde a un lote según su avance real de captura.
 *  Sirve para regresarlo a resguardo si se cancela la devolución. */
function estadoSegunAvance(id) {
  const c = db.prepare(`SELECT COUNT(*) AS total,
                          SUM(CASE WHEN fin = '' THEN 1 ELSE 0 END) AS abiertas
                          FROM capturas WHERE remision_id = ?`).get(id);
  if (!c.total) return 'Recibido';
  return c.abiertas > 0 ? 'En digitalización' : 'Digitalizado';
}

/** Diferencias entre lo asentado y lo verificado o devuelto. */
function diferencias(documentos, campoCantidad, campoFojas) {
  const revisados = documentos.filter((d) => d[campoCantidad] !== null && d[campoCantidad] !== undefined);
  return {
    revisadas: revisados.length,
    total: documentos.length,
    completo: revisados.length === documentos.length,
    documentos: revisados.reduce((a, d) => a + (d[campoCantidad] - d.cantidad), 0),
    fojas: revisados.reduce((a, d) => a + ((d[campoFojas] ?? d.fojas) - d.fojas), 0)
  };
}

/** Aplica lo capturado sobre las partidas, sin escribir todavía. */
function proyectarCotejo(documentos, partidas, [campoCantidad, campoFojas]) {
  const capturado = new Map(
    (Array.isArray(partidas) ? partidas : []).map((p) => [Number(p.id), p]));
  return documentos.map((d) => {
    const p = capturado.get(d.id);
    return p
      ? { ...d, [campoCantidad]: entero(p.cantidad, 0), [campoFojas]: entero(p.fojas, 0) }
      : d;
  });
}

/** Escribe el cotejo ya validado. */
function guardarCotejo(id, proyectados, [campoCantidad, campoFojas]) {
  db.exec('BEGIN');
  try {
    const stmt = db.prepare(
      `UPDATE documentos SET ${campoCantidad} = ?, ${campoFojas} = ? WHERE id = ? AND remision_id = ?`);
    for (const d of proyectados) {
      if (d[campoCantidad] === null || d[campoCantidad] === undefined) continue;
      stmt.run(d[campoCantidad], d[campoFojas], d.id, id);
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
function listarPersonal() {
  return db.prepare(`
    SELECT u.*,
      (SELECT COUNT(*) FROM remisiones r WHERE r.recibe_nombre = u.nombre)              AS recepciones,
      (SELECT COUNT(*) FROM capturas   c WHERE c.operador = u.nombre)                   AS sesiones,
      (SELECT COALESCE(SUM(c.imagenes), 0) FROM capturas c WHERE c.operador = u.nombre) AS imagenes,
      (SELECT MAX(e.fecha) FROM eventos e WHERE e.usuario = u.nombre)                   AS ultima_actividad
      FROM usuarios u
     ORDER BY u.activo DESC, u.nombre`).all();
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
     WHERE r.dependencia = ?
     ORDER BY r.fecha DESC, r.id DESC`).all(dependencia.nombre);

  const partidas = db.prepare(`
    SELECT d.remision_id, d.descripcion, d.tipo, d.cantidad, d.fojas, d.situacion
      FROM documentos d
      JOIN remisiones r ON r.id = d.remision_id
     WHERE r.dependencia = ?
     ORDER BY d.orden, d.id`).all(dependencia.nombre);

  const incidencias = db.prepare(`
    SELECT i.remision_id, i.tipo, i.gravedad, i.estado, i.descripcion, i.reportada_en
      FROM incidencias i
      JOIN remisiones r ON r.id = i.remision_id
     WHERE r.dependencia = ?
     ORDER BY i.reportada_en DESC`).all(dependencia.nombre);

  for (const lote of lotes) {
    lote.documentos = partidas.filter((p) => p.remision_id === lote.id);
    lote.incidencias = incidencias.filter((i) => i.remision_id === lote.id);
    delete lote.id;
    lote.documentos.forEach((p) => delete p.remision_id);
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

function estadisticas() {
  const hoy = new Date().toISOString().slice(0, 10);
  const g = db.prepare(`
    SELECT COUNT(*) AS remisiones,
           (SELECT COALESCE(SUM(cantidad),0) FROM documentos) AS documentos,
           (SELECT COALESCE(SUM(fojas),0)    FROM documentos) AS fojas
      FROM remisiones`).get();
  const hoyRow = db.prepare(`
    SELECT COUNT(*) AS remisiones,
           (SELECT COALESCE(SUM(d.cantidad),0) FROM documentos d
              JOIN remisiones r2 ON r2.id = d.remision_id WHERE r2.fecha = ?) AS documentos,
           (SELECT COALESCE(SUM(d.fojas),0) FROM documentos d
              JOIN remisiones r2 ON r2.id = d.remision_id WHERE r2.fecha = ?) AS fojas
      FROM remisiones WHERE fecha = ?`).get(hoy, hoy, hoy);
  const porEstado = db.prepare('SELECT estado, COUNT(*) AS total FROM remisiones GROUP BY estado').all();
  const porDependencia = db.prepare(`
    SELECT r.dependencia,
           COUNT(*) AS remisiones,
           COALESCE(SUM((SELECT SUM(d.cantidad) FROM documentos d WHERE d.remision_id = r.id)), 0) AS documentos,
           COALESCE(SUM((SELECT SUM(d.fojas)    FROM documentos d WHERE d.remision_id = r.id)), 0) AS fojas
      FROM remisiones r GROUP BY r.dependencia ORDER BY documentos DESC LIMIT 8`).all();
  const porSituacion = db.prepare(`
    SELECT situacion, COALESCE(SUM(cantidad),0) AS documentos
      FROM documentos GROUP BY situacion ORDER BY documentos DESC`).all();

  const produccion = db.prepare(`
    SELECT COALESCE(SUM(imagenes), 0) AS imagenes,
           (SELECT COUNT(*) FROM capturas WHERE fin = '') AS capturas_abiertas,
           (SELECT COALESCE(SUM(imagenes),0) FROM capturas WHERE substr(fin,1,10) = ?) AS imagenes_hoy
      FROM capturas`).get(hoy);

  const incidencias = db.prepare(`
    SELECT COUNT(*) AS total,
           SUM(CASE WHEN estado = 'Abierta' THEN 1 ELSE 0 END) AS abiertas
      FROM incidencias`).get();

  const porOperador = db.prepare(`
    SELECT operador,
           COUNT(*) AS sesiones,
           COALESCE(SUM(imagenes), 0) AS imagenes
      FROM capturas WHERE operador <> ''
      GROUP BY operador ORDER BY imagenes DESC LIMIT 8`).all();

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
    situaciones: SITUACIONES,
    roles: ROLES,
    tipos_incidencia: TIPOS_INCIDENCIA,
    gravedades: GRAVEDADES,
    medios_entrega: MEDIOS_ENTREGA,
    aceptaciones: ACEPTACIONES,
    usuarios: db.prepare('SELECT id, nombre, email, rol, cargo, activo FROM usuarios ORDER BY nombre').all()
  };
}

function csv(filtros) {
  const escapar = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const encabezados = ['Folio', 'Fecha', 'Hora', 'Dependencia', 'Área', 'Entrega', 'Cargo entrega',
    'Recibe', 'Cargo recibe', 'Estado', 'Cajas', 'Carpetas', 'Partida', 'Descripción', 'Tipo documental',
    'Cantidad', 'Fojas', 'Situación', 'Observaciones partida', 'Observaciones remisión'];
  const lineas = [encabezados.join(',')];
  for (const r of listarRemisiones(filtros)) {
    const docs = db.prepare('SELECT * FROM documentos WHERE remision_id = ? ORDER BY orden, id').all(r.id);
    docs.forEach((d, i) => {
      lineas.push([r.folio, r.fecha, r.hora, r.dependencia, r.area, r.entrega_nombre, r.entrega_cargo,
        r.recibe_nombre, r.recibe_cargo, r.estado, r.cajas, r.carpetas, i + 1, d.descripcion, d.tipo, d.cantidad,
        d.fojas, d.situacion, d.observaciones, r.observaciones].map(escapar).join(','));
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
        cuentas_prueba: usuariosPrueba(),
        usuario: persona
          ? {
              nombre: persona.nombre, email: persona.email, rol: persona.rol,
              foto: persona.foto, es_prueba: esCuentaPrueba(persona.email)
            }
          : null
      });
    }

    // el navegador pide el icono por su cuenta aunque la página declare otro
    if (ruta === '/favicon.ico' && logoMarcaUrl) return servirEstatico(res, logoMarcaUrl);

    if (!ruta.startsWith('/api/')) return servirEstatico(res, ruta);

    /* con el acceso activo, la API solo responde a sesiones abiertas */
    if (accesoActivo() && !sesionDe(req)) {
      return json(res, 401, { error: 'Inicia sesión para continuar.' });
    }

    if (ruta === '/api/estadisticas' && req.method === 'GET') return json(res, 200, estadisticas());

    if (ruta === '/api/config') {
      if (req.method === 'GET') {
        return json(res, 200, { ...leerConfig(), logo: logoUrl, logo_marca: logoMarcaUrl });
      }
      if (req.method === 'PUT') {
        return json(res, 200,
          { ...guardarConfig(await leerCuerpo(req)), logo: logoUrl, logo_marca: logoMarcaUrl });
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
      const cuerpo = csv(p);
      res.writeHead(200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="bitacora-${new Date().toISOString().slice(0, 10)}.csv"`
      });
      return res.end(cuerpo);
    }

    if (ruta === '/api/remisiones') {
      if (req.method === 'GET') return json(res, 200, listarRemisiones(p));
      if (req.method === 'POST') {
        const { errores, valor } = validarRemision(await leerCuerpo(req));
        if (errores.length) return json(res, 400, { errores });
        const nuevoId = crearRemision(valor);
        registrarEvento(nuevoId, 'Recepción',
          `${valor.documentos.length} partida${valor.documentos.length === 1 ? '' : 's'} · ${valor.dependencia}`,
          usuarioDe(req));
        return json(res, 201, obtenerRemision(nuevoId));
      }
    }

    /* ── usuarios del equipo ── */
    if (ruta === '/api/usuarios') {
      if (req.method === 'GET') return json(res, 200, listarPersonal());
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
        db.prepare(`INSERT INTO usuarios (nombre, email, rol, cargo, telefono, creado_en)
                    VALUES (?,?,?,?,?,?)`)
          .run(nombre || email, email, rol, texto(cuerpo.cargo, 120), texto(cuerpo.telefono, 40), ahora());
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

        db.prepare(`UPDATE usuarios SET nombre = ?, email = ?, rol = ?, cargo = ?, telefono = ?, activo = ?
                     WHERE id = ?`)
          .run(nombre, email, rol, texto(cuerpo.cargo, 120), texto(cuerpo.telefono, 40),
               cuerpo.activo === false ? 0 : 1, id);
        if (nombre !== previa.nombre) renombrarPersona(previa.nombre, nombre);
        return json(res, 200, listarPersonal());
      }
      if (req.method === 'DELETE') {
        if (!esSupervisor(req)) return json(res, 403, { errores: ['Solo un supervisor da de baja personas.'] });
        if (accesoActivo() && sesionDe(req)?.id === id) {
          return json(res, 400, { errores: ['No puedes darte de baja a ti mismo.'] });
        }
        db.prepare('DELETE FROM usuarios WHERE id = ?').run(id);
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
      return json(res, 200, db.prepare(`
        SELECT e.*, r.folio FROM eventos e
          LEFT JOIN remisiones r ON r.id = e.remision_id
         ORDER BY e.fecha DESC, e.id DESC LIMIT ?`).all(Math.min(entero(p.limite, 0) || 40, 200)));
    }

    /* ── sesiones de captura ── */
    const capturas = ruta.match(/^\/api\/remisiones\/(\d+)\/capturas$/);
    if (capturas && req.method === 'POST') {
      const id = Number(capturas[1]);
      if (!obtenerRemision(id)) return json(res, 404, { error: 'Remisión no encontrada' });
      const cuerpo = await leerCuerpo(req);
      const operador = texto(cuerpo.operador, 120) || usuarioDe(req);
      if (!operador) return json(res, 400, { errores: ['Indica quién inicia la captura.'] });
      const abierta = db.prepare("SELECT 1 FROM capturas WHERE remision_id = ? AND operador = ? AND fin = ''")
        .get(id, operador);
      if (abierta) return json(res, 400, { errores: [`${operador} ya tiene una captura abierta en este lote.`] });
      db.prepare('INSERT INTO capturas (remision_id, operador, inicio) VALUES (?,?,?)')
        .run(id, operador, ahora());
      registrarEvento(id, 'Captura', `Inicio de captura · ${operador}`, usuarioDe(req));
      avanzarEstado(id, 'En digitalización', usuarioDe(req));
      return json(res, 201, obtenerRemision(id));
    }

    const captura = ruta.match(/^\/api\/capturas\/(\d+)$/);
    if (captura) {
      const id = Number(captura[1]);
      const fila = db.prepare('SELECT * FROM capturas WHERE id = ?').get(id);
      if (!fila) return json(res, 404, { error: 'Sesión de captura no encontrada' });

      if (req.method === 'PATCH') {
        const cuerpo = await leerCuerpo(req);
        const fin = cuerpo.fin === null ? '' : (texto(cuerpo.fin, 40) || ahora());
        const imagenes = entero(cuerpo.imagenes, 0);
        db.prepare('UPDATE capturas SET fin = ?, imagenes = ?, notas = ? WHERE id = ?')
          .run(fin, imagenes, texto(cuerpo.notas, 600), id);
        if (fin && !fila.fin) {
          registrarEvento(fila.remision_id, 'Captura',
            `Fin de captura · ${fila.operador} · ${imagenes} imágenes`, usuarioDe(req));
          const pendientes = db.prepare("SELECT COUNT(*) AS n FROM capturas WHERE remision_id = ? AND fin = ''")
            .get(fila.remision_id).n;
          if (pendientes === 0) avanzarEstado(fila.remision_id, 'Digitalizado', usuarioDe(req));
        }
        return json(res, 200, obtenerRemision(fila.remision_id));
      }
      if (req.method === 'DELETE') {
        db.prepare('DELETE FROM capturas WHERE id = ?').run(id);
        registrarEvento(fila.remision_id, 'Captura', `Sesión eliminada · ${fila.operador}`, usuarioDe(req));
        return json(res, 200, obtenerRemision(fila.remision_id));
      }
    }

    /* ── incidencias del servicio ── */
    const incidencias = ruta.match(/^\/api\/remisiones\/(\d+)\/incidencias$/);
    if (incidencias && req.method === 'POST') {
      const id = Number(incidencias[1]);
      if (!obtenerRemision(id)) return json(res, 404, { error: 'Remisión no encontrada' });
      const cuerpo = await leerCuerpo(req);
      const tipo = TIPOS_INCIDENCIA.includes(texto(cuerpo.tipo)) ? texto(cuerpo.tipo) : 'Otra';
      const gravedad = GRAVEDADES.includes(texto(cuerpo.gravedad)) ? texto(cuerpo.gravedad) : 'Media';
      const descripcion = texto(cuerpo.descripcion, 2000);
      if (!descripcion) return json(res, 400, { errores: ['Describe la incidencia.'] });
      db.prepare(`INSERT INTO incidencias
        (remision_id, tipo, gravedad, descripcion, reportada_por, reportada_en)
        VALUES (?,?,?,?,?,?)`)
        .run(id, tipo, gravedad, descripcion, texto(cuerpo.reportada_por, 120) || usuarioDe(req), ahora());
      registrarEvento(id, 'Incidencia', `${tipo} · gravedad ${gravedad.toLowerCase()}`, usuarioDe(req));
      return json(res, 201, obtenerRemision(id));
    }

    const incidencia = ruta.match(/^\/api\/incidencias\/(\d+)$/);
    if (incidencia) {
      const id = Number(incidencia[1]);
      const fila = db.prepare('SELECT * FROM incidencias WHERE id = ?').get(id);
      if (!fila) return json(res, 404, { error: 'Incidencia no encontrada' });

      if (req.method === 'PATCH') {
        const cuerpo = await leerCuerpo(req);
        const resolucion = texto(cuerpo.resolucion, 2000);
        if (!resolucion) return json(res, 400, { errores: ['Escribe cómo se resolvió.'] });
        db.prepare(`UPDATE incidencias SET estado='Resuelta', resolucion=?, resuelta_por=?, resuelta_en=?
                     WHERE id = ?`)
          .run(resolucion, texto(cuerpo.resuelta_por, 120) || usuarioDe(req), ahora(), id);
        registrarEvento(fila.remision_id, 'Incidencia', `Resuelta · ${fila.tipo}`, usuarioDe(req));
        return json(res, 200, obtenerRemision(fila.remision_id));
      }
      if (req.method === 'DELETE') {
        db.prepare('DELETE FROM incidencias WHERE id = ?').run(id);
        return json(res, 200, obtenerRemision(fila.remision_id));
      }
    }

    /* ── validación de la recepción y cotejo de la entrega ── */
    const cotejo = ruta.match(/^\/api\/remisiones\/(\d+)\/(validacion|cotejo)$/);
    if (cotejo && req.method === 'PUT') {
      const id = Number(cotejo[1]);
      const esValidacion = cotejo[2] === 'validacion';
      const r = obtenerRemision(id);
      if (!r) return json(res, 404, { error: 'Remisión no encontrada' });

      const cuerpo = await leerCuerpo(req);
      const campos = esValidacion
        ? ['cantidad_verificada', 'fojas_verificadas']
        : ['cantidad_devuelta', 'fojas_devueltas'];

      // se comprueba sobre el resultado propuesto: nada se guarda si no procede
      const proyectados = proyectarCotejo(r.documentos, cuerpo.documentos, campos);
      const resumen = diferencias(proyectados, campos[0], campos[1]);
      const notas = texto(cuerpo.notas, 2000);
      const hayDiferencia = resumen.documentos !== 0 || resumen.fojas !== 0;

      if (resumen.completo && hayDiferencia && !notas) {
        return json(res, 400, {
          errores: ['Hay diferencias contra lo asentado: explica a qué se deben antes de guardar.']
        });
      }

      guardarCotejo(id, proyectados, campos);

      const quien = texto(cuerpo.por, 120) || usuarioDe(req);
      if (esValidacion) {
        db.prepare(`UPDATE remisiones SET validada_por = ?, validada_en = ?, validacion_notas = ?,
                     actualizado_en = ? WHERE id = ?`)
          .run(quien, resumen.completo ? ahora() : '', notas, ahora(), id);
      } else {
        db.prepare(`UPDATE remisiones SET cotejo_por = ?, cotejo_en = ?, cotejo_notas = ?,
                     actualizado_en = ? WHERE id = ?`)
          .run(quien, resumen.completo ? ahora() : '', notas, ahora(), id);
      }

      const detalle = hayDiferencia
        ? `${resumen.documentos > 0 ? '+' : ''}${resumen.documentos} documentos · ` +
          `${resumen.fojas > 0 ? '+' : ''}${resumen.fojas} fojas`
        : 'sin diferencias';
      registrarEvento(id, esValidacion ? 'Validación' : 'Cotejo',
        `${resumen.revisadas} de ${resumen.total} partidas · ${detalle}`, usuarioDe(req));

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
          errores: ['Antes de firmar hay que cotejar la entrega contra lo recibido, partida por partida.']
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
      if (!obtenerRemision(id)) return json(res, 404, { error: 'Remisión no encontrada' });

      if (req.method === 'PUT') {
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
        avanzarEstado(id, 'Devuelto', usuarioDe(req));
        return json(res, 200, obtenerRemision(id));
      }
      if (req.method === 'DELETE') {
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
        registrarEvento(id, 'Devolución', 'Devolución cancelada', usuarioDe(req));
        return json(res, 200, obtenerRemision(id));
      }
    }

    const firma = ruta.match(/^\/api\/remisiones\/(\d+)\/firma$/);
    if (firma) {
      const id = Number(firma[1]);
      if (!obtenerRemision(id)) return json(res, 404, { error: 'Remisión no encontrada' });

      if (req.method === 'POST') {
        const cuerpo = await leerCuerpo(req);
        const entrega = imagenFirma(cuerpo.firma_entrega);
        const recibe = imagenFirma(cuerpo.firma_recibe);
        if (!entrega && !recibe) return json(res, 400, { errores: ['No se recibió ninguna firma.'] });
        db.prepare('UPDATE remisiones SET firma_entrega=?, firma_recibe=?, firmado_en=?, actualizado_en=? WHERE id=?')
          .run(entrega, recibe, ahora(), ahora(), id);
        registrarEvento(id, 'Firma', 'Acuse de recepción firmado', usuarioDe(req));
        return json(res, 200, obtenerRemision(id));
      }
      if (req.method === 'DELETE') {
        db.prepare("UPDATE remisiones SET firma_entrega='', firma_recibe='', firmado_en='', actualizado_en=? WHERE id=?")
          .run(ahora(), id);
        return json(res, 200, obtenerRemision(id));
      }
    }

    const m = ruta.match(/^\/api\/remisiones\/(\d+)$/);
    if (m) {
      const id = Number(m[1]);
      if (!obtenerRemision(id)) return json(res, 404, { error: 'Remisión no encontrada' });

      if (req.method === 'GET') return json(res, 200, obtenerRemision(id));
      if (req.method === 'PUT') {
        const { errores, valor } = validarRemision(await leerCuerpo(req));
        if (errores.length) return json(res, 400, { errores });
        actualizarRemision(id, valor);
        registrarEvento(id, 'Edición', 'Se modificaron los datos de la remisión', usuarioDe(req));
        return json(res, 200, obtenerRemision(id));
      }
      if (req.method === 'PATCH') {
        const cambios = await leerCuerpo(req);
        const estado = texto(cambios.estado);
        if (!ESTADOS.includes(estado)) return json(res, 400, { errores: ['Estado no válido.'] });
        const previo = db.prepare('SELECT estado FROM remisiones WHERE id = ?').get(id).estado;
        db.prepare('UPDATE remisiones SET estado=?, actualizado_en=? WHERE id=?')
          .run(estado, ahora(), id);
        if (previo !== estado) registrarEvento(id, 'Estado', `${previo} → ${estado}`, usuarioDe(req));
        return json(res, 200, obtenerRemision(id));
      }
      if (req.method === 'DELETE') {
        db.prepare('DELETE FROM remisiones WHERE id = ?').run(id);
        return json(res, 200, { ok: true });
      }
    }

    return json(res, 404, { error: 'Ruta no encontrada' });
  } catch (e) {
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
  console.log(`\n  PROYECTAI · Bitácora  ·  este equipo:  ${esquema}://localhost:${PORT}`);
  for (const ip of direccionesDeRed()) {
    console.log(`                        ·  en la red:    ${esquema}://${ip}:${PORT}`);
  }
  const comoSeEntra = ssoActivo()
    ? `Google · redirección ${baseUrl({ headers: {} })}/auth/google/callback`
    : pruebaActiva()
      ? 'cuentas de prueba (Google todavía no configurado)'
      : 'modo local (sin contraseña; identidad declarada por equipo)';
  console.log(`                        ·  acceso:       ${comoSeEntra}`);
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
