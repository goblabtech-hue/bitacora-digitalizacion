/* ══════════════════════════════════════════════════════════════════════
   Reporte por periodo: qué se hizo en cada etapa del proceso entre dos fechas, con sus
   indicadores. Todo sale de lo ya registrado (quién, cuándo, cuánto); nada
   se captura aparte.

   Las horas se guardan en UTC. El día se mide en la hora local de quien
   consulta: el navegador manda su desfase y aquí se calcula el intervalo.
   ══════════════════════════════════════════════════════════════════════ */
import { db, sqlVivas } from './db.js';

/** Intervalo [inicio, fin) en UTC del día local pedido. */
/** Intervalo [inicio, fin) en UTC que cubre los días locales desde–hasta. */
export const rango = (desde, hasta, desfaseMin) => [intervalo(desde, desfaseMin)[0], intervalo(hasta, desfaseMin)[1]];

export function intervalo(fecha, desfaseMin) {
  const [a, m, d] = fecha.split('-').map(Number);
  const inicio = new Date(Date.UTC(a, m - 1, d) + desfaseMin * 60000);
  const fin = new Date(inicio.getTime() + 86400000);
  return [inicio.toISOString(), fin.toISOString()];
}

const minutos = (desde, hasta) => (new Date(hasta) - new Date(desde)) / 60000;
const promedio = (lista) => (lista.length ? lista.reduce((a, b) => a + b, 0) / lista.length : null);

/** Agrupa filas por una clave: cuenta cuántas hay (total) y suma lo que se
 *  le indique. */
function porClave(filas, clave, sumar) {
  const grupos = new Map();
  for (const f of filas) {
    const g = grupos.get(f[clave]) || { nombre: f[clave] || '—', total: 0 };
    g.total++;
    sumar?.(g, f);
    grupos.set(f[clave], g);
  }
  return [...grupos.values()].sort((a, b) => b.total - a.total);
}
const sumarA = (g, campo, valor) => { g[campo] = (g[campo] || 0) + valor; };

