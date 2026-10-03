/* ══════════════════════════════════════════════════════════════════════
   Cadena de custodia de cada carpeta durante la digitalización, y las
   solicitudes que sustituyen a los borrados.

   Cada carpeta pasa, en orden y sin saltos, por:
     Por asignar → En mesa → Descosida → Escaneada → Recosida
   Todo el tratamiento ocurre en la mesa: ahí se descose, se revisa, se
   retiran los post-its, se escanea y se vuelve a coser.
   Cada paso deja quién, cuándo y qué se encontró. Nada se borra.
   ══════════════════════════════════════════════════════════════════════ */
import {
  db, registrarEvento, ESTADOS, TIPOS_INSERTO, LADOS_INSERTO, TIPOS_SOLICITUD
} from './db.js';
import { archivosDe } from './archivo.js';

/** Error de regla de negocio: se muestra tal cual a quien lo provocó. */
export class ErrorRegla extends Error {}

const ahora = () => new Date().toISOString();
const texto = (v, max = 300) => String(v ?? '').trim().slice(0, max);
// una casilla vacía es «no capturado», nunca cero
const entero = (v) => {
  if (v === '' || v === null || v === undefined) return null;
  const n = Math.trunc(Number(v));
  return Number.isFinite(n) && n >= 0 ? n : null;
};
const exigir = (condicion, mensaje) => { if (!condicion) throw new ErrorRegla(mensaje); };

/** Cómo se nombra una carpeta en mensajes y en la auditoría. */
/** Dónde estaba un inserto: «hoja 45, reverso». */
const ubicacion = (i) => `hoja ${i.foja}${i.lado ? `, ${i.lado.toLowerCase()}` : ''}`;

export const nombreCarpeta = (d) => `caja ${d.caja} · ${d.nuc || d.descripcion || `carpeta ${d.id}`}`;

/* ─────────────────────────────── etapas ─────────────────────────────── */

export const ETAPAS = ['Por asignar', 'En mesa', 'Descosida', 'Escaneada', 'Recosida'];

/** Etapa actual de una carpeta, deducida de lo registrado. */
export function etapaDe(d, asignaciones) {
  if (d.recosido_en) return 'Recosida';
  const ultima = asignaciones.filter((a) => a.documento_id === d.id).at(-1);
  if (ultima && !ultima.salida_en) return d.prep_en ? 'Descosida' : 'En mesa';
  if (ultima && ultima.cuadra) return 'Escaneada';
  return 'Por asignar';                        // también tras un escaneo que no cuadró
}

/** El tratamiento empezó en cuanto una carpeta llegó a una mesa. */
export const iniciada = (r) => r.asignaciones.length > 0 || r.documentos.some((d) => d.prep_en);

/** Agrega a una remisión ya leída todo lo de la custodia. */
export function completarCustodia(r) {
  r.asignaciones = db.prepare('SELECT * FROM asignaciones WHERE remision_id = ? ORDER BY id').all(r.id);
  r.insertos = db.prepare('SELECT * FROM insertos WHERE remision_id = ? ORDER BY id').all(r.id);
  r.solicitudes = db.prepare('SELECT * FROM solicitudes WHERE remision_id = ? ORDER BY id DESC').all(r.id);
  for (const d of r.documentos) d.etapa = etapaDe(d, r.asignaciones);
  ubicar(r);

  const enProceso = iniciada(r);
  const correccion = r.solicitudes.find((s) => s.tipo === 'Corrección' && s.estado === 'Aprobada');
  const firmadaOValidada = Boolean(r.firmado_en || r.validada_en || r.validacion?.revisadas);

  // qué se puede hacer con los datos de la recepción en este momento
  r.edicion = bloqueada(r) ? 'bloqueada'
    : enProceso ? 'en_proceso'
    : !firmadaOValidada ? 'libre'
    : correccion ? 'autorizada'
    : 'requiere_solicitud';
  r.puede_cancelar = !bloqueada(r) && r.estado === 'Recibido' && !enProceso;
  r.etapas = Object.fromEntries(ETAPAS.map((e) => [e, r.documentos.filter((d) => d.etapa === e).length]));
  return r;
}

export const bloqueada = (r) => Boolean(r.cancelada_en || r.eliminada_en);

const nombresDeSedes = () => new Map(db.prepare('SELECT id, nombre FROM sedes').all().map((s) => [s.id, s.nombre]));
const EN_MESA = ['En mesa', 'Descosida', 'Escaneada'];

/** Dónde está físicamente cada carpeta: su sede y su mesa, o en tránsito.
 *  También le adjunta su PDF vigente, si ya lo tiene. */
function ubicar(r) {
  r.archivos = archivosDe(r.id);
  for (const d of r.documentos) d.archivo = r.archivos.find((a) => a.documento_id === d.id && a.vigente) || null;
  const sedes = nombresDeSedes();
  r.sede = sedes.get(r.sede_id) || '';
  r.traslados = db.prepare(`
    SELECT tc.*, t.origen_id, t.destino_id, t.estado, t.envia_por, t.enviado_en, t.transporta,
           t.recibido_por, t.recibido_en, t.notas, t.notas_recepcion
      FROM traslado_cajas tc JOIN traslados t ON t.id = tc.traslado_id
     WHERE tc.remision_id = ? ORDER BY tc.id`).all(r.id)
    .map((x) => ({ ...x, origen: sedes.get(x.origen_id), destino: sedes.get(x.destino_id) }));
  const enTransito = new Map(r.traslados.filter((x) => x.estado === 'En tránsito').map((x) => [x.caja, x]));
  for (const d of r.documentos) {
    d.sede = sedes.get(d.sede_id) || '';
    const viaje = enTransito.get(d.caja);
    d.en_transito = Boolean(viaje);
    const mesa = EN_MESA.includes(d.etapa) ? r.asignaciones.filter((a) => a.documento_id === d.id).at(-1) : null;
    d.mesa_id = mesa?.mesa_id ?? null;
    d.ubicacion = viaje ? `En tránsito: ${viaje.origen} → ${viaje.destino}`
      : mesa ? `${d.sede} · ${mesa.mesa}` : d.sede;
  }
}