/** Con sedeId, solo lo que le corresponde a esa sede; con null, todo. */
export function reportePeriodo(desde, hasta, desfaseMin = 0, sedeId = null) {
  const [ini, fin] = rango(desde, hasta, desfaseMin);
  const VIVAS = sqlVivas(sedeId);
  /* El trabajo de mesa se cuenta en la sede de la mesa, aunque el lote se
     haya recibido en otra. sedeId es un entero de la propia base. */
  const deMesaDeLaSede = (alias) => (sedeId === null ? ''
    : ` AND ${alias}.mesa_id IN (SELECT id FROM mesas WHERE sede_id = ${Number(sedeId)})`);
  const carpetaEnLaSede = (alias) => (sedeId === null ? ''
    : ` AND EXISTS (SELECT 1 FROM asignaciones x JOIN mesas m ON m.id = x.mesa_id
                     WHERE x.documento_id = ${alias}.id AND m.sede_id = ${Number(sedeId)})`);
  const enDia = (campo) => `${campo} >= ? AND ${campo} < ?`;

  /* 1. Recepción: la fecha de la remisión ya es la fecha local de recepción */
  const recibidas = db.prepare(`
    SELECT r.id, r.folio, r.dependencia, r.recibe_nombre, r.cajas, r.carpetas,
           (SELECT COALESCE(SUM(fojas), 0) FROM documentos WHERE remision_id = r.id) AS fojas
      FROM remisiones r WHERE r.id IN (${VIVAS}) AND r.fecha BETWEEN ? AND ?`).all(desde, hasta);
  const recepcion = {
    lotes: recibidas.length,
    cajas: recibidas.reduce((a, r) => a + r.cajas, 0),
    carpetas: recibidas.reduce((a, r) => a + r.carpetas, 0),
    fojas: recibidas.reduce((a, r) => a + r.fojas, 0),
    canceladas: db.prepare(`SELECT COUNT(*) AS n FROM remisiones WHERE id IN (${VIVAS}) AND ${enDia('cancelada_en')}`).get(ini, fin).n,
    por_persona: porClave(recibidas, 'recibe_nombre', (g, r) => { sumarA(g, 'carpetas', r.carpetas); sumarA(g, 'fojas', r.fojas); }),
    lotes_detalle: recibidas.map(({ folio, dependencia, cajas, carpetas, fojas }) => ({ folio, dependencia, cajas, carpetas, fojas }))
  };

  /* 2. Validación: lotes contados contra lo asentado */
  const validadas = db.prepare(`
    SELECT r.id, r.folio, r.validada_por,
           (SELECT COUNT(*) FROM documentos d WHERE d.remision_id = r.id) AS carpetas,
           (SELECT COUNT(*) FROM documentos d WHERE d.remision_id = r.id
              AND (d.cantidad_verificada <> d.cantidad OR d.fojas_verificadas <> d.fojas)) AS con_diferencia
      FROM remisiones r WHERE r.id IN (${VIVAS}) AND ${enDia('r.validada_en')}`).all(ini, fin);
  const validacion = {
    lotes: validadas.length,
    carpetas: validadas.reduce((a, r) => a + r.carpetas, 0),
    con_diferencia: validadas.reduce((a, r) => a + r.con_diferencia, 0),
    por_persona: porClave(validadas, 'validada_por', (g, r) => { sumarA(g, 'carpetas', r.carpetas); })
  };

  /* 3. Asignación a mesas */
  const asignadas = db.prepare(`
    SELECT a.*, (SELECT COUNT(*) FROM asignaciones b WHERE b.documento_id = a.documento_id AND b.id < a.id) AS previas
      FROM asignaciones a WHERE a.remision_id IN (${VIVAS}) AND ${enDia('a.entrada_en')}${deMesaDeLaSede('a')}`).all(ini, fin);
  const asignacion = {
    carpetas: asignadas.length,
    reasignadas: asignadas.filter((a) => a.previas > 0).length,
    por_mesa: porClave(asignadas, 'mesa', (g, a) => { g.responsable = a.responsable; })
  };

  /* 4. Descosido y revisión, con los insertos retirados */
  const descosidas = db.prepare(`
    SELECT d.id, d.fojas, d.prep_por FROM documentos d
     WHERE d.remision_id IN (${VIVAS}) AND ${enDia('d.prep_en')}${carpetaEnLaSede('d')}`).all(ini, fin);
  const retirados = db.prepare(`
    SELECT tipo FROM insertos WHERE remision_id IN (${VIVAS}) AND ${enDia('retirado_en')}`).all(ini, fin);
  const descosido = {
    carpetas: descosidas.length,
    fojas: descosidas.reduce((a, d) => a + d.fojas, 0),
    insertos: retirados.length,
    insertos_por_tipo: porClave(retirados, 'tipo'),
    por_persona: porClave(descosidas, 'prep_por', (g, d) => { sumarA(g, 'fojas', d.fojas); })
  };

  /* 5. Escaneo: cada salida de una carpeta de su mesa */
  const escaneos = db.prepare(`
    SELECT a.*, d.fojas FROM asignaciones a JOIN documentos d ON d.id = a.documento_id
     WHERE a.remision_id IN (${VIVAS}) AND ${enDia('a.salida_en')}${deMesaDeLaSede('a')}`).all(ini, fin);
  const completos = escaneos.filter((e) => e.cuadra);
  const fojasEscaneadas = completos.reduce((a, e) => a + e.fojas_escaneadas, 0);
  const imagenes = completos.reduce((a, e) => a + e.imagenes, 0);
  const escaneo = {
    carpetas: completos.length,
    incompletos: escaneos.length - completos.length,
    // qué parte de los escaneos hubo que repetir: el indicador de calidad
    reproceso: escaneos.length ? (escaneos.length - completos.length) / escaneos.length : null,
    fojas: fojasEscaneadas,
    imagenes,
    imagenes_por_foja: fojasEscaneadas ? imagenes / fojasEscaneadas : null,
    minutos_en_mesa: promedio(completos.map((e) => minutos(e.entrada_en, e.salida_en))),
    por_mesa: porClave(escaneos, 'mesa', (g, e) => {
      g.responsable = e.responsable;
      sumarA(g, 'incompletos', e.cuadra ? 0 : 1);
      sumarA(g, 'fojas', e.cuadra ? e.fojas_escaneadas : 0);
      sumarA(g, 'imagenes', e.cuadra ? e.imagenes : 0);
    }),
    // quien registró cada escaneo: la producción de cada escaneador
    por_persona: porClave(escaneos, 'salida_por', (g, e) => {
      sumarA(g, 'incompletos', e.cuadra ? 0 : 1);
      sumarA(g, 'fojas', e.cuadra ? e.fojas_escaneadas : 0);
      sumarA(g, 'imagenes', e.cuadra ? e.imagenes : 0);
    })
  };

  /* 6. Reintegración de insertos y recosido */
  const recosidas = db.prepare(`
    SELECT d.id, d.recosido_por, d.recosido_en,
           (SELECT MIN(entrada_en) FROM asignaciones a WHERE a.documento_id = d.id) AS primera_mesa
      FROM documentos d WHERE d.remision_id IN (${VIVAS}) AND ${enDia('d.recosido_en')}${carpetaEnLaSede('d')}`).all(ini, fin);
  const recosido = {
    carpetas: recosidas.length,
    insertos_reintegrados: db.prepare(`SELECT COUNT(*) AS n FROM insertos
      WHERE remision_id IN (${VIVAS}) AND ${enDia('reintegrado_en')}`).get(ini, fin).n,
    // de la llegada a la mesa a quedar terminada
    horas_de_ciclo: promedio(recosidas.filter((d) => d.primera_mesa)
      .map((d) => minutos(d.primera_mesa, d.recosido_en) / 60)),
    por_persona: porClave(recosidas, 'recosido_por')
  };

  /* 7. Devolución */
  const devueltas = db.prepare(`
    SELECT r.folio, r.dependencia, r.dev_aceptacion, r.carpetas, r.dev_archivos, r.cotejo_en,
           (SELECT COUNT(*) FROM documentos d WHERE d.remision_id = r.id AND
              (d.cantidad_devuelta <> d.cantidad OR d.fojas_devueltas <> d.fojas
               OR (d.situacion_devuelta IS NOT NULL AND d.situacion_devuelta <> d.situacion))) AS con_diferencia
      FROM remisiones r WHERE r.id IN (${VIVAS}) AND r.dev_fecha BETWEEN ? AND ?`).all(desde, hasta);
  const devolucion = {
    lotes: devueltas.length,
    carpetas: devueltas.reduce((a, r) => a + r.carpetas, 0),
    imagenes_entregadas: devueltas.reduce((a, r) => a + r.dev_archivos, 0),
    aceptadas: devueltas.filter((r) => r.dev_aceptacion === 'Aceptado').length,
    con_observaciones: devueltas.filter((r) => r.dev_aceptacion === 'Aceptado con observaciones').length,
    rechazadas: devueltas.filter((r) => r.dev_aceptacion === 'Rechazado').length,
    carpetas_con_diferencia: devueltas.reduce((a, r) => a + r.con_diferencia, 0),
    lotes_detalle: devueltas.map(({ folio, dependencia, carpetas, dev_aceptacion }) => ({ folio, dependencia, carpetas, aceptacion: dev_aceptacion }))
  };

  /* 8. Incidencias */
  const reportadas = db.prepare(`SELECT tipo, gravedad FROM incidencias
    WHERE remision_id IN (${VIVAS}) AND ${enDia('reportada_en')}`).all(ini, fin);
  const incidencias = {
    reportadas: reportadas.length,
    altas: reportadas.filter((i) => i.gravedad === 'Alta').length,
    resueltas: db.prepare(`SELECT COUNT(*) AS n FROM incidencias WHERE remision_id IN (${VIVAS}) AND ${enDia('resuelta_en')}`).get(ini, fin).n,
    anuladas: db.prepare(`SELECT COUNT(*) AS n FROM incidencias WHERE remision_id IN (${VIVAS}) AND ${enDia('anulada_en')}`).get(ini, fin).n,
    abiertas_hoy: db.prepare(`SELECT COUNT(*) AS n FROM incidencias WHERE estado = 'Abierta' AND anulada_en = ''
      AND remision_id IN (${VIVAS})`).get().n,
    por_tipo: porClave(reportadas, 'tipo')
  };

  return { desde, hasta, recepcion, validacion, asignacion, descosido, escaneo, recosido, devolucion, incidencias };
}