function exigirAbierta(r) {
  exigir(!r.eliminada_en, 'Esta remisión fue eliminada; solo se puede consultar.');
  exigir(!r.cancelada_en, 'Esta remisión está cancelada; solo se puede consultar.');
}

function carpetaDe(r, documentoId) {
  const d = r.documentos.find((x) => x.id === Number(documentoId));
  exigir(d, 'Esa carpeta no pertenece a esta remisión.');
  return d;
}

/** Mueve el estado del lote hacia adelante, nunca hacia atrás. */
function avanzar(r, nuevo, usuario) {
  const actual = db.prepare('SELECT estado FROM remisiones WHERE id = ?').get(r.id).estado;
  if (actual === nuevo || ESTADOS.indexOf(nuevo) < ESTADOS.indexOf(actual)) return;
  db.prepare('UPDATE remisiones SET estado = ?, actualizado_en = ? WHERE id = ?').run(nuevo, ahora(), r.id);
  registrarEvento(r.id, 'Estado', `${actual} → ${nuevo}`, usuario);
}

/** Ejecuta varias escrituras como una sola: o quedan todas o ninguna. */
function enTransaccion(fn) {
  db.exec('BEGIN');
  try {
    const salida = fn();
    db.exec('COMMIT');
    return salida;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

/* ─────────────── 2. en la mesa: descosido, revisión e insertos ──────────── */

export function prepararCarpeta(r, documentoId, datos, usuario) {
  exigirAbierta(r);
  const d = carpetaDe(r, documentoId);
  exigir(d.etapa === 'En mesa', d.etapa === 'Por asignar'
    ? `La ${nombreCarpeta(d)} primero tiene que asignarse a una mesa.`
    : `La ${nombreCarpeta(d)} ya fue descosida y revisada.`);

  exigir(datos.descosida === true, 'Confirma que se retiró el estambre.');
  const contadas = entero(datos.fojas_contadas);
  exigir(contadas !== null, 'Escribe cuántas fojas se contaron.');
  exigir(contadas === d.fojas,
    `Se contaron ${contadas} fojas y en la recepción se asentaron ${d.fojas}. ` +
    'La carpeta no puede avanzar: reporta una incidencia para aclararlo.');
  if (d.situacion !== 'Sin foliar') {
    exigir(datos.folios_completos === true,
      `Confirma que los folios ${d.folio_inicial} a ${d.folio_final} están completos y en orden.`);
  }

  const insertos = (Array.isArray(datos.insertos) ? datos.insertos : [])
    .map((i) => ({
      tipo: TIPOS_INSERTO.includes(texto(i.tipo)) ? texto(i.tipo) : 'Otro',
      descripcion: texto(i.descripcion, 300),
      foja: entero(i.foja),
      lado: LADOS_INSERTO.includes(texto(i.lado)) ? texto(i.lado) : ''
    }))
    .filter((i) => i.descripcion || i.foja !== null);
  insertos.forEach((i, n) => {
    exigir(i.foja !== null, `Indica en qué hoja estaba el inserto ${n + 1}, para volver a ponerlo ahí.`);
    exigir(i.lado, `Indica si el inserto ${n + 1} estaba al frente, al reverso o entre dos hojas.`);
  });
  const danos = texto(datos.hojas_danadas, 500);

  enTransaccion(() => {
    const t = ahora();
    db.prepare('UPDATE documentos SET prep_por = ?, prep_en = ?, prep_notas = ?, prep_danos = ? WHERE id = ?')
      .run(usuario, t, texto(datos.notas, 1000), danos, d.id);
    const alta = db.prepare(`INSERT INTO insertos
      (documento_id, remision_id, tipo, descripcion, foja, lado, retirado_por, retirado_en) VALUES (?,?,?,?,?,?,?,?)`);
    for (const i of insertos) alta.run(d.id, r.id, i.tipo, i.descripcion, i.foja, i.lado, usuario, t);
    // las hojas dañadas no detienen la carpeta, pero el supervisor tiene que verlas
    if (danos) {
      db.prepare(`INSERT INTO incidencias (remision_id, tipo, gravedad, descripcion, reportada_por, reportada_en)
                  VALUES (?, 'Documento en mal estado', 'Media', ?, ?, ?)`)
        .run(r.id, `${nombreCarpeta(d)} · hojas dañadas: ${danos}`, usuario, t);
    }
    registrarEvento(r.id, 'Descosido',
      `${nombreCarpeta(d)} · descosida y revisada, ${contadas} fojas` +
      (insertos.length ? ` · ${insertos.length} inserto${insertos.length === 1 ? '' : 's'} retirado${insertos.length === 1 ? '' : 's'}` : ' · sin insertos') +
      (danos ? ` · hojas dañadas: ${danos}` : ''),
      usuario);
  });
}

/* ───────────── quién hace cada paso dentro de la mesa ───────────── */

/** Mesa en la que está ahora la carpeta (la de su última asignación). */
const mesaDeCarpeta = (r, d) => {
  const ultima = r.asignaciones.filter((a) => a.documento_id === d.id).at(-1);
  return ultima && db.prepare('SELECT * FROM mesas WHERE id = ?').get(ultima.mesa_id);
};

/** Desde una mesa, solo su escaneador (el responsable) escanea y sube el PDF. */
export function exigirEscaneador(r, d, usuario, rol) {
  if (rol !== 'Mesa') return;
  const mesa = mesaDeCarpeta(r, d);
  exigir(mesa && mesa.responsable === usuario,
    `Solo el escaneador de la ${mesa?.nombre || 'mesa'} (${mesa?.responsable || 'sin asignar'}) escanea y sube el PDF.`);
}

/** Quién debe recoser: quien la descosió, salvo que un supervisor la haya reasignado. */
const quienRecose = (d) => d.recoser_asignado || d.prep_por;

/* ──────────────────────── 1. asignación a una mesa ──────────────────── */

export function enviarAMesa(r, documentoIds, mesaId, usuario) {
  exigirAbierta(r);
  exigir(r.validada_en, `Primero hay que validar la recepción de ${r.folio}: contar el lote contra lo asentado.`);
  const mesa = db.prepare('SELECT * FROM mesas WHERE id = ?').get(Number(mesaId));
  exigir(mesa && mesa.activa, 'Elige una mesa activa.');
  exigir(mesa.responsable, `La ${mesa?.nombre || 'mesa'} no tiene responsable asignado.`);

  const ids = [...new Set((Array.isArray(documentoIds) ? documentoIds : []).map(Number))];
  exigir(ids.length, 'Elige al menos una carpeta.');
  const carpetas = ids.map((id) => carpetaDe(r, id));
  for (const d of carpetas) {
    exigir(d.etapa === 'Por asignar', `La ${nombreCarpeta(d)} ya está «${d.etapa}».`);
    exigir(!d.en_transito, `La ${nombreCarpeta(d)} va en tránsito: primero hay que recibirla en su sede.`);
    exigir(d.sede_id === mesa.sede_id,
      `La ${nombreCarpeta(d)} está en ${d.sede}; la ${mesa.nombre} es de otra sede. Hay que trasladar su caja primero.`);
  }
  // una caja va entera a una sola mesa: con ella, todas sus carpetas que esperan mesa
  for (const caja of new Set(carpetas.map((d) => d.caja))) {
    const pendientes = r.documentos.filter((d) => d.caja === caja && d.etapa === 'Por asignar');
    exigir(pendientes.every((d) => ids.includes(d.id)),
      `La caja ${caja} de ${r.folio} tiene ${pendientes.length} carpetas por asignar: se asigna la caja completa.`);
  }

  enTransaccion(() => {
    const t = ahora();
    const alta = db.prepare(`INSERT INTO asignaciones
      (documento_id, remision_id, mesa_id, mesa, responsable, entrada_por, entrada_en) VALUES (?,?,?,?,?,?,?)`);
    for (const d of carpetas) alta.run(d.id, r.id, mesa.id, mesa.nombre, mesa.responsable, usuario, t);
    registrarEvento(r.id, 'Mesa',
      `${carpetas.length} carpeta${carpetas.length === 1 ? '' : 's'} a ${mesa.nombre} ` +
      `(responsable: ${mesa.responsable}) · ${carpetas.map((d) => d.nuc || d.descripcion).join(', ')}`,
      usuario);
    avanzar(r, 'En digitalización', usuario);
  });
}

/* ──────────────────────────── 3. escaneo ────────────────────────────── */

export function registrarEscaneo(r, documentoId, datos, usuario, rol) {
  exigirAbierta(r);
  const d = carpetaDe(r, documentoId);
  exigir(d.etapa === 'Descosida', d.etapa === 'En mesa'
    ? `La ${nombreCarpeta(d)} primero tiene que descoserse y revisarse.`
    : `La ${nombreCarpeta(d)} no está lista para escanear.`);
  exigirEscaneador(r, d, usuario, rol);
  const asignacion = r.asignaciones.filter((a) => a.documento_id === d.id).at(-1);

  const fojas = entero(datos.fojas_escaneadas);
  const imagenes = entero(datos.imagenes);
  exigir(fojas !== null, 'Escribe cuántas fojas se escanearon.');
  exigir(imagenes !== null && imagenes > 0, 'Escribe cuántas imágenes se generaron.');
  const cuadra = fojas === d.fojas;
  const notas = texto(datos.notas, 1000);
  exigir(cuadra || notas,
    `Se escanearon ${fojas} de ${d.fojas} fojas: explica qué pasó. La carpeta tendrá que asignarse de nuevo a una mesa.`);

  enTransaccion(() => {
    db.prepare(`UPDATE asignaciones SET salida_por = ?, salida_en = ?, fojas_escaneadas = ?, imagenes = ?,
                cuadra = ?, notas = ? WHERE id = ?`)
      .run(usuario, ahora(), fojas, imagenes, cuadra ? 1 : 0, notas, asignacion.id);
    registrarEvento(r.id, 'Escaneo',
      `${nombreCarpeta(d)} · ${asignacion.mesa} · ${fojas} de ${d.fojas} fojas, ${imagenes} imágenes` +
      (cuadra ? '' : ' · NO CUADRA, regresa a por asignar'), usuario);
  });
}

/* ──────────────────── 4. reintegración y recosido ───────────────────── */

export function recoserCarpeta(r, documentoId, datos, usuario, rol) {
  exigirAbierta(r);
  const d = carpetaDe(r, documentoId);
  exigir(d.etapa === 'Escaneada', `La ${nombreCarpeta(d)} todavía no tiene un escaneo completo.`);
  if (rol === 'Mesa') {
    exigir(usuario === quienRecose(d), d.recoser_asignado
      ? `Esta carpeta la recose ${d.recoser_asignado}, a quien un supervisor se la reasignó.`
      : `Esta carpeta la recose quien la descosió: ${d.prep_por}. Si no está, un supervisor puede reasignarla.`);
  }

  exigir(d.archivo, `Primero sube el PDF de la ${nombreCarpeta(d)}: sin su expediente digital no se recose.`);
  const pendientes = r.insertos.filter((i) => i.documento_id === d.id && !i.reintegrado_en);
  const confirmados = new Set((Array.isArray(datos.insertos_reintegrados) ? datos.insertos_reintegrados : []).map(Number));
  for (const i of pendientes) {
    exigir(confirmados.has(i.id),
      `Falta confirmar que el ${i.tipo.toLowerCase()} «${i.descripcion || 'sin descripción'}» ` +
      `volvió a su lugar (${ubicacion(i)}).`);
  }
  exigir(datos.fojas_completas === true, 'Confirma que la carpeta conserva todas sus fojas y en orden.');
  exigir(datos.cosida === true, 'Confirma que la carpeta se volvió a coser.');

  enTransaccion(() => {
    const t = ahora();
    const marcar = db.prepare('UPDATE insertos SET reintegrado_por = ?, reintegrado_en = ? WHERE id = ?');
    for (const i of pendientes) marcar.run(usuario, t, i.id);
    db.prepare('UPDATE documentos SET recosido_por = ?, recosido_en = ?, recosido_notas = ? WHERE id = ?')
      .run(usuario, t, texto(datos.notas, 1000), d.id);
    registrarEvento(r.id, 'Recosido',
      `${nombreCarpeta(d)} · ${pendientes.length} inserto${pendientes.length === 1 ? '' : 's'} reintegrado${pendientes.length === 1 ? '' : 's'}, ` +
      'cosida y verificada', usuario);

    const faltan = db.prepare("SELECT COUNT(*) AS n FROM documentos WHERE remision_id = ? AND recosido_en = ''")
      .get(r.id).n;
    if (faltan === 0) avanzar(r, 'Digitalizado', usuario);
  });
}

/** Un supervisor pasa el recosido a otra persona de la misma mesa (si quien la descosió falta). */
export function reasignarRecosido(r, documentoId, datos, usuario) {
  exigirAbierta(r);
  const d = carpetaDe(r, documentoId);
  exigir(d.prep_en && !d.recosido_en, `La ${nombreCarpeta(d)} no está esperando recosido: no hay nada que reasignar.`);
  const motivo = texto(datos.motivo, 500);
  exigir(motivo.length >= 10, 'Explica el motivo de la reasignación (al menos 10 caracteres).');
  const mesa = mesaDeCarpeta(r, d);
  const a = texto(datos.a, 120);
  const deLaMesa = mesa && db.prepare("SELECT 1 FROM usuarios WHERE nombre = ? AND rol = 'Mesa' AND activo = 1 AND mesa_id = ?")
    .get(a, mesa.id);
  exigir(deLaMesa, `${a || 'Esa persona'} no es de la ${mesa?.nombre || 'mesa'}: el recosido se reasigna a alguien de la misma mesa.`);
  exigir(a !== quienRecose(d), `${a} ya es quien debe recoserla.`);

  enTransaccion(() => {
    db.prepare('UPDATE documentos SET recoser_asignado = ? WHERE id = ?').run(a, d.id);
    registrarEvento(r.id, 'Recosido',
      `${nombreCarpeta(d)} · el recosido pasa de ${quienRecose(d)} a ${a} · motivo: ${motivo}`, usuario);
  });
}

/* ─────────────────────────────── mesas ──────────────────────────────── */

/** El responsable de la mesa es su escaneador; las demás personas de la mesa la apoyan preparando. */
export const listarMesas = () => db.prepare(`
  SELECT m.*, (SELECT nombre FROM sedes s WHERE s.id = m.sede_id) AS sede,
    (SELECT COUNT(*) FROM asignaciones a WHERE a.mesa_id = m.id AND a.salida_en = '') AS en_mesa,
    (SELECT COUNT(*) FROM asignaciones a WHERE a.mesa_id = m.id AND a.cuadra = 1)     AS escaneadas,
    (SELECT json_group_array(u.nombre) FROM usuarios u
      WHERE u.mesa_id = m.id AND u.rol = 'Mesa' AND u.activo = 1 AND u.nombre <> m.responsable) AS preparadores
    FROM mesas m ORDER BY m.activa DESC, m.nombre`).all()
  .map((m) => ({ ...m, preparadores: JSON.parse(m.preparadores) }));

export function guardarMesa(id, datos, usuario) {
  const nombre = texto(datos.nombre, 60);
  const responsable = texto(datos.responsable, 120);
  const activa = datos.activa === false ? 0 : 1;
  const sedeId = Number(datos.sede_id);
  exigir(nombre, 'Escribe el nombre de la mesa.');
  exigir(responsable || !activa, 'Una mesa activa necesita responsable.');
  exigir(db.prepare('SELECT 1 FROM sedes WHERE id = ? AND activa = 1').get(sedeId), 'Elige la sede de la mesa.');
  const repetida = db.prepare('SELECT id FROM mesas WHERE sede_id = ? AND nombre = ?').get(sedeId, nombre);
  exigir(!repetida || repetida.id === id, `Ya existe una mesa llamada ${nombre} en esa sede.`);

  if (id) {
    const previa = db.prepare('SELECT * FROM mesas WHERE id = ?').get(id);
    exigir(previa, 'Esa mesa no existe.');
    const ocupada = db.prepare("SELECT COUNT(*) AS n FROM asignaciones WHERE mesa_id = ? AND salida_en = ''").get(id).n;
    exigir(activa || !ocupada, `No se puede desactivar: tiene ${ocupada} carpeta${ocupada === 1 ? '' : 's'} en proceso.`);
    exigir(previa.sede_id === sedeId || !ocupada, 'No se puede cambiar de sede una mesa con carpetas en proceso.');
    db.prepare('UPDATE mesas SET nombre = ?, responsable = ?, activa = ?, sede_id = ? WHERE id = ?')
      .run(nombre, responsable, activa, sedeId, id);
    const cambios = [
      previa.nombre !== nombre && `nombre ${previa.nombre} → ${nombre}`,
      previa.responsable !== responsable && `responsable ${previa.responsable || '—'} → ${responsable || '—'}`,
      previa.activa !== activa && (activa ? 'reactivada' : 'desactivada'),
      previa.sede_id !== sedeId && 'cambió de sede'
    ].filter(Boolean);
    if (cambios.length) registrarEvento(null, 'Mesa', `${previa.nombre}: ${cambios.join(' · ')}`, usuario);
  } else {
    db.prepare('INSERT INTO mesas (nombre, responsable, activa, creado_en, sede_id) VALUES (?,?,?,?,?)')
      .run(nombre, responsable, activa, ahora(), sedeId);
    registrarEvento(null, 'Mesa', `Alta de ${nombre} · responsable: ${responsable}`, usuario);
  }
  return listarMesas();
}

/* ──────────────────── cancelación y solicitudes ─────────────────────── */

export function cancelarRemision(r, motivo, usuario) {
  exigirAbierta(r);
  exigir(r.puede_cancelar,
    'Solo se cancela una recepción que aún no entra a digitalización. Después, cualquier cambio va por incidencia.');
  const m = texto(motivo, 1000);
  exigir(m.length >= 10, 'Explica el motivo de la cancelación (al menos 10 caracteres).');
  db.prepare(`UPDATE remisiones SET estado = 'Cancelado', cancelada_por = ?, cancelada_en = ?,
              cancelacion_motivo = ?, actualizado_en = ? WHERE id = ?`)
    .run(usuario, ahora(), m, ahora(), r.id);
  registrarEvento(r.id, 'Cancelación', m, usuario);
}

export function crearSolicitud(r, datos, usuario) {
  exigir(!r.eliminada_en, 'Esta remisión ya fue eliminada.');
  const tipo = texto(datos.tipo);
  exigir(TIPOS_SOLICITUD.includes(tipo), 'Tipo de solicitud no válido.');
  const motivo = texto(datos.motivo, 1000);
  exigir(motivo.length >= 10, 'Explica el motivo de la solicitud (al menos 10 caracteres).');
  exigir(!iniciada(r),
    'Las carpetas ya entraron a digitalización: los datos de la recepción no se modifican; registra una incidencia.');
  if (tipo === 'Corrección') {
    exigir(!r.cancelada_en, 'Una remisión cancelada no se corrige.');
    exigir(r.edicion === 'requiere_solicitud', 'Esta remisión se puede editar sin solicitud.');
  }
  exigir(!r.solicitudes.some((s) => s.tipo === tipo && ['Pendiente', 'Aprobada'].includes(s.estado)),
    `Ya hay una solicitud de ${tipo.toLowerCase()} en curso para esta remisión.`);

  db.prepare(`INSERT INTO solicitudes (remision_id, tipo, motivo, solicitada_por, solicitada_en)
              VALUES (?,?,?,?,?)`).run(r.id, tipo, motivo, usuario, ahora());
  registrarEvento(r.id, 'Solicitud', `${tipo} solicitada · ${motivo}`, usuario);
}

export function resolverSolicitud(solicitudId, datos, usuario) {
  const s = db.prepare('SELECT * FROM solicitudes WHERE id = ?').get(Number(solicitudId));
  exigir(s, 'Esa solicitud no existe.');
  exigir(s.estado === 'Pendiente', 'Esa solicitud ya fue resuelta.');
  exigir(s.solicitada_por !== usuario, 'Una solicitud la resuelve un supervisor distinto de quien la pidió.');
  const aprobar = datos.aprobar === true;
  const respuesta = texto(datos.respuesta, 1000);
  exigir(aprobar || respuesta, 'Explica por qué se rechaza.');

  enTransaccion(() => {
    const t = ahora();
    db.prepare('UPDATE solicitudes SET estado = ?, resuelta_por = ?, resuelta_en = ?, respuesta = ? WHERE id = ?')
      .run(aprobar ? 'Aprobada' : 'Rechazada', usuario, t, respuesta, s.id);
    if (aprobar && s.tipo === 'Eliminación') {
      db.prepare('UPDATE remisiones SET eliminada_por = ?, eliminada_en = ?, actualizado_en = ? WHERE id = ?')
        .run(usuario, t, t, s.remision_id);
      db.prepare("UPDATE solicitudes SET estado = 'Usada' WHERE id = ?").run(s.id);
    }
    registrarEvento(s.remision_id, 'Solicitud',
      `${s.tipo} ${aprobar ? 'aprobada' : 'rechazada'}${respuesta ? ` · ${respuesta}` : ''}`, usuario);
  });
  return s.remision_id;
}

/** Al guardar una corrección autorizada, la autorización se consume. */
export function consumirCorreccion(r, usuario) {
  const s = r.solicitudes.find((x) => x.tipo === 'Corrección' && x.estado === 'Aprobada');
  if (!s) return;
  db.prepare("UPDATE solicitudes SET estado = 'Usada' WHERE id = ?").run(s.id);
  registrarEvento(r.id, 'Solicitud', 'Corrección aplicada', usuario);
}

export const solicitudesPendientes = () => db.prepare(`
  SELECT s.*, r.folio, r.dependencia FROM solicitudes s JOIN remisiones r ON r.id = s.remision_id
   WHERE s.estado = 'Pendiente' ORDER BY s.solicitada_en`).all();

/* ──────────────────────── traslados entre sedes ─────────────────────── */

/* Se trasladan cajas completas. Solo viajan cajas cuyas carpetas no están a
   medio tratamiento (ninguna en una mesa) y de lotes ya validados. */
const ETAPAS_QUE_VIAJAN = ['Por asignar', 'Recosida'];

/** Lee una remisión con lo necesario para trasladar o recibir sus cajas. */
export function remisionConCustodia(id) {
  const r = db.prepare('SELECT * FROM remisiones WHERE id = ?').get(id);
  if (!r) return null;
  r.documentos = db.prepare('SELECT * FROM documentos WHERE remision_id = ? ORDER BY orden, id').all(id);
  r.asignaciones = db.prepare('SELECT * FROM asignaciones WHERE remision_id = ? ORDER BY id').all(id);
  for (const d of r.documentos) d.etapa = etapaDe(d, r.asignaciones);
  ubicar(r);
  return r;
}

/** Comprueba que una caja pueda salir de su sede y devuelve sus carpetas. */
function cajaQueViaja(r, caja) {
  const carpetas = r.documentos.filter((d) => d.caja === caja);
  exigir(carpetas.length, `${r.folio} no tiene caja ${caja}.`);
  exigir(!bloqueada(r), `${r.folio} está cancelada o eliminada.`);
  exigir(r.validada_en, `${r.folio} no está validada: hay que contarla antes de que salga de la sede.`);
  exigir(!carpetas.some((d) => d.en_transito), `La caja ${caja} de ${r.folio} ya va en tránsito.`);
  exigir(new Set(carpetas.map((d) => d.sede_id)).size === 1, `Las carpetas de la caja ${caja} de ${r.folio} no están juntas.`);
  const ocupada = carpetas.find((d) => !ETAPAS_QUE_VIAJAN.includes(d.etapa));
  exigir(!ocupada, `La caja ${caja} de ${r.folio} tiene carpetas en una mesa (${ocupada?.nuc}): no puede salir a medio tratamiento.`);
  return carpetas;
}

export function crearTraslado(datos, usuario, sedeDelUsuario) {
  const destino = db.prepare('SELECT * FROM sedes WHERE id = ? AND activa = 1').get(Number(datos.destino));
  exigir(destino, 'Elige la sede destino.');
  const transporta = texto(datos.transporta, 160);
  exigir(transporta, 'Indica quién transporta las cajas.');
  const cajas = (Array.isArray(datos.cajas) ? datos.cajas : [])
    .map((c) => ({ remision_id: Number(c.remision_id), caja: Number(c.caja) }));
  exigir(cajas.length, 'Elige al menos una caja.');

  const lotes = new Map();
  const salida = cajas.map((c) => {
    if (!lotes.has(c.remision_id)) lotes.set(c.remision_id, remisionConCustodia(c.remision_id));
    const r = lotes.get(c.remision_id);
    exigir(r && !r.eliminada_en, 'Una de las cajas no pertenece a una remisión vigente.');
    const carpetas = cajaQueViaja(r, c.caja);
    return { ...c, r, origen: carpetas[0].sede_id, carpetas: carpetas.length,
             fojas: carpetas.reduce((a, d) => a + d.fojas, 0) };
  });
  const origen = salida[0].origen;
  exigir(salida.every((c) => c.origen === origen), 'Todas las cajas de un traslado deben salir de la misma sede.');
  exigir(sedeDelUsuario === null || sedeDelUsuario === origen, 'Solo se envían cajas que están en tu sede.');
  exigir(origen !== destino.id, 'La sede destino es la misma de donde salen las cajas.');

  const nombreOrigen = nombresDeSedes().get(origen);
  return enTransaccion(() => {
    const t = ahora();
    const { lastInsertRowid: id } = db.prepare(`INSERT INTO traslados
      (origen_id, destino_id, envia_por, enviado_en, transporta, notas) VALUES (?,?,?,?,?,?)`)
      .run(origen, destino.id, usuario, t, transporta, texto(datos.notas, 1000));
    const alta = db.prepare(`INSERT INTO traslado_cajas (traslado_id, remision_id, caja, carpetas, fojas)
                             VALUES (?,?,?,?,?)`);
    for (const c of salida) alta.run(id, c.remision_id, c.caja, c.carpetas, c.fojas);
    for (const remisionId of lotes.keys()) {
      const propias = salida.filter((c) => c.remision_id === remisionId);
      registrarEvento(remisionId, 'Traslado',
        `Traslado ${id}: caja${propias.length === 1 ? '' : 's'} ${propias.map((c) => c.caja).join(', ')} ` +
        `de ${nombreOrigen} a ${destino.nombre} · transporta ${transporta}`, usuario);
    }
    return Number(id);
  });
}

export function recibirTraslado(id, datos, usuario, sedeDelUsuario) {
  const traslado = db.prepare('SELECT * FROM traslados WHERE id = ?').get(Number(id));
  exigir(traslado, 'Ese traslado no existe.');
  exigir(traslado.estado === 'En tránsito', 'Ese traslado ya se recibió.');
  exigir(sedeDelUsuario === null || sedeDelUsuario === traslado.destino_id, 'Solo la sede destino recibe un traslado.');
  const cajas = db.prepare('SELECT * FROM traslado_cajas WHERE traslado_id = ?').all(traslado.id);
  const contado = new Map((Array.isArray(datos.cajas) ? datos.cajas : []).map((c) => [Number(c.id), c]));

  const recibidas = cajas.map((c) => {
    const x = contado.get(c.id);
    const carpetas = entero(x?.carpetas);
    const fojas = entero(x?.fojas);
    exigir(carpetas !== null && fojas !== null, `Cuenta las carpetas y fojas de la caja ${c.caja} al recibirla.`);
    return { ...c, carpetas_recibidas: carpetas, fojas_recibidas: fojas };
  });
  const difiere = recibidas.some((c) => c.carpetas_recibidas !== c.carpetas || c.fojas_recibidas !== c.fojas);
  const notas = texto(datos.notas, 1000);
  exigir(!difiere || notas, 'Lo recibido no coincide con lo que salió: explica la diferencia antes de recibir.');

  enTransaccion(() => {
    const t = ahora();
    const contar = db.prepare('UPDATE traslado_cajas SET carpetas_recibidas = ?, fojas_recibidas = ? WHERE id = ?');
    const mover = db.prepare('UPDATE documentos SET sede_id = ? WHERE remision_id = ? AND caja = ?');
    for (const c of recibidas) {
      contar.run(c.carpetas_recibidas, c.fojas_recibidas, c.id);
      mover.run(traslado.destino_id, c.remision_id, c.caja);
    }
    db.prepare('UPDATE traslados SET estado = ?, recibido_por = ?, recibido_en = ?, notas_recepcion = ? WHERE id = ?')
      .run(difiere ? 'Recibido con diferencias' : 'Recibido', usuario, t, notas, traslado.id);
    const destino = nombresDeSedes().get(traslado.destino_id);
    for (const remisionId of new Set(recibidas.map((c) => c.remision_id))) {
      const propias = recibidas.filter((c) => c.remision_id === remisionId);
      registrarEvento(remisionId, 'Traslado',
        `Traslado ${traslado.id} recibido en ${destino}: caja${propias.length === 1 ? '' : 's'} ` +
        propias.map((c) => `${c.caja} (${c.carpetas_recibidas}/${c.carpetas} carpetas, ${c.fojas_recibidas}/${c.fojas} fojas)`).join(', ') +
        (difiere ? ` · CON DIFERENCIAS: ${notas}` : ''), usuario);
    }
  });
}

/** Traslados de una sede (o de todas): los que van hacia ella y los que salieron. */
export function listarTraslados(sedeId) {
  const sedes = nombresDeSedes();
  const filtro = sedeId === null ? '' : 'WHERE t.origen_id = ? OR t.destino_id = ?';
  const traslados = db.prepare(`SELECT t.* FROM traslados t ${filtro} ORDER BY t.id DESC LIMIT 100`)
    .all(...(sedeId === null ? [] : [sedeId, sedeId]));
  for (const t of traslados) {
    t.origen = sedes.get(t.origen_id);
    t.destino = sedes.get(t.destino_id);
    t.cajas = db.prepare(`SELECT tc.*, r.folio, r.dependencia FROM traslado_cajas tc
      JOIN remisiones r ON r.id = tc.remision_id WHERE tc.traslado_id = ? ORDER BY tc.id`).all(t.id);
  }
  return traslados;
}

/* ─────────────────────── listado de carpetas ─────────────────────────── */

/** Carpetas de los lotes indicados, con su etapa y dónde están, filtradas.
 *  escaneadas: [inicio, fin) en UTC para las carpetas escaneadas ese día. */
export function listarCarpetas(remisionIds, { situacion = '', etapa = '', q = '', responsable = '', escaneadas = null, conArchivo = false } = {}) {
  const busca = q.trim().toUpperCase();
  const salida = [];
  for (const id of remisionIds) {
    const r = remisionConCustodia(id);
    for (const d of r.documentos) {
      if (situacion && d.situacion !== situacion) continue;
      if (etapa && d.etapa !== etapa) continue;
      if (conArchivo && !d.archivo) continue;
      if (busca && ![d.nuc, d.descripcion, r.folio, r.dependencia].some((v) => String(v || '').toUpperCase().includes(busca))) continue;
      const escaneos = r.asignaciones.filter((a) => a.documento_id === d.id && a.cuadra
        && (!responsable || a.responsable === responsable)
        && (!escaneadas || (a.salida_en >= escaneadas[0] && a.salida_en < escaneadas[1])));
      if ((responsable || escaneadas) && !escaneos.length) continue;
      const ultimo = escaneos.at(-1);
      salida.push({
        id: d.id, remision_id: r.id, folio: r.folio, dependencia: r.dependencia, fecha: r.fecha, estado: r.estado,
        caja: d.caja, nuc: d.nuc, descripcion: d.descripcion, folio_inicial: d.folio_inicial, folio_final: d.folio_final,
        fojas: d.fojas, situacion: d.situacion, etapa: d.etapa, ubicacion: d.ubicacion, en_transito: d.en_transito,
        escaneo: ultimo ? { mesa: ultimo.mesa, responsable: ultimo.responsable, imagenes: ultimo.imagenes, en: ultimo.salida_en } : null,
        archivo: d.archivo ? { id: d.archivo.id, paginas: d.archivo.paginas, bytes: d.archivo.bytes, sha256: d.archivo.sha256,
                               subido_por: d.archivo.subido_por, subido_en: d.archivo.subido_en } : null
      });
      if (salida.length >= 2000) return salida;
    }
  }
  return salida;
}

/* ──────────────────── tablero de trabajo de digitalización ───────────── */

/** Todo lo pendiente de digitalizar de una sede (o de todas, si es null).
 *  Quien trabaja en una mesa solo ve lo que llegó a su mesa. */
export function trabajoDigitalizacion({ sedeId = null, mesaId = null } = {}) {
  const lotes = db.prepare(`
    SELECT id FROM remisiones
     WHERE eliminada_en = '' AND cancelada_en = '' AND estado IN ('Recibido', 'En digitalización', 'Digitalizado')
     ORDER BY fecha, id`).all().map((x) => remisionConCustodia(x.id));
  const deLaSede = (d) => sedeId === null || d.sede_id === sedeId;
  const sedes = nombresDeSedes();

  const sinValidar = [];
  const porAsignar = [];
  const enMesas = [];
  const cajasEnviables = [];
  for (const lote of lotes) {
    if (!lote.validada_en) {
      if (!mesaId && (sedeId === null || lote.sede_id === sedeId)) {
        sinValidar.push({ id: lote.id, folio: lote.folio, dependencia: lote.dependencia,
          fecha: lote.fecha, carpetas: lote.documentos.length, sede: sedes.get(lote.sede_id) });
      }
      continue;
    }
    const insertos = db.prepare('SELECT * FROM insertos WHERE remision_id = ?').all(lote.id);
    for (const d of lote.documentos) {
      if (d.en_transito || !deLaSede(d)) continue;
      const carpeta = {
        id: d.id, remision_id: lote.id, folio: lote.folio, dependencia: lote.dependencia,
        caja: d.caja, nuc: d.nuc, descripcion: d.descripcion, fojas: d.fojas,
        folio_inicial: d.folio_inicial, folio_final: d.folio_final, situacion: d.situacion,
        prep_en: d.prep_en, prep_por: d.prep_por, recoser_asignado: d.recoser_asignado,
        etapa: d.etapa, sede: d.sede, sede_id: d.sede_id
      };
      const ultima = lote.asignaciones.filter((a) => a.documento_id === d.id).at(-1);
      if (d.etapa === 'Por asignar') {
        if (!mesaId) porAsignar.push({ ...carpeta, reintento: Boolean(ultima) });
      } else if (d.etapa !== 'Recosida' && (!mesaId || ultima.mesa_id === mesaId)) {
        const propios = insertos.filter((i) => i.documento_id === d.id);
        enMesas.push({ ...carpeta, mesa_id: ultima.mesa_id, mesa: ultima.mesa, responsable: ultima.responsable,
          tiene_archivo: Boolean(d.archivo),
          desde: ultima.entrada_en, insertos: propios.length,
          por_reintegrar: propios.filter((i) => !i.reintegrado_en).length });
      }
    }
    // cajas que pueden salir de esta sede hacia otra
    if (!mesaId) {
      for (const caja of new Set(lote.documentos.map((d) => d.caja))) {
        try {
          const carpetas = cajaQueViaja(lote, caja);
          if (deLaSede(carpetas[0])) {
            cajasEnviables.push({ remision_id: lote.id, folio: lote.folio, dependencia: lote.dependencia, caja,
              carpetas: carpetas.length, fojas: carpetas.reduce((a, d) => a + d.fojas, 0),
              sede_id: carpetas[0].sede_id, sede: carpetas[0].sede,
              terminadas: carpetas.every((d) => d.etapa === 'Recosida') });
          }
        } catch (e) { if (!(e instanceof ErrorRegla)) throw e; }
      }
    }
  }
  const mesas = listarMesas().filter((m) => (mesaId ? m.id === mesaId : sedeId === null || m.sede_id === sedeId));
  return {
    sin_validar: sinValidar, por_asignar: porAsignar, en_mesas: enMesas, mesas,
    cajas_enviables: cajasEnviables,
    traslados: mesaId ? [] : listarTraslados(sedeId).filter((x) => x.estado === 'En tránsito')
  };
}
