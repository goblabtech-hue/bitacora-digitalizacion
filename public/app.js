/* ══════════════════════ Bitácora de digitalización ══════════════════════ */

const $  = (s, ctx = document) => ctx.querySelector(s);
const $$ = (s, ctx = document) => [...ctx.querySelectorAll(s)];

const estado = {
  vista: 'panel',
  usuario: '',
  entregas: [],
  filtroEntregas: 'pendientes',
  sesion: { sso: false, prueba: false, acceso: false, cuentas_prueba: [], usuario: null },
  seccionDetalle: 'resumen',
  editando: null,
  remisionActual: null,
  config: { organizacion: '', leyenda_acuse: '' },
  catalogos: { estados: [], situaciones: [] },
  filtros: { q: '', estado: '', desde: '', hasta: '', eliminadas: '' }
};

/* ───────────────────────────── utilidades ───────────────────────────── */

const num = (n) => Number(n || 0).toLocaleString('es-MX');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clase = (s) => String(s || '').toLowerCase()
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z]+/g, '-');

function fechaLarga(iso) {
  if (!iso) return '';
  const [a, m, d] = iso.split('-').map(Number);
  return new Date(a, m - 1, d).toLocaleDateString('es-MX',
    { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
}
const fechaHora = (iso) => (iso ? new Date(iso).toLocaleString('es-MX',
  { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—');

function fechaCorta(iso) {
  if (!iso) return '';
  const [a, m, d] = iso.split('-').map(Number);
  return new Date(a, m - 1, d).toLocaleDateString('es-MX', { day: '2-digit', month: 'short', year: 'numeric' });
}

async function api(ruta, opciones = {}) {
  const res = await fetch(ruta, {
    ...opciones,
    headers: {
      'Content-Type': 'application/json',
      ...(opciones.headers || {})
    }
  });
  const datos = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((datos.errores || [datos.error || 'Error inesperado']).join('\n'));
  return datos;
}

let toastTimer;
function aviso(mensaje, tipo = '') {
  const t = $('#toast');
  t.textContent = mensaje;
  t.className = `toast ${tipo}`;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, tipo === 'error' ? 5200 : 2800);
}

/* ───────────────────────────── navegación ───────────────────────────── */

/* Cada vista pertenece a una sección; el menú solo muestra las permitidas. */
const SECCION_DE_VISTA = {
  panel: 'panel', recepcion: 'recepcion', digitalizacion: 'digitalizacion', entregas: 'devueltas',
  personal: 'personal', bitacora: 'bitacora', reporte: 'reporte', listado: 'panel', expedientes: 'expedientes'
};
const puede = (seccion) => (estado.sesion.usuario?.permisos || []).includes(seccion);

function aplicarPermisos() {
  $$('.nav-item').forEach((b) => { b.hidden = !puede(SECCION_DE_VISTA[b.dataset.vista]); });
  $$('[data-ir]').forEach((b) => { b.hidden = !puede(SECCION_DE_VISTA[b.dataset.ir]); });
}
const primeraVista = () => Object.keys(SECCION_DE_VISTA).filter((v) => v !== 'listado')
  .find((v) => puede(SECCION_DE_VISTA[v])) || 'panel';

function irA(vista) {
  if (!puede(SECCION_DE_VISTA[vista])) return;
  estado.vista = vista;
  $$('.vista').forEach((v) => v.classList.toggle('is-active', v.id === `vista-${vista}`));
  $$('.nav-item').forEach((b) => b.classList.toggle('is-active', b.dataset.vista === vista));
  window.scrollTo({ top: 0 });
  if (vista === 'panel') cargarPanel();
  if (vista === 'bitacora') cargarBitacora();
  if (vista === 'personal') cargarPersonal();
  if (vista === 'entregas') cargarEntregas();
  if (vista === 'digitalizacion') cargarDigitalizacion();
  if (vista === 'reporte') cargarReporte();
  if (vista === 'listado') cargarListado();
  if (vista === 'expedientes') cargarExpedientes();
}

$$('.nav-item').forEach((b) => b.addEventListener('click', () => irA(b.dataset.vista)));
$$('[data-ir]').forEach((b) => b.addEventListener('click', () => {
  if (b.dataset.ir === 'recepcion') nuevaRemision();
  irA(b.dataset.ir);
}));

/* ────────────────────────────── catálogos ───────────────────────────── */

async function cargarCatalogos() {
  const c = await api('/api/sugerencias');
  estado.catalogos = c;

  const llenar = (id, valores) => {
    $(id).innerHTML = valores.map((v) => `<option value="${esc(v)}"></option>`).join('');
  };
  llenar('#lista-dependencias', c.dependencias);
  llenar('#lista-areas', c.areas);
  llenar('#lista-entregan', c.entregan);
  llenar('#lista-reciben', c.reciben);
  llenar('#lista-cargos', c.cargos);
  llenar('#lista-tipos', c.tipos);
  // la sede de recepción: un supervisor la elige; los demás reciben en la suya
  const yo = estado.sesion.usuario || {};
  $('#sel-sede').innerHTML = (esSupervisor() ? '<option value="">Elige la sede…</option>' : '') +
    c.sedes.filter((s) => s.activa || s.id === yo.sede_id)
      .map((s) => `<option value="${s.id}">${esc(s.nombre)}</option>`).join('');
  if (yo.sede_id) $('#sel-sede').value = yo.sede_id;
  $('#sel-sede').disabled = !esSupervisor();

  llenarRecibe();
  // las eliminadas no aparecen en ninguna lista; solo un supervisor las consulta
  $('#f-estado').innerHTML = ['Todos', ...c.estados, ...(esSupervisor() ? ['Eliminadas'] : [])]
    .map((e, i) => `<button type="button" data-estado="${i ? esc(e) : ''}"${i ? '' : ' class="is-active"'}>${esc(e)}</button>`)
    .join('');
  $$('#f-estado button').forEach((b) => b.addEventListener('click', () => {
    $$('#f-estado button').forEach((x) => x.classList.remove('is-active'));
    b.classList.add('is-active');
    const eliminadas = b.dataset.estado === 'Eliminadas';
    estado.filtros.estado = eliminadas ? '' : b.dataset.estado;
    estado.filtros.eliminadas = eliminadas ? '1' : '';
    cargarBitacora();
  }));
}

/* ─────────────────────────────── panel ──────────────────────────────── */

async function cargarPanel() {
  const [s, recientes, dependencias, solicitudes] = await Promise.all([
    api(`/api/estadisticas?desde=${periodo().desde}&hasta=${periodo().hasta}&desfase=${desfaseLocal()}`),
    api('/api/remisiones'),
    api('/api/dependencias').catch(() => []),
    api('/api/solicitudes').catch(() => [])
  ]);
  estado.dependencias = dependencias;

  // un supervisor ve aquí lo que espera su decisión (salvo lo que él mismo pidió)
  const yo = estado.sesion.usuario.nombre;
  $('#card-solicitudes').hidden = !solicitudes.length;
  $('#panel-solicitudes').innerHTML = `<div class="lista">${solicitudes.map((x) => `
    <div class="lista-fila" style="align-items:flex-start">
      <div class="principal">
        <b>${esc(x.tipo)} · ${esc(x.folio)}</b> <span class="celda-sec">${esc(x.dependencia)}</span>
        <div class="secundario">${esc(x.motivo)}</div>
        <div class="secundario">Pidió ${esc(x.solicitada_por)} · ${fechaHora(x.solicitada_en)}</div>
      </div>
      <div style="white-space:nowrap">
        <button class="link-btn" data-ver="${x.remision_id}">Ver</button>
        ${x.solicitada_por === yo ? '<span class="celda-sec" style="margin-left:10px">la pediste tú</span>' : `
          <button class="link-btn" data-aprobar="${x.id}" style="margin-left:10px">Aprobar</button>
          <button class="link-btn" data-rechazar="${x.id}" style="color:var(--red);margin-left:10px">Rechazar</button>`}
      </div>
    </div>`).join('')}</div>`;
  $$('#panel-solicitudes [data-ver]').forEach((b) => b.addEventListener('click', () => abrirDetalle(b.dataset.ver, 'resumen')));
  $$('#panel-solicitudes [data-aprobar], #panel-solicitudes [data-rechazar]').forEach((b) =>
    b.addEventListener('click', () => resolverSolicitud(b.dataset.aprobar || b.dataset.rechazar,
      Boolean(b.dataset.aprobar), cargarPanel)));

  $('#fecha-hoy').textContent = fechaLarga(hoyLocal())
    .replace(/^./, (c) => c.toUpperCase());

  pintarPeriodo('#panel-periodo', cargarPanel);
  const p = periodo();
  $('#panel-produccion-periodo').textContent = p.largo;
  const enProceso = (s.porEstado.find((e) => e.estado === 'Recibido')?.total || 0) +
                    (s.porEstado.find((e) => e.estado === 'En digitalización')?.total || 0);

  $('#stats').innerHTML = [
    [`Recepciones ${p.corto}`, s.hoy.remisiones, `${num(s.hoy.documentos)} carpetas`],
    [`Fojas ${p.corto}`, s.hoy.fojas, p.clave === 'hoy' ? 'recibidas el día de hoy' : `recibidas ${p.largo}`],
    [`Imágenes ${p.corto}`, s.produccion.imagenes_hoy,
      s.produccion.capturas_abiertas
        ? `${num(s.produccion.capturas_abiertas)} carpeta${s.produccion.capturas_abiertas === 1 ? '' : 's'} en mesa`
        : 'ninguna carpeta en mesa'],
    ['Lotes en proceso', enProceso, 'pendientes de concluir'],
    ['Incidencias abiertas', s.incidencias.abiertas || 0, `${num(s.incidencias.total || 0)} en total`],
    ['Carpetas acumuladas', s.global.documentos, `${num(s.global.fojas)} fojas · ${num(s.produccion.imagenes)} imágenes`]
  ].map(([label, valor, pie], i) => `
    <button type="button" class="stat stat-enlace" data-destino="${i}">
      <div class="stat-label">${label}</div>
      <div class="stat-valor">${num(valor)}</div>
      <div class="stat-pie">${pie}</div>
    </button>`).join('');
  const recibidas = () => abrirListado({ tipo: 'carpetas', titulo: `Carpetas recibidas ${p.largo}`, desde: p.desde, hasta: p.hasta });
  const destinos = [
    recibidas,
    recibidas,
    () => abrirListado({ tipo: 'carpetas', titulo: `Carpetas escaneadas ${p.largo}`,
                         escaneadas_desde: p.desde, escaneadas_hasta: p.hasta }),
    () => irABitacora({ estado: 'en_proceso' }),
    () => abrirListado({ tipo: 'incidencias', titulo: 'Incidencias', estado: 'Abierta' }),
    () => abrirListado({ tipo: 'carpetas', titulo: 'Carpetas acumuladas' })
  ];
  $$('#stats [data-destino]').forEach((b) => b.addEventListener('click', destinos[Number(b.dataset.destino)]));

  const totalEstados = s.porEstado.reduce((a, e) => a + e.total, 0) || 1;
  $('#panel-estados').innerHTML = estado.catalogos.estados.map((e) => {
    const total = s.porEstado.find((x) => x.estado === e)?.total || 0;
    return `<button type="button" class="renglon-enlace" data-estado-lotes="${esc(e)}">
      <div class="lista-fila" style="padding:0;border:0">
        <span class="pill ${clase(e)}">${esc(e)}</span>
        <span class="cifra">${num(total)}</span>
      </div>
      <div class="barra"><i style="width:${(total / totalEstados * 100).toFixed(1)}%"></i></div>
    </button>`;
  }).join('');
  $$('#panel-estados [data-estado-lotes]').forEach((b) => b.addEventListener('click', () =>
    irABitacora({ estado: b.dataset.estadoLotes })));

  const maxSit = Math.max(1, ...s.porSituacion.map((x) => x.documentos));
  $('#panel-situacion').innerHTML = s.porSituacion.length
    ? s.porSituacion.map((x) => `
      <button type="button" class="renglon-enlace" data-situacion="${esc(x.situacion)}">
        <div class="lista-fila" style="padding:0;border:0">
          <span>${esc(x.situacion)}</span><span class="cifra">${num(x.documentos)}</span>
        </div>
        <div class="barra"><i style="width:${(x.documentos / maxSit * 100).toFixed(1)}%"></i></div>
      </button>`).join('')
    : '<p class="sub">Sin documentos registrados.</p>';
  $$('#panel-situacion [data-situacion]').forEach((b) => b.addEventListener('click', () =>
    abrirListado({ tipo: 'carpetas', titulo: `Carpetas en situación «${b.dataset.situacion}»`, situacion: b.dataset.situacion })));

  $('#panel-dependencias').innerHTML = s.porDependencia.length
    ? `<div class="lista">${s.porDependencia.map((d) => {
        const registro = dependencias.find((x) => x.nombre === d.dependencia);
        return `
        <div class="lista-fila">
          <button type="button" class="principal enlace-texto" data-dependencia="${esc(d.dependencia)}">
            <b>${esc(d.dependencia)}</b>
            <div class="secundario">${num(d.remisiones)} remisiones · ${num(d.documentos)} carpetas · ${num(d.fojas)} fojas</div>
          </button>
          ${registro ? `<button class="link-btn" data-tablero="${registro.id}">
            ${registro.activo ? 'Tablero' : 'Tablero desactivado'}</button>` : ''}
        </div>`; }).join('')}</div>`
    : vacio('Aún no hay dependencias registradas.');

  $$('#panel-dependencias [data-tablero]').forEach((b) => b.addEventListener('click', () =>
    compartirTablero(dependencias.find((x) => x.id === Number(b.dataset.tablero)))));
  $$('#panel-dependencias [data-dependencia]').forEach((b) => b.addEventListener('click', () =>
    irABitacora({ q: b.dataset.dependencia })));

  const maxOp = Math.max(1, ...s.porOperador.map((o) => o.imagenes));
  $('#panel-operadores').innerHTML = s.porOperador.length
    ? `<div class="lista">${s.porOperador.map((o) => `
        <div class="lista-fila">
          <button type="button" class="principal enlace-texto" data-responsable="${esc(o.operador)}">
            <b>${esc(o.operador)}</b>
            <div class="secundario">${num(o.sesiones)} carpeta${o.sesiones === 1 ? '' : 's'} escaneada${o.sesiones === 1 ? '' : 's'}</div>
            <div class="barra" style="width:180px"><i style="width:${(o.imagenes / maxOp * 100).toFixed(1)}%"></i></div>
          </button>
          <div class="cifra">${num(o.imagenes)} imágenes</div>
        </div>`).join('')}</div>`
    : vacio('Sin escaneos registrados', 'Aparecerá aquí cuando las mesas terminen de escanear carpetas.');

  $$('#panel-operadores [data-responsable]').forEach((b) => b.addEventListener('click', () =>
    abrirListado({ tipo: 'carpetas', titulo: `Carpetas escaneadas por ${b.dataset.responsable} · ${p.largo}`,
                   responsable: b.dataset.responsable, escaneadas_desde: p.desde, escaneadas_hasta: p.hasta })));

  $('#panel-recientes').innerHTML = tabla(recientes.slice(0, 6));
  enlazarFilas('#panel-recientes');
  cargarActividad();
  cargarRespaldos();
}

async function cargarActividad() {
  const eventos = await api('/api/eventos?limite=12');
  $('#panel-actividad').innerHTML = eventos.length
    ? `<div class="linea-tiempo">${eventos.map((e) => `
        <div class="evento${e.remision_id ? ' evento-enlace' : ''}"${e.remision_id ? ` data-lote="${e.remision_id}"` : ''}>
          <div class="evento-punto ${clase(e.tipo)}"></div>
          <div class="evento-cuerpo">
            <b>${esc(e.folio || 'Sin folio')} · ${esc(e.tipo)}</b>
            <div class="secundario">${esc(e.detalle)}</div>
            <div class="secundario">
              ${new Date(e.fecha).toLocaleString('es-MX', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}
              ${e.usuario ? ` · ${esc(e.usuario)}` : ''}
            </div>
          </div>
        </div>`).join('')}</div>`
    : vacio('Sin movimientos todavía');
  $$('#panel-actividad [data-lote]').forEach((e) => e.addEventListener('click', () => abrirDetalle(e.dataset.lote)));
}

async function cargarRespaldos() {
  try {
    const lista = await api('/api/respaldos');
    const ultimo = lista[0];
    const peso = (b) => `${(b / 1024).toFixed(0)} KB`;
    $('#panel-respaldo').innerHTML = ultimo
      ? `<div class="lista-fila" style="padding:0;border:0">
           <div class="principal">
             <b>Última copia: ${new Date(ultimo.creado_en).toLocaleString('es-MX',
                { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}</b>
             <div class="secundario">${esc(ultimo.archivo)} · ${peso(ultimo.bytes)}</div>
           </div>
           <div style="text-align:right;white-space:nowrap">
             <a class="link-btn" href="/api/respaldos/${encodeURIComponent(ultimo.archivo)}"
                download style="text-decoration:none">Descargar</a>
             <div class="secundario">${num(lista.length)} ${lista.length === 1 ? 'copia' : 'copias'}</div>
           </div>
         </div>
         <p class="sub" style="margin-top:10px">Se genera una copia automática cada día y se conservan
            las 30 más recientes. Descárgala de vez en cuando a un disco propio: es el respaldo que
            sobrevive a cualquier problema del servidor.</p>`
      : '<p class="sub">Todavía no hay copias de respaldo.</p>';
  } catch {
    $('#panel-respaldo').innerHTML = '<p class="sub">No se pudo consultar el respaldo.</p>';
  }
}

$('#btn-respaldar').addEventListener('click', async () => {
  try {
    const r = await api('/api/respaldos', { method: 'POST' });
    aviso(`Respaldo creado: ${r.archivo}`);
    cargarRespaldos();
  } catch (e) {
    aviso(e.message, 'error');
  }
});

/* ─────────────────────────────── ajustes ────────────────────────────── */

$('#usuario-actual').addEventListener('click', elegirUsuario);

$('#btn-ajustes').addEventListener('click', () => {
  abrirModal({
    titulo: 'Ajustes',
    cuerpo: `
      <div class="campos" style="grid-template-columns:1fr">
        <label class="campo">
          <span>Nombre de la organización</span>
          <input id="cfg-org" value="${esc(estado.config.organizacion)}" maxlength="120">
        </label>
        <label class="campo">
          <span>Prefijo del folio</span>
          <input id="cfg-prefijo" value="${esc(estado.config.folio_prefijo)}" maxlength="8"
                 style="text-transform:uppercase">
        </label>
        <label class="campo">
          <span>Leyenda del acuse</span>
          <textarea id="cfg-leyenda" rows="3" maxlength="300">${esc(estado.config.leyenda_acuse)}</textarea>
        </label>
      </div>
      <p class="sub" style="margin:6px 0 4px">
        El nombre y la leyenda aparecen en los acuses y las etiquetas impresas.
        El prefijo forma el folio (${esc(estado.config.folio_prefijo)}-${new Date().getFullYear()}-0001);
        solo letras y números. Si lo cambias, la numeración empieza de nuevo en esa serie
        y los folios ya emitidos se conservan como están.
        ${esSupervisor() ? 'Cada cambio queda en el historial.' : '<b>Solo un supervisor puede cambiarlos.</b>'}
      </p>
      <div class="acciones-detalle" style="margin-top:14px">
        <button type="button" class="btn" id="cfg-personas">Personas del equipo</button>
      </div>`,
    botones: [
      { texto: 'Cancelar', accion: cerrarModal },
      ...(esSupervisor() ? [{ texto: 'Guardar', clase: 'btn btn-primary', accion: async () => {
        try {
          estado.config = await api('/api/config', {
            method: 'PUT',
            body: JSON.stringify({
              organizacion: $('#cfg-org').value,
              folio_prefijo: $('#cfg-prefijo').value,
              leyenda_acuse: $('#cfg-leyenda').value
            })
          });
          cerrarModal();
          aviso('Ajustes guardados.');
        } catch (e) { aviso(e.message, 'error'); }
      } }] : [])
    ]
  });
  $('#cfg-personas').addEventListener('click', elegirUsuario);
});

const vacio = (msg, extra = '') =>
  `<div class="vacio"><strong>${esc(msg)}</strong>${extra ? `<span>${esc(extra)}</span>` : ''}</div>`;

/* ────────────────────────────── bitácora ────────────────────────────── */

function tabla(filas) {
  if (!filas.length) return vacio('Sin registros', 'Las recepciones que captures aparecerán aquí.');
  return `<table class="tabla">
    <thead><tr>
      <th>Folio</th><th>Fecha</th><th>Dependencia</th><th>Entrega / Recibe</th>
      <th class="num">Docs.</th><th class="num">Fojas</th><th>Estado</th>
    </tr></thead>
    <tbody>${filas.map((r) => `
      <tr data-id="${r.id}">
        <td class="folio">${esc(r.folio)}</td>
        <td>${fechaCorta(r.fecha)}<div class="celda-sec">${esc(r.hora || '')}</div></td>
        <td>${esc(r.dependencia)}<div class="celda-sec">${esc(r.area || '')}</div></td>
        <td>${esc(r.entrega_nombre)}<div class="celda-sec">recibe: ${esc(r.recibe_nombre)}</div></td>
        <td class="num">${num(r.total_documentos)}</td>
        <td class="num">${num(r.total_fojas)}</td>
        <td><span class="pill ${clase(r.estado)}">${esc(r.estado)}</span>
          ${r.incidencias_abiertas ? `<span class="pill alta" title="Incidencias abiertas"
            style="margin-left:5px">${num(r.incidencias_abiertas)}</span>` : ''}</td>
      </tr>`).join('')}
    </tbody></table>`;
}

function enlazarFilas(contenedor) {
  $$(`${contenedor} tbody tr`).forEach((tr) =>
    tr.addEventListener('click', () => abrirDetalle(tr.dataset.id)));
}

async function cargarBitacora() {
  const q = new URLSearchParams(Object.entries(estado.filtros).filter(([, v]) => v));
  const filas = await api(`/api/remisiones?${q}`);
  $('#tabla-remisiones').innerHTML = tabla(filas);
  enlazarFilas('#tabla-remisiones');
  const docs = filas.reduce((a, r) => a + r.total_documentos, 0);
  const fojas = filas.reduce((a, r) => a + r.total_fojas, 0);
  $('#bitacora-sub').textContent = filas.length
    ? `${num(filas.length)} remisiones · ${num(docs)} documentos · ${num(fojas)} fojas`
    : 'Historial de recepciones';
}

let debounce;
$('#f-q').addEventListener('input', (e) => {
  clearTimeout(debounce);
  estado.filtros.q = e.target.value.trim();
  debounce = setTimeout(cargarBitacora, 220);
});
$('#f-desde').addEventListener('change', (e) => { estado.filtros.desde = e.target.value; cargarBitacora(); });
$('#f-hasta').addEventListener('change', (e) => { estado.filtros.hasta = e.target.value; cargarBitacora(); });
$('#btn-limpiar').addEventListener('click', () => {
  estado.filtros = { q: '', estado: '', desde: '', hasta: '', eliminadas: '' };
  $('#f-q').value = ''; $('#f-desde').value = ''; $('#f-hasta').value = '';
  $$('#f-estado button').forEach((b, i) => b.classList.toggle('is-active', i === 0));
  cargarBitacora();
});
function exportarCSV() {
  const q = new URLSearchParams(Object.entries(estado.filtros).filter(([, v]) => v));
  window.location.href = `/api/exportar.csv?${q}`;
}
$('#btn-exportar').addEventListener('click', exportarCSV);
$('#btn-exportar-2').addEventListener('click', exportarCSV);

/* ── registrar la salida de un lote, con lo que se detecte al empacarlo ── */

async function registrarSalida(idPreseleccionado) {
  // solo sale un lote cuyas carpetas ya están todas recosidas y verificadas
  const pendientes = (estado.entregas || []).filter((r) => enResguardo(r) && !r.dev_fecha && terminado(r));
  if (!pendientes.length) {
    return aviso('No hay lotes listos para salir: un lote sale cuando todas sus carpetas están recosidas y verificadas.', 'error');
  }

  abrirModal({
    titulo: 'Registrar salida',
    cuerpo: `
      <label class="campo" style="margin-bottom:4px"><span>Lote que sale</span>
        <select id="s-lote">${pendientes.map((r) => `
          <option value="${r.id}"${String(r.id) === String(idPreseleccionado) ? ' selected' : ''}>
            ${esc(r.folio)} · ${esc(r.dependencia)} · ${num(r.cajas)} cajas
          </option>`).join('')}</select></label>
      <div id="s-detalle"><p class="sub">Cargando…</p></div>`,
    botones: [
      { texto: 'Cancelar', accion: cerrarModal },
      { texto: 'Registrar salida', clase: 'btn btn-primary', accion: guardar }
    ]
  });

  const pintar = async () => {
    const id = $('#s-lote').value;
    const r = await api(`/api/remisiones/${id}`);
    estado.loteSalida = r;
    const abiertas = r.incidencias.filter((i) => i.estado === 'Abierta');

    $('#s-detalle').innerHTML = `
      <div class="lista-fila" style="padding:12px 0;border-top:1px solid var(--separator);
           border-bottom:1px solid var(--separator);margin-bottom:16px">
        <div class="principal">
          <b>${num(r.cajas)} cajas · ${num(r.carpetas)} carpetas · ${num(r.total_fojas)} fojas</b>
          <div class="secundario">Recibido el ${fechaCorta(r.fecha)} · ${num(r.total_imagenes)} imágenes generadas</div>
        </div>
        <span class="pill ${clase(r.estado)}">${esc(r.estado)}</span>
      </div>

      ${r.incidencias.length ? `
        <div style="margin-bottom:16px">
          <span class="sub"><b>Incidencias del lote</b></span>
          ${r.incidencias.map((i) => `
            <div class="lista-fila" style="padding:7px 0;border-top:1px solid var(--separator)">
              <div class="principal">
                <b>${esc(i.tipo)}</b> <span class="pill ${clase(i.gravedad)}">${esc(i.gravedad)}</span>
                <div class="secundario">${esc(i.descripcion)}</div>
              </div>
              <span class="pill ${i.estado === 'Abierta' ? 'abierta' : 'digitalizado'}">${esc(i.estado)}</span>
            </div>`).join('')}
          ${abiertas.length ? `<p class="sub" style="margin-top:8px;color:var(--orange)">
            Este lote sale con ${num(abiertas.length)} incidencia${abiertas.length === 1 ? '' : 's'} sin resolver;
            quedan asentadas en el acuse de devolución.</p>` : ''}
        </div>`
      : '<p class="sub" style="margin-bottom:16px">Sin incidencias registradas durante el servicio.</p>'}

      ${formDevolucion(r)}

      <label class="campo" style="flex-direction:row;align-items:center;gap:9px;margin-top:16px">
        <input type="checkbox" id="s-hay-incidencia" style="width:auto">
        <span style="padding:0">Se detectó algo al preparar la salida</span>
      </label>
      <div id="s-incidencia" hidden>
        <div class="campos" style="grid-template-columns:2fr 1fr">
          <label class="campo" style="grid-column:span 1"><span>Tipo</span>
            <select id="s-tipo">${(estado.catalogos.tipos_incidencia || []).map((t) =>
              `<option>${esc(t)}</option>`).join('')}</select></label>
          <label class="campo" style="grid-column:span 1"><span>Gravedad</span>
            <select id="s-gravedad">${(estado.catalogos.gravedades || []).map((g) =>
              `<option${g === 'Media' ? ' selected' : ''}>${esc(g)}</option>`).join('')}</select></label>
          <label class="campo"><span>Qué se detectó</span>
            <textarea id="s-descripcion" rows="2"
              placeholder="Ej. una caja llegó con humedad, faltó un expediente al empacar…"></textarea></label>
        </div>
      </div>

      <p class="sub" style="margin-top:14px">
        Después de registrar la salida hay que <b>cotejar la devolución</b> caja por caja, confirmando
        que cada carpeta sale con sus fojas y en la misma situación en que se recibió; sin ese cotejo
        el acuse no se puede firmar. Al guardar te llevo directo ahí.
      </p>`;

    $('#s-hay-incidencia').addEventListener('change', (e) => {
      $('#s-incidencia').hidden = !e.target.checked;
    });
  };

  $('#s-lote').addEventListener('change', pintar);
  await pintar();

  async function guardar() {
    const id = $('#s-lote').value;

    // se comprueba todo antes de escribir nada: si falta la descripción,
    // la devolución tampoco debe quedar registrada
    const hayIncidencia = $('#s-hay-incidencia').checked;
    const descripcion = $('#s-descripcion').value.trim();
    if (hayIncidencia && !descripcion) {
      return aviso('Describe qué se detectó, o desmarca la casilla.', 'error');
    }

    try {
      await api(`/api/remisiones/${id}/devolucion`, {
        method: 'PUT', body: JSON.stringify(leerFormDevolucion())
      });

      if (hayIncidencia) {
        await api(`/api/remisiones/${id}/incidencias`, {
          method: 'POST',
          body: JSON.stringify({
            tipo: $('#s-tipo').value,
            gravedad: $('#s-gravedad').value,
            descripcion
          })
        });
      }

      cerrarModal();
      aviso('Salida registrada. Falta cotejar la devolución para poder firmar.');
      await cargarEntregas();
      abrirDetalle(id, 'devolucion');
    } catch (e) {
      aviso(e.message, 'error');
    }
  }
}

$('#btn-salida').addEventListener('click', () => registrarSalida());

/* ══════════════════ tablero de la dependencia ══════════════════ */

function enlaceTablero(d) {
  return `${location.origin}/tablero/${d.llave}`;
}

function compartirTablero(d) {
  if (!d) return;
  const url = enlaceTablero(d);
  abrirModal({
    titulo: `Tablero de ${d.nombre}`,
    cuerpo: `
      <p class="sub" style="margin-bottom:14px">
        Con este enlace la dependencia consulta el avance de <b>sus</b> documentos: qué día se
        recibió cada lote, cuántos documentos y fojas, en qué estado va y qué incidencias hay.
        Es de solo lectura y no requiere cuenta.
      </p>
      <label class="campo"><span>Enlace</span>
        <input id="t-url" readonly value="${esc(url)}"></label>
      <p class="sub" style="margin-top:12px">
        Quien tenga el enlace puede ver el tablero, así que compártelo solo con la dependencia.
        Si se filtra, genera uno nuevo: el anterior deja de funcionar en el momento.
        ${d.activo ? '' : '<br><b>Este tablero está desactivado; el enlace no abre.</b>'}
      </p>`,
    botones: [
      { texto: 'Generar enlace nuevo', accion: async () => {
        if (!confirm('El enlace actual dejará de funcionar. ¿Continuar?')) return;
        try {
          const nuevo = await api(`/api/dependencias/${d.id}`, { method: 'POST' });
          aviso('Enlace regenerado.');
          cargarPanel();
          compartirTablero(nuevo);
        } catch (e) { aviso(e.message, 'error'); }
      } },
      { texto: d.activo ? 'Desactivar' : 'Activar', clase: 'btn btn-danger', accion: async () => {
        try {
          const nuevo = await api(`/api/dependencias/${d.id}`, {
            method: 'PATCH', body: JSON.stringify({ activo: !d.activo })
          });
          aviso(nuevo.activo ? 'Tablero activado.' : 'Tablero desactivado.');
          cargarPanel();
          compartirTablero(nuevo);
        } catch (e) { aviso(e.message, 'error'); }
      } },
      { texto: 'Copiar enlace', clase: 'btn btn-primary', accion: async () => {
        const campo = $('#t-url');
        campo.select();
        try {
          await navigator.clipboard.writeText(campo.value);
          aviso('Enlace copiado.');
        } catch {
          // sin portapapeles (pasa fuera de https): queda seleccionado para copiar a mano
          aviso('Selecciona y copia el enlace con ⌘C.');
        }
      } }
    ]
  });
}

/* ═══════════════════════ expedientes digitales ═════════════════════ */

const tamano = (bytes) => (bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);

/** ¿Puede esta persona abrir el PDF de esta carpeta? */
function puedeAbrirPdf(d) {
  const yo = estado.sesion.usuario;
  return puede('expedientes') || (yo.rol === 'Mesa' && d.mesa_id === yo.mesa_id);
}

/** Enlace para abrir un PDF en otra pestaña; la consulta queda registrada. */
const enlacePdf = (archivoId, texto = 'Abrir PDF') =>
  `<a class="link-btn" href="/api/archivos/${archivoId}" target="_blank" rel="noopener">${texto}</a>`;

/** Sube el PDF tal cual, sin cargarlo en la página: puede pesar cientos de MB. */
async function subirPdf(remisionId, carpetaId, archivo, motivo = '') {
  const q = new URLSearchParams({ nombre: archivo.name, ...(motivo ? { motivo } : {}) });
  const res = await fetch(`/api/remisiones/${remisionId}/carpetas/${carpetaId}/archivo?${q}`, {
    method: 'POST', headers: { 'Content-Type': 'application/pdf' }, body: archivo
  });
  const datos = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((datos.errores || [datos.error || 'No se pudo subir el PDF.']).join(' '));
  return datos;
}

function ventanaSubirPdf(r, d, alTerminar) {
  const reemplazo = Boolean(d.archivo);
  const escaneo = r.asignaciones.filter((a) => a.documento_id === d.id && a.cuadra).at(-1);
  abrirModal({
    titulo: `${reemplazo ? 'Reemplazar' : 'Subir'} PDF · ${d.nuc || d.descripcion}`,
    cuerpo: `
      <p class="sub" style="margin-bottom:12px">Un solo PDF con todas las hojas de la carpeta, en orden.
        ${escaneo ? `Debe tener <b>${num(escaneo.imagenes)} páginas</b>, las imágenes que se reportaron en el escaneo.` : ''}</p>
      <label class="campo"><span>Archivo PDF</span><input type="file" id="pdf-archivo" accept="application/pdf,.pdf"></label>
      ${reemplazo ? `<p class="sub" style="margin-top:12px">Ya tiene un PDF de ${num(d.archivo.paginas)} páginas, subido por
          ${esc(d.archivo.subido_por)} el ${fechaHora(d.archivo.subido_en)}. No se borra: queda como versión anterior.</p>
        <label class="campo" style="margin-top:10px"><span>Motivo del reemplazo</span>
          <textarea id="pdf-motivo" rows="2" placeholder="Ej. se volvió a escanear con mejor resolución"></textarea></label>` : ''}
      <p class="sub" id="pdf-estado" style="margin-top:10px"></p>`,
    botones: [
      { texto: 'Cancelar', accion: cerrarModal },
      { texto: reemplazo ? 'Reemplazar' : 'Subir', clase: 'btn btn-primary', accion: async (e) => {
        const archivo = $('#pdf-archivo').files[0];
        if (!archivo) return aviso('Elige el PDF de la carpeta.', 'error');
        e.target.disabled = true;
        $('#pdf-estado').textContent = `Subiendo ${tamano(archivo.size)}…`;
        try {
          await subirPdf(r.id, d.id, archivo, $('#pdf-motivo')?.value.trim() || '');
          cerrarModal();
          aviso('PDF guardado.');
          alTerminar();
        } catch (err) {
          $('#pdf-estado').textContent = '';
          e.target.disabled = false;
          aviso(err.message, 'error');
        }
      } }
    ]
  });
}

async function cargarExpedientes() {
  const q = $('#exp-q').value.trim();
  const carpetas = await api(`/api/carpetas?con_archivo=1${q ? `&q=${encodeURIComponent(q)}` : ''}`);
  $('#exp-sub').textContent = `${num(carpetas.length)} carpeta${carpetas.length === 1 ? '' : 's'} digitalizada${carpetas.length === 1 ? '' : 's'} · ` +
    `${tamano(carpetas.reduce((a, c) => a + c.archivo.bytes, 0))}`;
  $('#exp-cuerpo').innerHTML = carpetas.length ? `
    <table class="tabla">
      <thead><tr><th>Carpeta (NUC)</th><th>Lote</th><th class="num">Páginas</th><th class="num">Tamaño</th>
        <th>Subido</th><th>Huella SHA-256</th><th></th></tr></thead>
      <tbody>${carpetas.map((c) => `
        <tr style="cursor:default">
          <td>${nombreCarpeta(c)}<div class="celda-sec">caja ${num(c.caja)} · ${foliosDe(c)} · ${num(c.fojas)} fojas</div></td>
          <td class="folio"><button class="link-btn" data-lote="${c.remision_id}">${esc(c.folio)}</button>
            <div class="celda-sec">${esc(c.dependencia)}</div></td>
          <td class="num">${num(c.archivo.paginas)}</td>
          <td class="num">${tamano(c.archivo.bytes)}</td>
          <td>${esc(c.archivo.subido_por)}<div class="celda-sec">${fechaHora(c.archivo.subido_en)}</div></td>
          <td><code class="huella" title="${esc(c.archivo.sha256)}">${esc(c.archivo.sha256.slice(0, 12))}…</code></td>
          <td style="white-space:nowrap;text-align:right">${enlacePdf(c.archivo.id)}
            ${esSupervisor() ? `<button class="link-btn" data-verificar="${c.archivo.id}" style="margin-left:10px">Verificar</button>` : ''}</td>
        </tr>`).join('')}</tbody>
    </table>` : vacio(q ? 'Sin resultados' : 'Todavía no hay expedientes digitales',
      q ? 'Prueba con otro NUC o folio.' : 'Aparecen aquí cuando las mesas suben el PDF de cada carpeta escaneada.');
  $$('#exp-cuerpo [data-lote]').forEach((b) => b.addEventListener('click', () => abrirDetalle(b.dataset.lote, 'digitalizacion')));
  // recalcula la huella del archivo guardado y la compara con la registrada al subirlo
  $$('#exp-cuerpo [data-verificar]').forEach((b) => b.addEventListener('click', async () => {
    b.disabled = true;
    try {
      const v = await api(`/api/archivos/${b.dataset.verificar}/verificacion`);
      aviso(v.ok ? 'El archivo está íntegro: su huella coincide con la registrada.' : v.motivo, v.ok ? '' : 'error');
    } catch (e) { aviso(e.message, 'error'); }
    b.disabled = false;
  }));
}
let esperaExpedientes;
$('#exp-q').addEventListener('input', () => { clearTimeout(esperaExpedientes); esperaExpedientes = setTimeout(cargarExpedientes, 300); });

/* ═══════════════════════ listados desde el Panel ════════════════════ */

/** Lleva a la Bitácora con un filtro puesto (estado o búsqueda). */
function irABitacora({ estado: estadoLote = '', q = '' }) {
  estado.filtros = { q, estado: estadoLote, desde: '', hasta: '', eliminadas: '' };
  $('#f-q').value = q;
  $$('#f-estado button').forEach((b) => b.classList.toggle('is-active', b.dataset.estado === estadoLote));
  irA('bitacora');
  if (estadoLote === 'en_proceso') $('#bitacora-sub').textContent = 'Lotes en proceso: recibidos o en digitalización';
}

function abrirListado(listado) {
  estado.listado = listado;
  irA('listado');
}

async function cargarListado() {
  const l = estado.listado || { tipo: 'carpetas', titulo: 'Carpetas acumuladas' };
  $('#listado-titulo').textContent = l.titulo;
  return l.tipo === 'incidencias' ? listadoIncidencias(l) : listadoCarpetas(l);
}

async function listadoCarpetas(l) {
  const opciones = (lista, actual, todas) => `<option value="">${todas}</option>` +
    lista.map((v) => `<option${v === actual ? ' selected' : ''}>${esc(v)}</option>`).join('');
  // los filtros que vienen del Panel se respetan y se pueden cambiar
  $('#listado-filtros').innerHTML = `
    <div class="buscador"><input type="search" id="l-q" placeholder="Buscar NUC, descripción, folio o dependencia" value="${esc(l.q || '')}"></div>
    <select id="l-situacion" aria-label="Situación">${opciones(estado.catalogos.situaciones || [], l.situacion, 'Todas las situaciones')}</select>
    <select id="l-etapa" aria-label="Etapa">${opciones(estado.catalogos.etapas || [], l.etapa, 'Todas las etapas')}</select>
    ${l.desde ? `<span class="pill">recibidas ${l.desde === l.hasta ? `el ${fechaCorta(l.desde)}`
        : `del ${fechaCorta(l.desde)} al ${fechaCorta(l.hasta)}`}</span>` : ''}
    ${l.escaneadas_desde ? `<span class="pill">escaneadas ${l.escaneadas_desde === l.escaneadas_hasta
        ? `el ${fechaCorta(l.escaneadas_desde)}` : `del ${fechaCorta(l.escaneadas_desde)} al ${fechaCorta(l.escaneadas_hasta)}`}</span>` : ''}`;
  const parametros = new URLSearchParams(Object.entries({
    desde: l.desde, hasta: l.hasta, escaneadas_desde: l.escaneadas_desde, escaneadas_hasta: l.escaneadas_hasta,
    situacion: l.situacion, etapa: l.etapa, q: l.q, responsable: l.responsable, desfase: desfaseLocal()
  }).filter(([, v]) => v !== undefined && v !== ''));
  const carpetas = await api(`/api/carpetas?${parametros}`);

  $('#listado-sub').textContent = `${num(carpetas.length)} carpeta${carpetas.length === 1 ? '' : 's'} · ` +
    `${num(carpetas.reduce((a, c) => a + c.fojas, 0))} fojas`;
  $('#listado-cuerpo').innerHTML = carpetas.length ? `
    <table class="tabla">
      <thead><tr><th>Lote</th><th>Carpeta (NUC)</th><th class="num">Caja</th><th>Folios</th>
        <th class="num">Fojas</th><th>Situación</th><th>Etapa</th><th>Dónde está</th></tr></thead>
      <tbody>${carpetas.map((c) => `
        <tr data-lote="${c.remision_id}">
          <td class="folio">${esc(c.folio)}<div class="celda-sec">${esc(c.dependencia)} · ${fechaCorta(c.fecha)}</div></td>
          <td>${nombreCarpeta(c)}</td>
          <td class="num">${num(c.caja)}</td>
          <td class="celda-sec">${foliosDe(c)}</td>
          <td class="num">${num(c.fojas)}</td>
          <td><span class="pill">${esc(c.situacion)}</span></td>
          <td><span class="pill etapa-${clase(c.etapa)}">${esc(c.etapa)}</span></td>
          <td>${esc(c.ubicacion)}${c.escaneo ? `<div class="celda-sec">escaneó ${esc(c.escaneo.responsable)} ·
            ${num(c.escaneo.imagenes)} imágenes</div>` : ''}</td>
        </tr>`).join('')}</tbody>
    </table>` : vacio('Sin carpetas', 'No hay carpetas con estos filtros.');
  $$('#listado-cuerpo tr[data-lote]').forEach((tr) => tr.addEventListener('click', () =>
    abrirDetalle(tr.dataset.lote, 'digitalizacion')));

  const refiltrar = () => {
    estado.listado = { ...l, q: $('#l-q').value.trim(), situacion: $('#l-situacion').value, etapa: $('#l-etapa').value };
    cargarListado();
  };
  let espera;
  $('#l-q').addEventListener('input', () => { clearTimeout(espera); espera = setTimeout(refiltrar, 300); });
  $('#l-situacion').addEventListener('change', refiltrar);
  $('#l-etapa').addEventListener('change', refiltrar);
}

async function listadoIncidencias(l) {
  $('#listado-filtros').innerHTML = `
    <div class="segmented" id="l-inc">
      <button type="button" data-estado="Abierta"${l.estado === 'Abierta' ? ' class="is-active"' : ''}>Abiertas</button>
      <button type="button" data-estado=""${l.estado ? '' : ' class="is-active"'}>Todas</button>
    </div>`;
  const incidencias = await api(`/api/incidencias${l.estado ? `?estado=${l.estado}` : ''}`);
  const una = incidencias.length === 1;
  $('#listado-sub').textContent = `${num(incidencias.length)} incidencia${una ? '' : 's'}` +
    (l.estado ? (una ? ' abierta' : ' abiertas') : '');
  $('#listado-cuerpo').innerHTML = incidencias.length ? `
    <table class="tabla">
      <thead><tr><th>Lote</th><th>Incidencia</th><th>Descripción</th><th>Reportó</th><th>Estado</th></tr></thead>
      <tbody>${incidencias.map((i) => `
        <tr data-lote="${i.remision_id}">
          <td class="folio">${esc(i.folio)}<div class="celda-sec">${esc(i.dependencia)}</div></td>
          <td>${esc(i.tipo)}<div><span class="pill ${clase(i.gravedad)}">${esc(i.gravedad)}</span></div></td>
          <td>${esc(i.descripcion)}${i.resolucion ? `<div class="celda-sec">Resolución: ${esc(i.resolucion)}</div>` : ''}</td>
          <td>${esc(i.reportada_por || '—')}<div class="celda-sec">${fechaHora(i.reportada_en)}</div></td>
          <td><span class="pill ${i.estado === 'Abierta' ? 'abierta' : 'digitalizado'}">${esc(i.estado)}</span></td>
        </tr>`).join('')}</tbody>
    </table>` : vacio(l.estado ? 'Sin incidencias abiertas' : 'Sin incidencias', 'Todo en orden.');
  $$('#listado-cuerpo tr[data-lote]').forEach((tr) => tr.addEventListener('click', () =>
    abrirDetalle(tr.dataset.lote, 'incidencias')));
  $$('#l-inc button').forEach((b) => b.addEventListener('click', () => {
    estado.listado = { ...l, estado: b.dataset.estado, titulo: 'Incidencias' };
    cargarListado();
  }));
}

/* ═══════════════════════ periodo del Panel y del Reporte ════════════ */

/* Lo mismo para el Panel y el Reporte: al cambiar en uno, cambia en el otro. */
const PERIODOS = [
  ['hoy', 'Hoy', 0], ['3d', 'Últimos 3 días', 2], ['7d', 'Última semana', 6],
  ['14d', 'Últimas 2 semanas', 13], ['mes', 'Este mes', null], ['otro', 'Personalizado', null]
];
const fechaLocal = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** Fechas locales desde–hasta de un periodo, con su nombre corto y largo. */
function calcularPeriodo(clave, desde, hasta) {
  const hoy = new Date();
  const [, , dias] = PERIODOS.find(([c]) => c === clave) || PERIODOS[0];
  if (clave === 'otro') {
    const [a, b] = [desde || hoyLocal(), hasta || desde || hoyLocal()].sort();
    return { clave, desde: a, hasta: b, corto: 'del periodo',
             largo: a === b ? fechaCorta(a) : `del ${fechaCorta(a)} al ${fechaCorta(b)}` };
  }
  const inicio = clave === 'mes' ? new Date(hoy.getFullYear(), hoy.getMonth(), 1)
    : new Date(hoy.getFullYear(), hoy.getMonth(), hoy.getDate() - dias);
  const cortos = { hoy: 'hoy', '3d': 'en 3 días', '7d': 'en la semana', '14d': 'en 2 semanas', mes: 'del mes' };
  const largos = { hoy: 'hoy', '3d': 'en los últimos 3 días', '7d': 'en la última semana',
                   '14d': 'en las últimas 2 semanas', mes: 'en este mes' };
  return { clave, desde: fechaLocal(inicio), hasta: hoyLocal(), corto: cortos[clave], largo: largos[clave] };
}
estado.periodo = null;
const periodo = () => (estado.periodo ||= calcularPeriodo('hoy'));
const desfaseLocal = () => new Date().getTimezoneOffset();

/** Dibuja el selector en un contenedor y avisa cuando cambia. */
function pintarPeriodo(contenedor, alCambiar) {
  const p = periodo();
  $(contenedor).innerHTML = `
    <div class="segmented">${PERIODOS.map(([clave, nombre]) => `
      <button type="button" data-periodo="${clave}"${clave === p.clave ? ' class="is-active"' : ''}>${nombre}</button>`).join('')}
    </div>
    ${p.clave === 'otro' ? `
      <div class="filtros-fecha">
        <input type="date" class="p-desde" aria-label="Desde" value="${p.desde}" max="${hoyLocal()}">
        <span>—</span>
        <input type="date" class="p-hasta" aria-label="Hasta" value="${p.hasta}" max="${hoyLocal()}">
      </div>` : `<span class="celda-sec">${p.desde === p.hasta ? fechaCorta(p.desde) : `${fechaCorta(p.desde)} – ${fechaCorta(p.hasta)}`}</span>`}`;
  $$(`${contenedor} [data-periodo]`).forEach((b) => b.addEventListener('click', () => {
    estado.periodo = calcularPeriodo(b.dataset.periodo, periodo().desde, periodo().hasta);
    alCambiar();
  }));
  $$(`${contenedor} .p-desde, ${contenedor} .p-hasta`).forEach((i) => i.addEventListener('change', () => {
    estado.periodo = calcularPeriodo('otro', $(`${contenedor} .p-desde`).value, $(`${contenedor} .p-hasta`).value);
    alCambiar();
  }));
}

/* ═══════════════════════════ reporte diario ════════════════════════ */

/** Fecha local de hoy (YYYY-MM-DD); toISOString daría la de Greenwich. */
const hoyLocal = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const formato = {
  pct: (v) => (v === null ? '—' : `${(v * 100).toFixed(1)} %`),
  dec: (v) => (v === null ? '—' : v.toFixed(2)),
  min: (v) => (v === null ? '—' : formatoMinutos(v)),
  horas: (v) => (v === null ? '—' : v < 1 ? formatoMinutos(v * 60) : `${v.toFixed(1)} h`)
};
function formatoMinutos(m) {
  const t = Math.round(m);
  return t < 60 ? `${t} min` : `${Math.floor(t / 60)} h ${t % 60} min`;
}

/* Cada etapa con sus indicadores y sus desgloses. De aquí salen la vista y
   la versión impresa, así que siempre dicen lo mismo. */
function etapasDelReporte(x) {
  return [
    { titulo: '1. Recepción', cifras: [
        ['Lotes recibidos', num(x.recepcion.lotes)], ['Cajas', num(x.recepcion.cajas)],
        ['Carpetas', num(x.recepcion.carpetas)], ['Fojas', num(x.recepcion.fojas)],
        ['Recepciones canceladas', num(x.recepcion.canceladas)]],
      tablas: [
        { titulo: 'Lotes', filas: x.recepcion.lotes_detalle, columnas: [['folio', 'Folio'], ['dependencia', 'Dependencia'],
          ['cajas', 'Cajas', 1], ['carpetas', 'Carpetas', 1], ['fojas', 'Fojas', 1]] },
        { titulo: 'Por quién recibió', filas: x.recepcion.por_persona, columnas: [['nombre', 'Persona'],
          ['total', 'Lotes', 1], ['carpetas', 'Carpetas', 1], ['fojas', 'Fojas', 1]] }] },
    { titulo: '2. Validación de la recepción', cifras: [
        ['Lotes validados', num(x.validacion.lotes)], ['Carpetas contadas', num(x.validacion.carpetas)],
        ['Carpetas con diferencia', num(x.validacion.con_diferencia), x.validacion.con_diferencia > 0]],
      tablas: [{ titulo: 'Por quién validó', filas: x.validacion.por_persona,
        columnas: [['nombre', 'Persona'], ['total', 'Lotes', 1], ['carpetas', 'Carpetas', 1]] }] },
    { titulo: '3. Asignación a mesas', cifras: [
        ['Carpetas asignadas', num(x.asignacion.carpetas)],
        ['Reasignadas (volvieron a mesa)', num(x.asignacion.reasignadas), x.asignacion.reasignadas > 0]],
      tablas: [{ titulo: 'Por mesa', filas: x.asignacion.por_mesa,
        columnas: [['nombre', 'Mesa'], ['responsable', 'Responsable'], ['total', 'Carpetas', 1]] }] },
    { titulo: '4. Descosido y revisión', cifras: [
        ['Carpetas descosidas', num(x.descosido.carpetas)], ['Fojas revisadas', num(x.descosido.fojas)],
        ['Insertos retirados', num(x.descosido.insertos)]],
      tablas: [
        { titulo: 'Por persona', filas: x.descosido.por_persona,
          columnas: [['nombre', 'Persona'], ['total', 'Carpetas', 1], ['fojas', 'Fojas', 1]] },
        { titulo: 'Insertos por tipo', filas: x.descosido.insertos_por_tipo, columnas: [['nombre', 'Tipo'], ['total', 'Retirados', 1]] }] },
    { titulo: '5. Escaneo', cifras: [
        ['Carpetas escaneadas', num(x.escaneo.carpetas)], ['Fojas escaneadas', num(x.escaneo.fojas)],
        ['Imágenes', num(x.escaneo.imagenes)], ['Imágenes por foja', formato.dec(x.escaneo.imagenes_por_foja)],
        ['Escaneos incompletos', num(x.escaneo.incompletos), x.escaneo.incompletos > 0],
        ['Reproceso', formato.pct(x.escaneo.reproceso), x.escaneo.reproceso > 0],
        ['Tiempo promedio en mesa', formato.min(x.escaneo.minutos_en_mesa)]],
      tablas: [{ titulo: 'Por mesa', filas: x.escaneo.por_mesa, columnas: [['nombre', 'Mesa'], ['responsable', 'Responsable'],
        ['total', 'Escaneos', 1], ['incompletos', 'Incompletos', 1], ['fojas', 'Fojas', 1], ['imagenes', 'Imágenes', 1]] }] },
    { titulo: '6. Reintegración y recosido', cifras: [
        ['Carpetas terminadas', num(x.recosido.carpetas)], ['Insertos reintegrados', num(x.recosido.insertos_reintegrados)],
        ['Ciclo promedio en mesa', formato.horas(x.recosido.horas_de_ciclo)]],
      tablas: [{ titulo: 'Por persona', filas: x.recosido.por_persona, columnas: [['nombre', 'Persona'], ['total', 'Carpetas', 1]] }] },
    { titulo: '7. Devolución', cifras: [
        ['Lotes devueltos', num(x.devolucion.lotes)], ['Carpetas', num(x.devolucion.carpetas)],
        ['Imágenes entregadas', num(x.devolucion.imagenes_entregadas)], ['Aceptadas', num(x.devolucion.aceptadas)],
        ['Con observaciones', num(x.devolucion.con_observaciones), x.devolucion.con_observaciones > 0],
        ['Rechazadas', num(x.devolucion.rechazadas), x.devolucion.rechazadas > 0],
        ['Carpetas con diferencia al cotejar', num(x.devolucion.carpetas_con_diferencia), x.devolucion.carpetas_con_diferencia > 0]],
      tablas: [{ titulo: 'Lotes', filas: x.devolucion.lotes_detalle, columnas: [['folio', 'Folio'], ['dependencia', 'Dependencia'],
        ['carpetas', 'Carpetas', 1], ['aceptacion', 'Aceptación']] }] },
    { titulo: '8. Incidencias', cifras: [
        ['Reportadas', num(x.incidencias.reportadas)], ['De gravedad alta', num(x.incidencias.altas), x.incidencias.altas > 0],
        ['Resueltas', num(x.incidencias.resueltas)], ['Anuladas', num(x.incidencias.anuladas)],
        ['Abiertas en total', num(x.incidencias.abiertas_hoy), x.incidencias.abiertas_hoy > 0]],
      tablas: [{ titulo: 'Por tipo', filas: x.incidencias.por_tipo, columnas: [['nombre', 'Tipo'], ['total', 'Reportadas', 1]] }] }
  ];
}

/** Una tabla de desglose; las columnas marcadas con 1 son numéricas. */
function tablaReporte({ titulo, filas, columnas }, clase = 'tabla') {
  if (!filas.length) return '';
  return `
    <p class="reporte-desglose">${esc(titulo)}</p>
    <table class="${clase}">
      <thead><tr>${columnas.map(([, n, numerica]) => `<th${numerica ? ' class="num"' : ''}>${esc(n)}</th>`).join('')}</tr></thead>
      <tbody>${filas.map((f) => `<tr style="cursor:default">${columnas.map(([c, , numerica]) =>
        `<td${numerica ? ' class="num"' : ''}>${numerica ? num(f[c]) : esc(f[c] ?? '—')}</td>`).join('')}</tr>`).join('')}</tbody>
    </table>`;
}

/** Nombre del periodo de un reporte, para la pantalla y el papel. */
const nombrePeriodo = (x) => (x.desde === x.hasta ? fechaLarga(x.desde)
  : `Del ${fechaLarga(x.desde)} al ${fechaLarga(x.hasta)}`).replace(/^./, (c) => c.toUpperCase());

async function cargarReporte() {
  pintarPeriodo('#reporte-periodo', cargarReporte);
  const p = periodo();
  const x = await api(`/api/reporte?desde=${p.desde}&hasta=${p.hasta}&desfase=${desfaseLocal()}`);
  estado.reporte = x;
  $('#reporte-sub').textContent = nombrePeriodo(x);
  $('#reporte-cuerpo').innerHTML = etapasDelReporte(x).map((e) => `
    <div class="card">
      <div class="card-head"><h2>${esc(e.titulo)}</h2></div>
      <div class="card-body">
        <div class="indicadores">${e.cifras.map(([etiqueta, valor, alerta]) => `
          <div class="indicador${alerta ? ' alerta' : ''}"><span>${esc(etiqueta)}</span><b>${esc(valor)}</b></div>`).join('')}</div>
      </div>
      ${e.tablas.some((tb) => tb.filas.length)
        ? `<div class="card-body no-pad">${e.tablas.map((tb) => tablaReporte(tb)).join('')}</div>` : ''}
    </div>`).join('');
}

$('#reporte-imprimir').addEventListener('click', () => {
  const x = estado.reporte;
  if (!x) return;
  imprimir(`
    <article class="doc">
      <header class="doc-cab"><div>
        <div class="org">${esc(estado.config.organizacion)}</div>
        <h1>Reporte de digitalización</h1>
        <div class="folio">${esc(nombrePeriodo(x))}</div>
      </div></header>
      ${etapasDelReporte(x).map((e) => `
        <h2 class="doc-h2">${esc(e.titulo)}</h2>
        <table><tbody>${e.cifras.map(([etiqueta, valor]) =>
          `<tr><td>${esc(etiqueta)}</td><td class="num"><b>${esc(valor)}</b></td></tr>`).join('')}</tbody></table>
        ${e.tablas.map((tb) => tablaReporte(tb, '')).join('')}`).join('')}
      <p class="doc-pie">Generado por ${esc(estado.sesion.usuario.nombre)} el ${new Date().toLocaleString('es-MX')}</p>
    </article>`);
});

/* ═══════════════════════════ digitalización ═══════════════════════ */

/* El proceso empieza asignando carpetas a una mesa; ahí se descosen, se
   revisan, se escanean y se vuelven a coser. Cada paso abre la misma
   ventana que en el detalle del lote. */
const SIGUIENTE_PASO = {
  'En mesa': ['Descoser y revisar', (r, d, cb) => prepararCarpeta(r, d, cb)],
  'Descosida': ['Registrar escaneo', (r, d, cb) => registrarEscaneo(r, d, cb)],
  'Escaneada': ['Reintegrar y recoser', (r, d, cb) => recoserCarpeta(r, d, cb)]
};

async function cargarDigitalizacion() {
  const t = await api('/api/digitalizacion');
  estado.trabajo = t;
  estado.catalogos.mesas = t.mesas;
  const cuenta = (e) => t.en_mesas.filter((c) => c.etapa === e).length;
  const yo = estado.sesion.usuario;

  $('#digi-sub').textContent = rol() === 'Mesa'
    ? `${yo.mesa} · ${yo.sede} · ${num(t.en_mesas.length)} carpeta${t.en_mesas.length === 1 ? '' : 's'} en tu mesa`
    : `${esSupervisor() ? 'Todas las sedes' : yo.sede} · ${num(t.por_asignar.length)} por asignar · ${num(t.en_mesas.length)} en las mesas`;
  pintarTraslados(t);
  $('#digi-stats').innerHTML = [
    ...(rol() === 'Mesa' ? [] : [['Por asignar', t.por_asignar.length, t.sin_validar.length
      ? `${num(t.sin_validar.length)} lote${t.sin_validar.length === 1 ? '' : 's'} sin validar` : 'esperan mesa']]),
    ['En mesa', cuenta('En mesa'), 'por descoser y revisar'],
    ['Descosidas', cuenta('Descosida'), 'por escanear'],
    ['Escaneadas', cuenta('Escaneada'), 'por reintegrar y recoser']
  ].map(([etiqueta, valor, pie]) => `
    <div class="stat"><div class="stat-label">${etiqueta}</div>
      <div class="stat-valor">${num(valor)}</div><div class="stat-pie">${pie}</div></div>`).join('');

  // un lote sin validar no puede empezar: se avisa y se lleva a validarlo
  $('#digi-sin-validar-card').hidden = !t.sin_validar.length;
  $('#digi-sin-validar').innerHTML = `<div class="lista">${t.sin_validar.map((l) => `
    <div class="lista-fila">
      <div class="principal"><b>${esc(l.folio)}</b> · ${esc(l.dependencia)}
        <div class="secundario">${num(l.carpetas)} carpeta${l.carpetas === 1 ? '' : 's'} · recibido ${fechaCorta(l.fecha)} ·
          hay que contarlo contra lo asentado antes de asignarlo a mesa</div></div>
      ${puede('recepcion') ? `<button class="link-btn" data-validar="${l.id}">Validar</button>`
                           : '<span class="celda-sec">lo valida Recepción</span>'}
    </div>`).join('')}</div>`;
  $$('#digi-sin-validar [data-validar]').forEach((b) =>
    b.addEventListener('click', () => abrirDetalle(b.dataset.validar, 'resumen')));

  pintarPorAsignar(t.por_asignar);
  pintarMesas(t);
}

function pintarPorAsignar(carpetas) {
  if (!carpetas.length) {
    $('#digi-por-asignar').innerHTML = vacio('Nada por asignar',
      'Las carpetas de los lotes validados aparecen aquí para asignarlas a una mesa.');
    $('#digi-todas').hidden = true;
    actualizarSeleccion();
    return;
  }
  $('#digi-todas').hidden = false;
  const lotes = [...new Set(carpetas.map((c) => c.remision_id))];
  $('#digi-por-asignar').innerHTML = `
    <table class="tabla">
      <thead><tr><th style="width:36px"></th><th>Carpeta (NUC)</th><th>Caja</th><th>Folios</th><th class="num">Fojas</th></tr></thead>
      <tbody>${lotes.map((id) => {
        const propias = carpetas.filter((c) => c.remision_id === id);
        return `
        <tr class="fila-caja"><td><input type="checkbox" class="sel-lote" data-lote="${id}" aria-label="Seleccionar el lote"></td>
          <td colspan="4"><b>${esc(propias[0].folio)}</b> · ${esc(propias[0].dependencia)} ·
            ${num(propias.length)} carpeta${propias.length === 1 ? '' : 's'}
            ${esSupervisor() ? `· <span class="pill">${esc(propias[0].sede)}</span>` : ''}</td></tr>
        ${propias.map((c) => `
          <tr style="cursor:default">
            <td><input type="checkbox" class="sel-carpeta" data-id="${c.id}" data-lote="${id}" aria-label="Seleccionar"></td>
            <td>${nombreCarpeta(c)}${c.reintento
              ? '<div class="celda-sec" style="color:var(--red)">escaneo incompleto: va de nuevo a mesa</div>' : ''}</td>
            <td class="celda-sec">${num(c.caja)}</td>
            <td class="celda-sec">${foliosDe(c)}</td>
            <td class="num">${num(c.fojas)}</td>
          </tr>`).join('')}`;
      }).join('')}
      </tbody>
    </table>`;

  $$('#digi-por-asignar .sel-lote').forEach((c) => c.addEventListener('change', () => {
    $$(`#digi-por-asignar .sel-carpeta[data-lote="${c.dataset.lote}"]`).forEach((x) => { x.checked = c.checked; });
    actualizarSeleccion();
  }));
  $$('#digi-por-asignar .sel-carpeta').forEach((c) => c.addEventListener('change', actualizarSeleccion));
  actualizarSeleccion();
}

function actualizarSeleccion() {
  const marcadas = $$('#digi-por-asignar .sel-carpeta:checked');
  const mesas = (estado.catalogos.mesas || []).filter((m) => m.activa && m.responsable);
  $('#digi-barra').hidden = !marcadas.length;
  $('#digi-seleccion').textContent = `${num(marcadas.length)} carpeta${marcadas.length === 1 ? '' : 's'} seleccionada${marcadas.length === 1 ? '' : 's'}`;
  const previa = $('#digi-mesa').value;
  $('#digi-mesa').innerHTML = mesas.length
    ? mesas.map((m) => `<option value="${m.id}">${esSupervisor() ? `${esc(m.sede)} · ` : ''}${esc(m.nombre)} · ${esc(m.responsable)}</option>`).join('')
    : '<option value="">No hay mesas activas: un supervisor las da de alta en Personal</option>';
  if (mesas.some((m) => String(m.id) === previa)) $('#digi-mesa').value = previa;
  $('#digi-asignar').disabled = !mesas.length;
}

$('#digi-todas').addEventListener('click', () => {
  const todas = $$('#digi-por-asignar .sel-carpeta, #digi-por-asignar .sel-lote');
  const marcar = todas.some((c) => !c.checked);
  todas.forEach((c) => { c.checked = marcar; });
  actualizarSeleccion();
});

// la selección puede abarcar varios lotes: se asigna lote por lote
$('#digi-asignar').addEventListener('click', async () => {
  const porLote = new Map();
  for (const c of $$('#digi-por-asignar .sel-carpeta:checked')) {
    porLote.set(c.dataset.lote, [...(porLote.get(c.dataset.lote) || []), Number(c.dataset.id)]);
  }
  const mesa = $('#digi-mesa').value;
  const boton = $('#digi-asignar');
  boton.disabled = true;
  const errores = [];
  let asignadas = 0;
  for (const [lote, documentos] of porLote) {
    try {
      await api(`/api/remisiones/${lote}/mesa`, { method: 'POST', body: JSON.stringify({ documentos, mesa }) });
      asignadas += documentos.length;
    } catch (e) { errores.push(e.message); }
  }
  boton.disabled = false;
  if (asignadas) aviso(`${num(asignadas)} carpeta${asignadas === 1 ? '' : 's'} asignada${asignadas === 1 ? '' : 's'} a la mesa.`);
  if (errores.length) aviso(errores.join(' '), 'error');
  cargarDigitalizacion();
});

function pintarMesas(t) {
  const visibles = t.mesas.filter((m) => m.activa || t.en_mesas.some((c) => c.mesa_id === m.id));
  if (!visibles.length) {
    $('#digi-mesas').innerHTML = `<div class="card"><div class="card-body">${vacio('Sin mesas de digitalización',
      esSupervisor() ? 'Dalas de alta en Personal, cada una con su responsable.' : 'Un supervisor las da de alta en Personal.')}</div></div>`;
    return;
  }
  $('#digi-mesas').innerHTML = visibles.map((m) => {
    const propias = t.en_mesas.filter((c) => c.mesa_id === m.id);
    return `
      <div class="card">
        <div class="card-head">
          <h2>${esc(m.nombre)}${esSupervisor() ? ` <span class="celda-sec">· ${esc(m.sede)}</span>` : ''}</h2>
          <span class="celda-sec">${esc(m.responsable || 'sin responsable')} · ${num(propias.length)} carpeta${propias.length === 1 ? '' : 's'}</span>
        </div>
        <div class="card-body no-pad">${propias.length ? `<div class="lista">${propias.map((c) => {
          const [texto] = c.etapa === 'Escaneada' && !c.tiene_archivo ? ['Subir PDF'] : SIGUIENTE_PASO[c.etapa] || [];
          return `
          <div class="lista-fila">
            <div class="principal">
              ${nombreCarpeta(c)} <span class="pill etapa-${clase(c.etapa)}">${esc(c.etapa)}</span>
              <div class="secundario"><button class="link-btn" data-lote="${c.remision_id}">${esc(c.folio)}</button>
                · caja ${num(c.caja)} · ${foliosDe(c)} · ${num(c.fojas)} fojas
                ${c.insertos ? ` · ${num(c.insertos)} inserto${c.insertos === 1 ? '' : 's'}${c.por_reintegrar ? `, ${num(c.por_reintegrar)} por reintegrar` : ''}` : ''}</div>
            </div>
            ${texto ? `<button class="btn" data-paso="${c.id}" data-remision="${c.remision_id}">${texto}</button>` : ''}
          </div>`; }).join('')}</div>`
          : vacio('Sin carpetas', rol() === 'Mesa'
              ? 'Aquí aparecerán las carpetas que asignen a tu mesa.'
              : 'Asigna carpetas desde «Por asignar a mesa».')}</div>
      </div>`;
  }).join('');

  $$('#digi-mesas [data-lote]').forEach((b) => b.addEventListener('click', () => abrirDetalle(b.dataset.lote, 'digitalizacion')));
  $$('#digi-mesas [data-paso]').forEach((b) => b.addEventListener('click', async () => {
    const r = await api(`/api/remisiones/${b.dataset.remision}`);
    const d = r.documentos.find((x) => x.id === Number(b.dataset.paso));
    if (d.etapa === 'Escaneada' && !d.archivo) return ventanaSubirPdf(r, d, cargarDigitalizacion);
    SIGUIENTE_PASO[d.etapa]?.[1](r, d, cargarDigitalizacion);
  }));
}

/* ── traslados de cajas entre sedes ── */

function pintarTraslados(t) {
  const yo = estado.sesion.usuario;
  const puedeEnviar = rol() !== 'Mesa' && t.cajas_enviables.length > 0;
  $('#digi-traslados-card').hidden = rol() === 'Mesa' || (!t.traslados.length && !t.cajas_enviables.length);
  $('#digi-enviar').hidden = !puedeEnviar;
  $('#digi-traslados').innerHTML = t.traslados.length ? `<div class="lista">${t.traslados.map((x) => {
    const recibo = esSupervisor() || yo.sede_id === x.destino_id;
    return `
    <div class="lista-fila" style="align-items:flex-start">
      <div class="principal">
        <b>Traslado ${x.id}: ${esc(x.origen)} → ${esc(x.destino)}</b> <span class="pill en-digitalizacion">En tránsito</span>
        <div class="secundario">${x.cajas.map((c) => `${esc(c.folio)} caja ${num(c.caja)} (${num(c.carpetas)} carpetas, ${num(c.fojas)} fojas)`).join(' · ')}</div>
        <div class="secundario">Envió ${esc(x.envia_por)} · ${fechaHora(x.enviado_en)} · transporta ${esc(x.transporta)}
          ${x.notas ? ` · ${esc(x.notas)}` : ''}</div>
      </div>
      ${recibo ? `<button class="btn btn-primary" data-recibir="${x.id}">Recibir</button>`
               : '<span class="celda-sec">esperando a la sede destino</span>'}
    </div>`; }).join('')}</div>`
    : vacio('Nada en tránsito', 'Las cajas que se envíen a otra sede aparecen aquí hasta que la sede destino las reciba.');
  $$('#digi-traslados [data-recibir]').forEach((b) => b.addEventListener('click', () =>
    recibirTraslado(t.traslados.find((x) => x.id === Number(b.dataset.recibir)))));
}

$('#digi-enviar').addEventListener('click', () => {
  const t = estado.trabajo;
  const destinos = (estado.catalogos.sedes || []).filter((s) => s.activa);
  abrirModal({
    titulo: 'Enviar cajas a otra sede',
    ancho: true,
    cuerpo: `
      <p class="sub" style="margin-bottom:12px">Se envían cajas completas. Solo aparecen las de lotes validados que no tienen
        carpetas en una mesa. Mientras viajan nadie las puede trabajar, y la sede destino tiene que contarlas al recibirlas.</p>
      <table class="tabla">
        <thead><tr><th style="width:36px"></th><th>Lote</th><th>Caja</th><th>Está en</th>
          <th class="num">Carpetas</th><th class="num">Fojas</th></tr></thead>
        <tbody>${t.cajas_enviables.map((c, i) => `
          <tr style="cursor:default">
            <td><input type="checkbox" class="t-caja" data-i="${i}" aria-label="Enviar"></td>
            <td>${esc(c.folio)} <span class="celda-sec">${esc(c.dependencia)}</span>
              ${c.terminadas ? '<div class="celda-sec">terminadas, listas para devolver</div>' : ''}</td>
            <td>${num(c.caja)}</td><td>${esc(c.sede)}</td>
            <td class="num">${num(c.carpetas)}</td><td class="num">${num(c.fojas)}</td>
          </tr>`).join('')}</tbody>
      </table>
      <div class="campos" style="grid-template-columns:1fr 1fr;margin-top:14px">
        <label class="campo" style="grid-column:span 1"><span>Sede destino</span>
          <select id="t-destino">${destinos.map((s) => `<option value="${s.id}">${esc(s.nombre)}</option>`).join('')}</select></label>
        <label class="campo" style="grid-column:span 1"><span>Quién transporta</span>
          <input id="t-transporta" placeholder="Nombre de quien lleva las cajas"></label>
        <label class="campo" style="grid-column:span 2"><span>Notas</span>
          <input id="t-notas" placeholder="Vehículo, sellos, observaciones…"></label>
      </div>`,
    botones: [
      { texto: 'Cancelar', accion: cerrarModal },
      { texto: 'Enviar', clase: 'btn btn-primary', accion: async () => {
        const cajas = $$('.t-caja').filter((c) => c.checked)
          .map((c) => t.cajas_enviables[Number(c.dataset.i)]).map((c) => ({ remision_id: c.remision_id, caja: c.caja }));
        try {
          const { id } = await api('/api/traslados', { method: 'POST', body: JSON.stringify({
            cajas, destino: $('#t-destino').value, transporta: $('#t-transporta').value, notas: $('#t-notas').value
          }) });
          cerrarModal();
          aviso(`Traslado ${id} registrado: las cajas quedan en tránsito hasta que la sede destino las reciba.`);
          cargarDigitalizacion();
        } catch (e) { aviso(e.message, 'error'); }
      } }
    ]
  });
});

/* Al recibir se cuenta lo que llegó, sin datos precargados: así el conteo es real. */
function recibirTraslado(x) {
  abrirModal({
    titulo: `Recibir traslado ${x.id} · ${x.origen} → ${x.destino}`,
    ancho: true,
    cuerpo: `
      <p class="sub" style="margin-bottom:12px">Cuenta cada caja al recibirla. Si algo no coincide con lo que salió,
        hay que explicarlo; la diferencia queda en el historial de cada lote.</p>
      <table class="tabla">
        <thead><tr><th>Lote</th><th>Caja</th><th class="num">Salieron</th>
          <th style="width:110px">Carpetas recibidas</th><th style="width:110px">Fojas recibidas</th></tr></thead>
        <tbody>${x.cajas.map((c) => `
          <tr style="cursor:default" data-caja="${c.id}">
            <td>${esc(c.folio)}</td><td>${num(c.caja)}</td>
            <td class="num celda-sec">${num(c.carpetas)} carpetas · ${num(c.fojas)} fojas</td>
            <td><input type="number" class="r-carpetas" min="0" step="1"></td>
            <td><input type="number" class="r-fojas" min="0" step="1"></td>
          </tr>`).join('')}</tbody>
      </table>
      <label class="campo" style="margin-top:14px"><span>Notas de la recepción</span>
        <textarea id="r-notas-traslado" rows="2" placeholder="Obligatorias si algo no coincide"></textarea></label>`,
    botones: [
      { texto: 'Cancelar', accion: cerrarModal },
      { texto: 'Recibir', clase: 'btn btn-primary', accion: async () => {
        const cajas = $$('#modal-cuerpo tr[data-caja]').map((tr) => ({
          id: Number(tr.dataset.caja),
          carpetas: tr.querySelector('.r-carpetas').value,
          fojas: tr.querySelector('.r-fojas').value
        }));
        try {
          await api(`/api/traslados/${x.id}/recepcion`, { method: 'PUT',
            body: JSON.stringify({ cajas, notas: $('#r-notas-traslado').value }) });
          cerrarModal();
          aviso(`Traslado ${x.id} recibido en ${x.destino}.`);
          cargarDigitalizacion();
        } catch (e) { aviso(e.message, 'error'); }
      } }
    ]
  });
}

/* ═══════════════════════════ devueltas ══════════════════════════ */

const diasDesde = (iso) => {
  if (!iso) return 0;
  const [a, m, d] = iso.split('-').map(Number);
  return Math.max(0, Math.round((Date.now() - new Date(a, m - 1, d)) / 86400000));
};

const devuelta = (r) => Boolean(r.dev_fecha) && r.dev_aceptacion !== 'Rechazado';
const enResguardo = (r) => !devuelta(r) && r.estado !== 'Cancelado';
const terminado = (r) => r.carpetas > 0 && r.carpetas_terminadas === r.carpetas;

/** Qué le falta a un lote para poder cerrarse. */
function pendienteDe(r) {
  if (r.dev_aceptacion === 'Rechazado') return { texto: 'Devolución rechazada', clase: 'alta' };
  if (!r.dev_fecha && !terminado(r)) {
    return { texto: `${num(r.carpetas - r.carpetas_terminadas)} carpetas por terminar`, clase: 'media' };
  }
  if (!r.dev_fecha) return { texto: 'Sin registrar la devolución', clase: 'alta' };
  if (!r.cotejo_en) return { texto: 'Falta cotejar la devolución', clase: 'media' };
  if (!r.dev_firmado_en) return { texto: 'Falta la firma del acuse', clase: 'media' };
  return null;
}

async function cargarEntregas() {
  const lotes = await api('/api/remisiones');
  estado.entregas = lotes;

  const resguardo = lotes.filter(enResguardo);
  const entregadas = lotes.filter(devuelta);
  const listasParaEntregar = resguardo.filter(terminado);
  const conPendientes = entregadas.filter((r) => pendienteDe(r));

  $('#entregas-stats').innerHTML = [
    ['En resguardo', resguardo.length,
      `${num(resguardo.reduce((a, r) => a + r.cajas, 0))} cajas · ${num(resguardo.reduce((a, r) => a + r.carpetas, 0))} carpetas`],
    ['Listas para entregar', listasParaEntregar.length, 'todas sus carpetas recosidas'],
    ['Devueltas', entregadas.length, `${num(entregadas.reduce((a, r) => a + r.cajas, 0))} cajas devueltas`],
    ['Acuses pendientes', conPendientes.length, 'sin cotejo o sin firma']
  ].map(([etiqueta, valor, pie]) => `
    <div class="stat">
      <div class="stat-label">${etiqueta}</div>
      <div class="stat-valor">${num(valor)}</div>
      <div class="stat-pie">${pie}</div>
    </div>`).join('');

  pintarEntregas();
}

function pintarEntregas() {
  const lotes = estado.entregas || [];
  const filtro = estado.filtroEntregas || 'pendientes';
  const visibles = filtro === 'pendientes' ? lotes.filter(enResguardo)
    : filtro === 'entregadas' ? lotes.filter(devuelta)
    : lotes;

  const totalCajas = visibles.reduce((a, r) => a + r.cajas, 0);
  $('#entregas-sub').textContent = visibles.length
    ? `${num(visibles.length)} lotes · ${num(totalCajas)} cajas · ${num(visibles.reduce((a, r) => a + r.total_documentos, 0))} documentos`
    : 'Carpetas en resguardo y devoluciones';

  if (!visibles.length) {
    $('#tabla-entregas').innerHTML = filtro === 'entregadas'
      ? vacio('Todavía no hay devoluciones', 'Aparecerán aquí al registrar la devolución de un lote.')
      : vacio('Nada en resguardo', 'Todos los lotes recibidos ya fueron devueltos.');
    return;
  }

  const vistaResguardo = filtro !== 'entregadas';
  $('#tabla-entregas').innerHTML = `
    <table class="tabla">
      <thead><tr>
        <th>Folio</th><th>Dependencia</th>
        <th>${vistaResguardo ? 'En resguardo desde' : 'Devuelto'}</th>
        <th class="num">Docs.</th><th class="num">Cajas</th>
        <th>${vistaResguardo ? 'Digitalización' : 'Entrega digital'}</th>
        <th>${vistaResguardo ? 'Estado' : 'Aceptación'}</th>
      </tr></thead>
      <tbody>${visibles.map((r) => {
        const falta = pendienteDe(r);
        const avance = r.carpetas ? r.carpetas_terminadas / r.carpetas * 100 : 0;
        return `
        <tr data-id="${r.id}">
          <td class="folio">${esc(r.folio)}</td>
          <td>${esc(r.dependencia)}<div class="celda-sec">${esc(r.area || '')}</div></td>
          <td>${r.dev_fecha ? fechaCorta(r.dev_fecha) : fechaCorta(r.fecha)}
            <div class="celda-sec">${r.dev_fecha
              ? `recibido ${fechaCorta(r.fecha)}`
              : (() => { const d = diasDesde(r.fecha);
                   return d === 0 ? 'hoy' : `${num(d)} día${d === 1 ? '' : 's'}`; })()}</div></td>
          <td class="num">${num(r.total_documentos)}<div class="celda-sec">${num(r.total_fojas)} fojas</div></td>
          <td class="num">${num(r.cajas)}${r.carpetas ? `<div class="celda-sec">${num(r.carpetas)} carpetas</div>` : ''}</td>
          <td style="min-width:120px">
            ${r.dev_fecha
              ? `${num(r.dev_archivos)} archivos<div class="celda-sec">${esc(r.dev_medio || '—')}</div>`
              : `<div class="barra"><i style="width:${avance.toFixed(1)}%"></i></div>
                 <div class="celda-sec">${num(r.carpetas_terminadas)} de ${num(r.carpetas)} carpetas terminadas</div>`}
          </td>
          <td>
            ${r.dev_fecha
              ? `<span class="pill ${clase(r.dev_aceptacion)}">${esc(r.dev_aceptacion || '—')}</span>`
              : `<span class="pill ${clase(r.estado)}">${esc(r.estado)}</span>`}
            ${falta ? `<div class="celda-sec" style="color:var(--${falta.clase === 'alta' ? 'red' : 'orange'});margin-top:3px">
              ${esc(falta.texto)}</div>` : ''}
            ${enResguardo(r) && !r.dev_fecha && terminado(r)
              ? `<button class="link-btn" data-salida="${r.id}" style="margin-top:3px">Registrar salida</button>` : ''}
          </td>
        </tr>`;
      }).join('')}
      </tbody>
    </table>`;

  $$('#tabla-entregas tbody tr').forEach((tr) => tr.addEventListener('click', () =>
    abrirDetalle(tr.dataset.id, 'devolucion')));
  $$('#tabla-entregas [data-salida]').forEach((b) => b.addEventListener('click', (e) => {
    e.stopPropagation();
    registrarSalida(b.dataset.salida);
  }));
}

$$('#f-entregas button').forEach((b) => b.addEventListener('click', () => {
  $$('#f-entregas button').forEach((x) => x.classList.toggle('is-active', x === b));
  estado.filtroEntregas = b.dataset.filtro;
  pintarEntregas();
}));

/* ═══════════════════════════ personal ═══════════════════════════ */

async function cargarPersonal() {
  const gente = await api('/api/usuarios');
  estado.catalogos.usuarios = gente;
  cargarMesas();
  cargarSedes();

  const activos = gente.filter((p) => p.activo).length;
  $('#personal-sub').textContent = gente.length
    ? `${num(activos)} en activo de ${num(gente.length)} · ${num(gente.filter((p) => p.rol === 'Operador').length)} operadores`
    : 'Quiénes reciben y quiénes digitalizan';

  $('#tabla-personal').innerHTML = gente.length ? `
    <table class="tabla">
      <thead><tr>
        <th>Persona</th><th>Rol</th><th>Sede / mesa</th><th>Contacto</th>
        <th class="num">Recepciones</th><th class="num">Carpetas escaneadas</th><th class="num">Imágenes</th>
        <th>Última actividad</th><th></th>
      </tr></thead>
      <tbody>${gente.map((p) => `
        <tr style="cursor:default"${p.activo ? '' : ' class="baja"'}>
          <td>
            <b style="font-weight:500">${esc(p.nombre)}</b>
            ${p.activo ? '' : ' <span class="pill">Baja</span>'}
            ${p.cargo ? `<div class="celda-sec">${esc(p.cargo)}</div>` : ''}
          </td>
          <td><span class="pill ${clase(p.rol)}">${esc(p.rol)}</span>
            <div class="celda-sec">ve: ${(p.secciones || []).length === (estado.catalogos.modulos || []).length ? 'todo'
              : esc((p.secciones || []).map((s) => (estado.catalogos.modulos || []).find(([c]) => c === s)?.[1] || s).join(', '))}</div></td>
          <td class="celda-sec">${esc(p.rol === 'Mesa' ? `${p.sede || ''} · ${p.mesa || 'sin mesa'}` : p.sede || '—')}</td>
          <td class="celda-sec">${esc(p.email || '—')}${p.telefono ? `<div>${esc(p.telefono)}</div>` : ''}</td>
          <td class="num">${num(p.recepciones)}</td>
          <td class="num">${num(p.sesiones)}</td>
          <td class="num">${num(p.imagenes)}</td>
          <td class="celda-sec">${p.ultima_actividad
            ? new Date(p.ultima_actividad).toLocaleDateString('es-MX', { day: '2-digit', month: 'short', year: 'numeric' })
            : 'sin movimientos'}</td>
          <td style="text-align:right;white-space:nowrap">
            <button class="link-btn" data-editar-persona="${p.id}">Editar</button>
            ${p.activo && esSupervisor() ? `<button class="link-btn" data-quitar-persona="${p.id}" style="color:var(--red);margin-left:10px">Dar de baja</button>` : ''}
          </td>
        </tr>`).join('')}
      </tbody>
    </table>`
    : vacio('Aún no hay personal registrado',
            'Da de alta a quienes reciben documentos y a quienes los digitalizan.');

  $$('#tabla-personal [data-editar-persona]').forEach((b) => b.addEventListener('click', () =>
    formularioPersona(gente.find((p) => p.id === Number(b.dataset.editarPersona)))));
  $$('#tabla-personal [data-quitar-persona]').forEach((b) => b.addEventListener('click', async () => {
    const p = gente.find((x) => x.id === Number(b.dataset.quitarPersona));
    if (!confirm(`¿Dar de baja a ${p.nombre}? Ya no podrá entrar; su historial se conserva.`)) return;
    try {
      await api(`/api/usuarios/${p.id}`, { method: 'DELETE' });
      aviso(`${p.nombre} quedó dada de baja.`);
      cargarPersonal();
    } catch (e) { aviso(e.message, 'error'); }
  }));
}

/* ── sedes: donde se recibe y se digitaliza ── */
async function cargarSedes() {
  $('#card-sedes').hidden = !esSupervisor();
  if (!esSupervisor()) return;
  const sedes = await api('/api/sedes');
  estado.catalogos.sedes = sedes;
  $('#tabla-sedes').innerHTML = `
    <table class="tabla">
      <thead><tr><th>Sede</th><th>Dirección</th><th></th></tr></thead>
      <tbody>${sedes.map((s) => `
        <tr style="cursor:default"${s.activa ? '' : ' class="baja"'}>
          <td><b style="font-weight:500">${esc(s.nombre)}</b>${s.activa ? '' : ' <span class="pill">Inactiva</span>'}</td>
          <td class="celda-sec">${esc(s.direccion || '—')}</td>
          <td style="text-align:right"><button class="link-btn" data-editar-sede="${s.id}">Editar</button></td>
        </tr>`).join('')}</tbody>
    </table>`;
  $$('#tabla-sedes [data-editar-sede]').forEach((b) => b.addEventListener('click', () =>
    formularioSede(sedes.find((s) => s.id === Number(b.dataset.editarSede)))));
}

function formularioSede(sede = null) {
  const s = sede || { nombre: '', direccion: '', activa: 1 };
  abrirModal({
    titulo: sede ? `Editar ${sede.nombre}` : 'Nueva sede',
    cuerpo: `
      <label class="campo"><span>Nombre</span><input id="s-nombre" value="${esc(s.nombre)}" placeholder="Ej. Sede Norte"></label>
      <label class="campo" style="margin-top:12px"><span>Dirección</span><input id="s-direccion" value="${esc(s.direccion)}"></label>
      ${sede ? `<label class="check" style="margin-top:12px"><input type="checkbox" id="s-activa"${s.activa ? ' checked' : ''}> Activa</label>` : ''}`,
    botones: [
      { texto: 'Cancelar', accion: cerrarModal },
      { texto: 'Guardar', clase: 'btn btn-primary', accion: async () => {
        try {
          await api(sede ? `/api/sedes/${sede.id}` : '/api/sedes', {
            method: sede ? 'PUT' : 'POST',
            body: JSON.stringify({ nombre: $('#s-nombre').value, direccion: $('#s-direccion').value,
                                   activa: sede ? $('#s-activa').checked : true })
          });
          cerrarModal();
          aviso('Sede guardada.');
          await cargarCatalogos();
          cargarSedes();
        } catch (e) { aviso(e.message, 'error'); }
      } }
    ]
  });
}
$('#btn-alta-sede').addEventListener('click', () => formularioSede());

/* ── mesas de digitalización: cada una con su responsable ── */
async function cargarMesas() {
  const mesas = await api('/api/mesas');
  estado.catalogos.mesas = mesas;
  $('#btn-alta-mesa').hidden = !esSupervisor();
  $('#tabla-mesas').innerHTML = mesas.length ? `
    <table class="tabla">
      <thead><tr><th>Mesa</th><th>Sede</th><th>Responsable</th><th class="num">En la mesa ahora</th>
        <th class="num">Carpetas escaneadas</th><th></th></tr></thead>
      <tbody>${mesas.map((m) => `
        <tr style="cursor:default"${m.activa ? '' : ' class="baja"'}>
          <td><b style="font-weight:500">${esc(m.nombre)}</b>${m.activa ? '' : ' <span class="pill">Inactiva</span>'}</td>
          <td class="celda-sec">${esc(m.sede || '—')}</td>
          <td>${esc(m.responsable || '—')}</td>
          <td class="num">${num(m.en_mesa)}</td>
          <td class="num">${num(m.escaneadas)}</td>
          <td style="text-align:right">${esSupervisor() ? `<button class="link-btn" data-editar-mesa="${m.id}">Editar</button>` : ''}</td>
        </tr>`).join('')}
      </tbody>
    </table>`
    : vacio('Sin mesas registradas', esSupervisor()
        ? 'Da de alta las mesas de digitalización y su responsable.'
        : 'Un supervisor da de alta las mesas de digitalización.');
  $$('#tabla-mesas [data-editar-mesa]').forEach((b) => b.addEventListener('click', () =>
    formularioMesa(mesas.find((m) => m.id === Number(b.dataset.editarMesa)))));
}

function formularioMesa(mesa = null) {
  const m = mesa || { nombre: '', responsable: '', activa: 1 };
  const personas = (estado.catalogos.usuarios || []).filter((u) => u.activo);
  abrirModal({
    titulo: mesa ? `Editar ${mesa.nombre}` : 'Nueva mesa',
    cuerpo: `
      <label class="campo"><span>Nombre</span><input id="m-nombre" value="${esc(m.nombre)}" placeholder="Ej. Mesa 1"></label>
      <label class="campo" style="margin-top:12px"><span>Sede</span>
        <select id="m-sede">${(estado.catalogos.sedes || []).filter((s) => s.activa).map((s) =>
          `<option value="${s.id}"${s.id === (m.sede_id ?? estado.sesion.usuario.sede_id) ? ' selected' : ''}>${esc(s.nombre)}</option>`).join('')}</select></label>
      <label class="campo" style="margin-top:12px"><span>Responsable</span>
        <select id="m-responsable"><option value=""></option>${personas.map((u) =>
          `<option${u.nombre === m.responsable ? ' selected' : ''}>${esc(u.nombre)}</option>`).join('')}</select></label>
      ${mesa ? `<label class="check" style="margin-top:12px"><input type="checkbox" id="m-activa"${m.activa ? ' checked' : ''}> Activa</label>` : ''}
      <p class="sub" style="margin-top:12px">Al cambiar el responsable, lo ya escaneado conserva a quien estaba a cargo en ese momento.</p>`,
    botones: [
      { texto: 'Cancelar', accion: cerrarModal },
      { texto: 'Guardar', clase: 'btn btn-primary', accion: async () => {
        try {
          await api(mesa ? `/api/mesas/${mesa.id}` : '/api/mesas', {
            method: mesa ? 'PUT' : 'POST',
            body: JSON.stringify({ nombre: $('#m-nombre').value, responsable: $('#m-responsable').value,
                                   sede_id: $('#m-sede').value, activa: mesa ? $('#m-activa').checked : true })
          });
          cerrarModal();
          aviso('Mesa guardada.');
          cargarMesas();
        } catch (e) { aviso(e.message, 'error'); }
      } }
    ]
  });
}
$('#btn-alta-mesa').addEventListener('click', () => formularioMesa());

function formularioPersona(persona = null) {
  const roles = estado.catalogos.roles || [];
  const p = persona || { nombre: '', rol: 'Operador', cargo: '', telefono: '', email: '', activo: 1 };

  abrirModal({
    titulo: persona ? `Editar a ${persona.nombre}` : 'Agregar persona',
    cuerpo: `
      <div class="campos" style="grid-template-columns:1fr 1fr">
        <label class="campo" style="grid-column:span 2"><span>Nombre completo</span>
          <input id="p-nombre" maxlength="120" value="${esc(p.nombre)}" placeholder="Nombre y apellidos"></label>
        <label class="campo" style="grid-column:span 1"><span>Rol</span>
          <select id="p-rol">${roles.map((r) =>
            `<option${r === p.rol ? ' selected' : ''}>${esc(r)}</option>`).join('')}</select></label>
        <label class="campo" style="grid-column:span 1"><span>Cargo</span>
          <input id="p-cargo" maxlength="120" value="${esc(p.cargo)}"
                 placeholder="Ej. Auxiliar de recepción"></label>
        <label class="campo" style="grid-column:span 2" id="p-campo-sede"><span>Sede</span>
          <select id="p-sede">${(estado.catalogos.sedes || []).filter((s) => s.activa).map((s) =>
            `<option value="${s.id}"${s.id === p.sede_id ? ' selected' : ''}>${esc(s.nombre)}</option>`).join('')}</select></label>
        <div class="campo" style="grid-column:span 2"><span>Secciones que puede ver</span>
          <div class="secciones" id="p-secciones">${(estado.catalogos.modulos || []).map(([clave, nombre]) => `
            <label class="check"><input type="checkbox" value="${clave}"
              ${(p.secciones || estado.catalogos.permisos_por_rol?.[p.rol] || []).includes(clave) ? ' checked' : ''}> ${esc(nombre)}</label>`).join('')}
          </div>
          <p class="sub" id="p-secciones-nota" hidden></p>
        </div>
        <label class="campo" style="grid-column:span 2" id="p-campo-mesa"><span>Mesa en la que trabaja</span>
          <select id="p-mesa"><option value="">Elige la mesa…</option>${(estado.catalogos.mesas || []).filter((m) => m.activa).map((m) =>
            `<option value="${m.id}"${m.id === p.mesa_id ? ' selected' : ''}>${esc(m.sede)} · ${esc(m.nombre)}</option>`).join('')}</select></label>
        <label class="campo" style="grid-column:span 1"><span>Correo de Google</span>
          <input id="p-email" maxlength="160" value="${esc(p.email)}" placeholder="persona@empresa.com"></label>
        <label class="campo" style="grid-column:span 1"><span>Teléfono</span>
          <input id="p-telefono" maxlength="40" value="${esc(p.telefono)}" placeholder="Opcional"></label>
        <label class="campo" style="grid-column:span 2;flex-direction:row;align-items:center;gap:9px">
          <input type="checkbox" id="p-activo" style="width:auto"${p.activo ? ' checked' : ''}>
          <span style="padding:0">En activo</span></label>
      </div>
      <p class="sub">
        Quien tiene el rol <b>Mesa</b> solo ve y trabaja las carpetas asignadas a su mesa; los demás ven lo de su sede
        (los supervisores, todas). El cargo se imprime en los acuses junto a la firma. El correo solo hace falta
        cuando el acceso con Google esté encendido; sin él, esa persona no podrá entrar.
        Para que alguien deje de aparecer sin perder su historial, quítale <b>En activo</b>.
      </p>`,
    botones: [
      { texto: 'Cancelar', accion: cerrarModal },
      { texto: persona ? 'Guardar' : 'Agregar', clase: 'btn btn-primary', accion: async () => {
        const datos = {
          nombre: $('#p-nombre').value.trim(),
          rol: $('#p-rol').value,
          cargo: $('#p-cargo').value.trim(),
          email: $('#p-email').value.trim(),
          telefono: $('#p-telefono').value.trim(),
          activo: $('#p-activo').checked,
          sede_id: $('#p-sede').value,
          mesa_id: $('#p-mesa').value,
          permisos: $$('#p-secciones input:checked').map((c) => c.value)
        };
        if (!datos.nombre) return aviso('Escribe el nombre.', 'error');
        try {
          await api(persona ? `/api/usuarios/${persona.id}` : '/api/usuarios', {
            method: persona ? 'PUT' : 'POST',
            body: JSON.stringify(datos)
          });
          cerrarModal();
          aviso(persona ? 'Datos actualizados.' : `${datos.nombre} quedó registrada.`);
          await cargarPersonal();
          llenarRecibe();
        } catch (e) { aviso(e.message, 'error'); }
      } }
    ]
  });
  mostrarLugarPersona();
}

$('#btn-alta-persona').addEventListener('click', () => formularioPersona());
// el rol decide si la persona pertenece a una sede o a una mesa
document.addEventListener('change', (e) => {
  if (e.target.id !== 'p-rol') return;
  // al cambiar el rol se proponen sus secciones; después se pueden ajustar
  const delRol = estado.catalogos.permisos_por_rol?.[e.target.value] || [];
  $$('#p-secciones input').forEach((c) => { c.checked = delRol.includes(c.value); });
  mostrarLugarPersona();
});
function mostrarLugarPersona() {
  const rolElegido = $('#p-rol')?.value;
  if (!$('#p-campo-mesa')) return;
  const mesa = rolElegido === 'Mesa';
  $('#p-campo-mesa').hidden = !mesa;
  $('#p-campo-sede').hidden = mesa;
  // supervisor y mesa tienen secciones fijas
  const fijas = rolElegido === 'Supervisor' || mesa;
  const delRol = estado.catalogos.permisos_por_rol?.[rolElegido] || [];
  $$('#p-secciones input').forEach((c) => {
    c.disabled = fijas;
    if (fijas) c.checked = delRol.includes(c.value);
  });
  $('#p-secciones-nota').hidden = !fijas;
  $('#p-secciones-nota').textContent = mesa
    ? 'Quien trabaja en una mesa solo ve Digitalización, con las carpetas de su mesa.'
    : 'Un supervisor siempre ve todo, para que nadie se quede sin acceso a la administración.';
}

/* ── quién recibe: se elige del personal registrado ── */

const OTRA_PERSONA = '__otra__';

function llenarRecibe(seleccion) {
  const sel = $('#sel-recibe');
  if (!sel) return;
  const activos = (estado.catalogos.usuarios || []).filter((p) => p.activo);
  const actual = seleccion ?? sel.value;

  sel.innerHTML = [
    activos.length ? '' : '<option value="">— sin personal registrado —</option>',
    ...activos.map((p) => `<option value="${esc(p.nombre)}">${esc(p.nombre)}${p.cargo ? ` · ${esc(p.cargo)}` : ''}</option>`),
    `<option value="${OTRA_PERSONA}">Otra persona…</option>`
  ].join('');

  if (actual && [...sel.options].some((o) => o.value === actual)) sel.value = actual;
  else if (estado.usuario && activos.some((p) => p.nombre === estado.usuario)) sel.value = estado.usuario;
  aplicarRecibe();
}

function aplicarRecibe() {
  const sel = $('#sel-recibe');
  const otra = sel.value === OTRA_PERSONA;
  $('#campo-recibe-otro').hidden = !otra;
  if (otra) return;
  const persona = (estado.catalogos.usuarios || []).find((p) => p.nombre === sel.value);
  if (persona?.cargo) $('#form-remision').recibe_cargo.value = persona.cargo;
}

$('#sel-recibe').addEventListener('change', aplicarRecibe);

/** Nombre de quien recibe, venga del selector o del campo libre. */
function nombreRecibe() {
  const sel = $('#sel-recibe');
  return sel.value === OTRA_PERSONA || !sel.value
    ? $('#form-remision').recibe_nombre.value.trim()
    : sel.value;
}

/* ───────────────────────── formulario de recepción ──────────────────── */

/* La entrega se captura caja por caja y, dentro de cada caja, carpeta por
   carpeta con sus fojas. Los totales se recalculan con cada tecla para que
   al recibir se sepa con certeza qué viene en cada caja. */

function filaCarpeta(d = {}) {
  const situaciones = estado.catalogos.situaciones || [];
  const fila = document.createElement('div');
  fila.className = 'carpeta';
  // la identidad de la carpeta se conserva al editar; tipo y cantidad no se capturan aquí
  if (d.id) fila.dataset.id = d.id;
  fila.dataset.tipo = d.tipo || '';
  fila.dataset.cantidad = d.cantidad ?? 1;
  fila.innerHTML = `
    <span class="carpeta-num"></span>
    <input class="c-nuc" aria-label="NUC" placeholder="NUC" value="${esc(d.nuc)}" autocapitalize="characters">
    <input type="number" class="c-folio-ini" aria-label="Folio inicial" min="0" step="1" placeholder="Del"
      value="${d.folio_inicial ?? ''}">
    <input type="number" class="c-folio-fin" aria-label="Folio final" min="0" step="1" placeholder="Al"
      value="${d.folio_final ?? ''}">
    <input type="number" class="c-fojas" aria-label="Fojas" min="1" step="1" placeholder="0"
      value="${d.fojas || ''}">
    <select class="c-situacion" aria-label="Situación">
      ${situaciones.map((s) => `<option${(d.situacion || 'Buen estado') === s ? ' selected' : ''}>${esc(s)}</option>`).join('')}
    </select>
    <input class="c-descripcion" aria-label="Descripción" placeholder="Descripción: tomo, delito…"
      value="${esc(d.descripcion)}">
    <input class="c-observaciones" aria-label="Observaciones" placeholder="Observaciones: folios bis, faltantes, estado…"
      value="${esc(d.observaciones)}">
    <button type="button" class="quitar" aria-label="Quitar carpeta" title="Quitar carpeta">×</button>
    <p class="carpeta-aviso" hidden></p>`;

  const $c = (s) => fila.querySelector(s);
  // con el rango de folios, las fojas se calculan solas; si no cuadran, se avisa
  const revisarFolios = () => {
    const ini = $c('.c-folio-ini').value, fin = $c('.c-folio-fin').value;
    const rango = ini !== '' && fin !== '' ? Number(fin) - Number(ini) + 1 : null;
    const aviso = [];
    if (rango !== null && rango < 1) aviso.push('El folio final es menor que el inicial.');
    else if (rango !== null && $c('.c-fojas').value && Number($c('.c-fojas').value) !== rango) {
      aviso.push(`Los folios ${ini}–${fin} suman ${rango} fojas: explica la diferencia en observaciones.`);
    }
    if (fila.dataset.duplicado) aviso.push(fila.dataset.duplicado);
    $c('.carpeta-aviso').textContent = aviso.join(' ');
    $c('.carpeta-aviso').hidden = !aviso.length;
  };
  for (const s of ['.c-folio-ini', '.c-folio-fin']) {
    $c(s).addEventListener('input', () => {
      const ini = $c('.c-folio-ini').value, fin = $c('.c-folio-fin').value;
      if (ini !== '' && fin !== '' && Number(fin) >= Number(ini)) $c('.c-fojas').value = Number(fin) - Number(ini) + 1;
      revisarFolios();
    });
  }
  $c('.c-fojas').addEventListener('input', revisarFolios);
  // el mismo NUC en otro lote no se impide (puede volver, o venir en tomos), pero se avisa
  $c('.c-nuc').addEventListener('change', async () => {
    const nuc = $c('.c-nuc').value.trim().toUpperCase();
    $c('.c-nuc').value = nuc;
    delete fila.dataset.duplicado;
    if (nuc) {
      const otros = await api(`/api/nuc?valor=${encodeURIComponent(nuc)}&excluir=${estado.editando || 0}`).catch(() => []);
      if (otros.length) {
        fila.dataset.duplicado = `Este NUC ya está registrado en ${otros.map((o) => `${o.folio} (${o.estado})`).join(', ')}.`;
      }
    }
    revisarFolios();
  });

  $c('.quitar').addEventListener('click', () => {
    if (fila.parentElement.children.length === 1) {
      return aviso('Cada caja necesita al menos una carpeta; si sobra la caja, quítala.', 'error');
    }
    fila.remove();
    renumerar();
  });
  // Enter en las observaciones pasa a la siguiente carpeta, o abre una nueva al final
  $c('.c-observaciones').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const siguiente = fila.nextElementSibling || agregarCarpeta(fila.closest('.caja-bloque'));
    siguiente.querySelector('.c-nuc').focus();
  });
  revisarFolios();
  return fila;
}

function bloqueCaja(carpetas = [{}]) {
  const caja = document.createElement('div');
  caja.className = 'caja-bloque';
  caja.innerHTML = `
    <div class="caja-head">
      <b class="caja-titulo"></b>
      <span class="caja-resumen"></span>
      <button type="button" class="quitar">Quitar caja</button>
    </div>
    <div class="carpeta carpeta-cols" aria-hidden="true">
      <span>#</span><span>NUC</span><span>Folio del</span><span>al</span>
      <span>Fojas</span><span>Situación</span><span></span>
    </div>
    <div class="caja-carpetas"></div>
    <button type="button" class="link-btn caja-agregar">Agregar carpeta</button>`;

  const lista = caja.querySelector('.caja-carpetas');
  carpetas.forEach((d) => lista.appendChild(filaCarpeta(d)));

  caja.querySelector('.caja-agregar').addEventListener('click', () =>
    agregarCarpeta(caja).querySelector('.c-nuc').focus());
  caja.querySelector('.caja-head .quitar').addEventListener('click', () => {
    if ($$('.caja-bloque').length === 1) return aviso('Debe existir al menos una caja.', 'error');
    const capturada = [...caja.querySelectorAll('input')].some((i) => i.value);
    const nombre = caja.querySelector('.caja-titulo').textContent.toLowerCase();
    if (capturada && !confirm(`¿Quitar la ${nombre} con todas sus carpetas?`)) return;
    caja.remove();
    renumerar();
  });
  caja.addEventListener('input', renumerar);
  return caja;
}

function agregarCarpeta(caja, d) {
  const fila = filaCarpeta(d);
  caja.querySelector('.caja-carpetas').appendChild(fila);
  renumerar();
  return fila;
}

function agregarCaja(carpetas) {
  const caja = bloqueCaja(carpetas);
  $('#cajas').appendChild(caja);
  renumerar();
  return caja;
}
$('#btn-agregar-caja').addEventListener('click', () => {
  agregarCaja().querySelector('.c-nuc').focus();
});

function renumerar() {
  const cajas = $$('.caja-bloque');
  let carpetas = 0, fojas = 0;
  cajas.forEach((caja, i) => {
    const filas = [...caja.querySelectorAll('.caja-carpetas .carpeta')];
    let fojasCaja = 0;
    filas.forEach((f, j) => {
      f.querySelector('.carpeta-num').textContent = j + 1;
      fojasCaja += Number(f.querySelector('.c-fojas').value || 0);
    });
    caja.querySelector('.caja-titulo').textContent = `Caja ${i + 1}`;
    caja.querySelector('.caja-resumen').textContent =
      `${num(filas.length)} carpeta${filas.length === 1 ? '' : 's'} · ${num(fojasCaja)} fojas`;
    carpetas += filas.length;
    fojas += fojasCaja;
  });
  $('#res-cajas').textContent = num(cajas.length);
  $('#res-carpetas').textContent = num(carpetas);
  $('#res-fojas').textContent = num(fojas);
}

function nuevaRemision() {
  estado.editando = null;
  const f = $('#form-remision');
  f.reset();
  if (estado.sesion.usuario?.sede_id) f.sede_id.value = estado.sesion.usuario.sede_id;
  f.sede_id.disabled = !esSupervisor();
  const ahora = new Date();
  f.fecha.value = hoyLocal();
  f.hora.value = ahora.toTimeString().slice(0, 5);
  llenarRecibe(estado.usuario || undefined);
  $('#cajas').innerHTML = '';
  agregarCaja();
  $('#recepcion-titulo').textContent = 'Recepción de documentos';
  $('#recepcion-sub').textContent = 'Registra la entrega física de un lote.';
  $('#btn-guardar').textContent = 'Guardar recepción';
  $('#btn-cancelar-edicion').hidden = true;
}

function editarRemision(r) {
  if (!['libre', 'autorizada'].includes(r.edicion)) return aviso(EXPLICA_EDICION[r.edicion], 'error');
  estado.editando = r.id;
  const f = $('#form-remision');
  ['fecha', 'hora', 'dependencia', 'area', 'entrega_nombre', 'entrega_cargo',
   'recibe_nombre', 'recibe_cargo', 'observaciones'].forEach((k) => { f[k].value = r[k] || ''; });
  // la sede de recepción no cambia al corregir: para moverla está el traslado
  f.sede_id.value = r.sede_id;
  f.sede_id.disabled = true;
  llenarRecibe(r.recibe_nombre);
  if ($('#sel-recibe').value !== r.recibe_nombre) {
    $('#sel-recibe').value = OTRA_PERSONA;   // alguien que ya no está en el padrón
    aplicarRecibe();
    f.recibe_nombre.value = r.recibe_nombre;
  }
  const porCaja = new Map();
  r.documentos.forEach((d) => porCaja.set(d.caja, [...(porCaja.get(d.caja) || []), d]));
  $('#cajas').innerHTML = '';
  porCaja.forEach((carpetas) => agregarCaja(carpetas));
  $('#recepcion-titulo').textContent = `Editar ${r.folio}`;
  $('#recepcion-sub').textContent = 'Modifica los datos de la remisión.';
  $('#btn-guardar').textContent = 'Guardar cambios';
  $('#btn-cancelar-edicion').hidden = false;
  cerrarSheet();
  irA('recepcion');
}

$('#btn-cancelar-edicion').addEventListener('click', () => { nuevaRemision(); irA('bitacora'); });

function leerFormulario() {
  const f = $('#form-remision');
  return {
    fecha: f.fecha.value,
    hora: f.hora.value,
    dependencia: f.dependencia.value,
    area: f.area.value,
    entrega_nombre: f.entrega_nombre.value,
    entrega_cargo: f.entrega_cargo.value,
    recibe_nombre: nombreRecibe(),
    recibe_cargo: f.recibe_cargo.value,
    observaciones: f.observaciones.value,
    sede_id: f.sede_id.value,
    documentos: $$('.caja-bloque').flatMap((caja, i) =>
      [...caja.querySelectorAll('.caja-carpetas .carpeta')].map((c) => ({
        id: c.dataset.id || null,
        caja: i + 1,
        nuc: c.querySelector('.c-nuc').value,
        folio_inicial: c.querySelector('.c-folio-ini').value,
        folio_final: c.querySelector('.c-folio-fin').value,
        descripcion: c.querySelector('.c-descripcion').value,
        tipo: c.dataset.tipo,
        cantidad: c.dataset.cantidad,
        situacion: c.querySelector('.c-situacion').value,
        fojas: c.querySelector('.c-fojas').value,
        observaciones: c.querySelector('.c-observaciones').value
      })))
  };
}

$('#btn-guardar').addEventListener('click', async () => {
  const datos = leerFormulario();
  const boton = $('#btn-guardar');
  boton.disabled = true;
  try {
    const r = estado.editando
      ? await api(`/api/remisiones/${estado.editando}`, { method: 'PUT', body: JSON.stringify(datos) })
      : await api('/api/remisiones', { method: 'POST', body: JSON.stringify(datos) });
    aviso(`${r.folio} guardada correctamente.`);
    estado.config = await api('/api/config');
    await cargarCatalogos();
    pintarUsuario();
    nuevaRemision();
    irA('bitacora');
    abrirDetalle(r.id);
  } catch (e) {
    aviso(e.message, 'error');
  } finally {
    boton.disabled = false;
  }
});

/* ══════════════════ quién opera este equipo ══════════════════ */

function usuariosActivos() {
  return (estado.catalogos.usuarios || []).filter((u) => u.activo);
}

function rol() { return estado.sesion.usuario?.rol || ''; }
function esSupervisor() { return rol() === 'Supervisor'; }

function pintarUsuario() {
  const u = estado.sesion.usuario;
  const lugar = u.rol === 'Mesa' ? `${u.mesa} · ${u.sede}` : u.rol === 'Supervisor' ? 'todas las sedes' : u.sede;
  $('#usuario-actual').innerHTML = `<b>${esc(u.nombre)}</b><span>${esc(u.rol)}${lugar ? ` · ${esc(lugar)}` : ''}</span>`;
  // exportar todo es una salida masiva de información: solo supervisores
  for (const b of ['#btn-exportar', '#btn-exportar-2']) $(b).hidden = !esSupervisor();
}

function elegirUsuario() { return administrarPersonas(); }

/* Con acceso de Google la identidad no se elige: se administra la lista. */
function administrarPersonas() {
  const yo = estado.sesion.usuario;
  const puede = esSupervisor();
  abrirModal({
    titulo: 'Personas con acceso',
    cuerpo: `
      <div class="lista">${(estado.catalogos.usuarios || []).map((u) => {
        const soyYo = (u.email || '').toLowerCase() === (yo.email || '').toLowerCase();
        return `
        <div class="lista-fila">
          <div class="principal">
            <b>${esc(u.nombre)}</b>
            <div class="secundario">${esc(u.email || 'sin correo')} · ${esc(u.rol)}${u.activo ? '' : ' · dado de baja'}</div>
          </div>
          ${soyYo ? '<span class="pill recibido">Tu sesión</span>'
                  : (puede ? `<button class="link-btn" data-baja="${u.id}" style="color:var(--red)">Quitar</button>` : '')}
        </div>`; }).join('')}</div>
      ${puede ? `
        <div class="campos" style="grid-template-columns:3fr 2fr;margin-top:18px">
          <label class="campo" style="grid-column:span 1"><span>Correo de Google</span>
            <input id="u-email" placeholder="persona@empresa.com" maxlength="160"></label>
          <label class="campo" style="grid-column:span 1"><span>Rol</span>
            <select id="u-rol">${(estado.catalogos.roles || []).map((r) => `<option>${esc(r)}</option>`).join('')}</select></label>
        </div>
        <p class="sub">Quien no esté en esta lista no podrá entrar, aunque tenga cuenta de Google.</p>`
        : '<p class="sub" style="margin-top:16px">Solo un supervisor puede dar de alta o de baja.</p>'}`,
    botones: [
      { texto: 'Cerrar sesión', clase: 'btn btn-danger', accion: async () => {
        await fetch('/auth/salir', { method: 'POST' });
        location.href = '/';
      } },
      { texto: 'Cerrar', accion: cerrarModal },
      ...(puede ? [{ texto: 'Dar de alta', clase: 'btn btn-primary', accion: async () => {
        const email = $('#u-email').value.trim();
        if (!email) return aviso('Escribe el correo.', 'error');
        try {
          estado.catalogos.usuarios = await api('/api/usuarios', {
            method: 'POST', body: JSON.stringify({ email, nombre: email.split('@')[0], rol: $('#u-rol').value })
          });
          aviso(`${email} ya puede entrar.`);
          administrarPersonas();
        } catch (e) { aviso(e.message, 'error'); }
      } }] : [])
    ]
  });

  $$('#modal-cuerpo [data-baja]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('¿Quitar el acceso de esta persona?')) return;
    try {
      estado.catalogos.usuarios = await api(`/api/usuarios/${b.dataset.baja}`, { method: 'DELETE' });
      administrarPersonas();
    } catch (e) { aviso(e.message, 'error'); }
  }));
}

/* ══════════════════ captura e incidencias ══════════════════ */

function reportarIncidencia(r, alTerminar) {
  const cat = estado.catalogos;
  abrirModal({
    titulo: `Reportar incidencia · ${r.folio}`,
    cuerpo: `
      <div class="campos" style="grid-template-columns:2fr 1fr">
        <label class="campo" style="grid-column:span 1"><span>Tipo de incidencia</span>
          <select id="inc-tipo">${(cat.tipos_incidencia || []).map((t) => `<option>${esc(t)}</option>`).join('')}</select></label>
        <label class="campo" style="grid-column:span 1"><span>Gravedad</span>
          <select id="inc-gravedad">${(cat.gravedades || []).map((g) =>
            `<option${g === 'Media' ? ' selected' : ''}>${esc(g)}</option>`).join('')}</select></label>
        <label class="campo"><span>Descripción</span>
          <textarea id="inc-descripcion" rows="3"
            placeholder="Qué ocurrió, en qué caja o carpeta, qué se necesita para resolverlo…"></textarea></label>
      </div>`,
    botones: [
      { texto: 'Cancelar', accion: cerrarModal },
      { texto: 'Registrar', clase: 'btn btn-primary', accion: async () => {
        try {
          await api(`/api/remisiones/${r.id}/incidencias`, {
            method: 'POST',
            body: JSON.stringify({
              tipo: $('#inc-tipo').value,
              gravedad: $('#inc-gravedad').value,
              descripcion: $('#inc-descripcion').value
            })
          });
          cerrarModal();
          aviso('Incidencia registrada.');
          alTerminar();
        } catch (e) { aviso(e.message, 'error'); }
      } }
    ]
  });
}

function resolverIncidencia(incidencia, alTerminar) {
  if (!incidencia) return;
  abrirModal({
    titulo: 'Resolver incidencia',
    cuerpo: `
      <p class="sub" style="margin-bottom:14px"><b>${esc(incidencia.tipo)}</b> — ${esc(incidencia.descripcion)}</p>
      <label class="campo"><span>Cómo se resolvió</span>
        <textarea id="inc-resolucion" rows="3"
          placeholder="Acuerdo, reposición, corrección aplicada…"></textarea></label>`,
    botones: [
      { texto: 'Cancelar', accion: cerrarModal },
      { texto: 'Marcar resuelta', clase: 'btn btn-primary', accion: async () => {
        try {
          await api(`/api/incidencias/${incidencia.id}`, {
            method: 'PATCH',
            body: JSON.stringify({ resolucion: $('#inc-resolucion').value })
          });
          cerrarModal();
          aviso('Incidencia resuelta.');
          alTerminar();
        } catch (e) { aviso(e.message, 'error'); }
      } }
    ]
  });
}

/* ──────────────────────────── hoja de detalle ───────────────────────── */

async function abrirDetalle(id, seccion) {
  const r = await api(`/api/remisiones/${id}`);
  estado.remisionActual = r;
  estado.seccionDetalle = seccion || estado.seccionDetalle || 'resumen';
  $('#sheet-titulo').textContent = r.folio;

  const secciones = [
    ['resumen', 'Recepción'],
    ['digitalizacion', 'Digitalización'],
    ['incidencias', `Incidencias${r.incidencias_abiertas ? ` · ${r.incidencias_abiertas}` : ''}`],
    ['devolucion', 'Devolución'],
    ['historial', 'Historial']
  ];

  $('#sheet-body').innerHTML = `
    <div class="card">
      <div class="card-body">
        <div class="detalle-cab">
          <div>
            <h3>${esc(r.folio)}</h3>
            <p class="sub">${fechaLarga(r.fecha)}${r.hora ? ` · ${esc(r.hora)} h` : ''}</p>
          </div>
          <div style="display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end">
            <span class="pill ${clase(r.estado)}">${esc(r.estado)}</span>
            ${r.incidencias_abiertas ? `<span class="pill alta">${num(r.incidencias_abiertas)} incidencia${r.incidencias_abiertas > 1 ? 's' : ''}</span>` : ''}
          </div>
        </div>
        <div class="datos" style="margin-top:18px">
          <div class="dato"><span>Dependencia</span><b>${esc(r.dependencia)}</b><span>${esc(r.area || '')} · recibido en ${esc(r.sede)}</span></div>
          <div class="dato"><span>Documentos</span><b>${num(r.carpetas)} carpeta${r.carpetas === 1 ? '' : 's'} en ${num(r.cajas)} caja${r.cajas === 1 ? '' : 's'}</b>
            <span>${num(r.total_fojas)} fojas</span></div>
          <div class="dato"><span>Carpetas terminadas</span><b>${num(r.carpetas_terminadas)} de ${num(r.carpetas)}</b>
            <span>${num(r.total_imagenes)} imágenes · recosidas y verificadas</span></div>
        </div>
        ${r.eliminada_en ? `<div class="banner banner-rojo">
          <b>Remisión eliminada</b> por ${esc(r.eliminada_por)} el ${fechaHora(r.eliminada_en)}.
          Se conserva con todo su historial, solo para consulta.</div>` : ''}
        ${r.cancelada_en ? `<div class="banner">
          <b>Recepción cancelada</b> por ${esc(r.cancelada_por)} el ${fechaHora(r.cancelada_en)}:
          ${esc(r.cancelacion_motivo)}</div>` : ''}
      </div>
    </div>

    <div class="segmented sheet-tabs" id="sheet-tabs">
      ${secciones.map(([clave, texto]) => `
        <button type="button" data-seccion="${clave}"${clave === estado.seccionDetalle ? ' class="is-active"' : ''}>${texto}</button>`).join('')}
    </div>

    <div id="sheet-seccion"></div>`;

  $$('#sheet-tabs button').forEach((b) => b.addEventListener('click', () => {
    estado.seccionDetalle = b.dataset.seccion;
    $$('#sheet-tabs button').forEach((x) => x.classList.toggle('is-active', x === b));
    pintarSeccion(r);
  }));

  pintarSeccion(r);
  $('#sheet-fondo').hidden = false;
  document.body.style.overflow = 'hidden';
}

function pintarSeccion(r) {
  const pintores = {
    resumen: secResumen,
    digitalizacion: secDigitalizacion,
    incidencias: secIncidencias,
    devolucion: secDevolucion,
    historial: secHistorial
  };
  $('#sheet-seccion').innerHTML = pintores[estado.seccionDetalle](r);
  conectarSeccion(r);
}

/* ═════════════════════════ cotejo de carpetas ═════════════════════════ */

const COTEJOS = {
  validacion: {
    titulo: 'Validación de la recepción',
    accion: 'Validar recepción',
    columna: 'Verificado',
    campoCantidad: 'cantidad_verificada',
    campoFojas: 'fojas_verificadas',
    por: 'validada_por', en: 'validada_en', notas: 'validacion_notas',
    explica: `Cuenta el lote físico y confirma que coincide con lo asentado.
              Los campos vienen con lo capturado: corrige solo lo que no cuadre.`,
    vacio: 'Sin validar. Nadie ha contado el lote contra lo que se asentó al recibirlo.'
  },
  /* la devolución se revisa caja por caja, como se recibió, y asienta también
     la situación en que sale cada carpeta */
  cotejo: {
    titulo: 'Cotejo de la devolución',
    accion: 'Cotejar devolución',
    columna: 'Devuelto',
    campoCantidad: 'cantidad_devuelta',
    campoFojas: 'fojas_devueltas',
    campoSituacion: 'situacion_devuelta',
    por: 'cotejo_por', en: 'cotejo_en', notas: 'cotejo_notas',
    explica: `Revisa caja por caja que cada carpeta sale con las mismas fojas y en la misma
              situación en que se recibió. Todo viene precargado igual que la recepción:
              corrige solo lo que cambió. Sin este cotejo no se puede firmar el acuse.`,
    vacio: 'Sin cotejar. Hay que confirmar, caja por caja, que se devuelve lo mismo que se recibió.'
  }
};

const signo = (n) => `${n > 0 ? '+' : ''}${num(n)}`;

/** Resumen corto de las diferencias de un cotejo. */
function textoDiferencia(docs, fojas, cambios) {
  const partes = [];
  if (docs || fojas) partes.push(`${signo(docs)} carpetas · ${signo(fojas)} fojas`);
  if (cambios) partes.push(`${num(cambios)} con cambio de situación`);
  return partes.join(' · ');
}

/** La validación se cierra en cuanto empieza la digitalización; el cotejo
 *  de la devolución se abre solo cuando todas las carpetas terminaron. */
function puedeCotejar(r, tipo) {
  if (r.edicion === 'bloqueada') return false;
  if (!puede(tipo === 'validacion' ? 'recepcion' : 'devueltas')) return false;
  if (tipo === 'validacion') return !r.documentos.some((d) => d.prep_en);
  return r.documentos.every((d) => d.etapa === 'Recosida') && !r.dev_firmado_en;
}

function tarjetaCotejo(r, tipo) {
  const c = COTEJOS[tipo];
  const resumen = r[tipo];
  const hecho = Boolean(r[c.en]);
  const parcial = resumen.revisadas > 0 && !resumen.completo;
  const cambios = resumen.cambios || 0;
  const difiere = resumen.documentos !== 0 || resumen.fojas !== 0 || cambios !== 0;

  const fila = (d, n) => {
    const cant = d[c.campoCantidad];
    const fojas = d[c.campoFojas];
    const sinRevisar = cant === null || cant === undefined;
    const dCant = sinRevisar ? 0 : cant - d.cantidad;
    const dFojas = sinRevisar ? 0 : (fojas ?? d.fojas) - d.fojas;
    const sale = c.campoSituacion ? d[c.campoSituacion] : '';
    const cambio = Boolean(sale) && sale !== d.situacion;
    return `
      <tr style="cursor:default">
        <td>${n ? `<span class="celda-sec">${n}.</span>` : `<span class="celda-sec">Caja ${d.caja} ·</span>`}
          ${nombreCarpeta(d)}
          ${c.campoSituacion ? `<div class="celda-sec">${cambio
            ? `<span style="color:var(--red)">${esc(d.situacion)} → ${esc(sale)}</span>`
            : esc(d.situacion)}</div>` : ''}</td>
        <td class="num">${num(d.cantidad)} · ${num(d.fojas)}</td>
        <td class="num">${sinRevisar ? '—' : `${num(cant)} · ${num(fojas ?? 0)}`}</td>
        <td class="num">${sinRevisar ? '<span class="celda-sec">sin revisar</span>'
          : (dCant || dFojas || cambio
              ? `<b style="color:var(--red)">${[dCant || dFojas ? `${signo(dCant)} · ${signo(dFojas)}` : '',
                  cambio ? 'situación' : ''].filter(Boolean).join(' · ')}</b>`
              : '<span class="celda-sec">sin cambios</span>')}</td>
      </tr>`;
  };
  const filas = c.campoSituacion
    ? filasPorCaja(r.documentos, 4, fila)
    : r.documentos.map((d) => fila(d)).join('');

  return `
    <div class="card">
      <div class="card-head">
        <h2>${c.titulo}</h2>
        ${puedeCotejar(r, tipo) ? `<button class="link-btn" data-cotejar="${tipo}">${hecho || parcial ? 'Revisar de nuevo' : c.accion}</button>` : ''}
      </div>
      <div class="card-body">
        ${hecho ? `
          <div class="lista-fila" style="padding:0;border:0">
            <div class="principal">
              <b>${difiere ? 'Cotejado con diferencias'
                : (c.campoSituacion ? 'Sale igual que se recibió' : 'Cotejado sin diferencias')}</b>
              <div class="secundario">
                ${esc(r[c.por] || '—')} · ${new Date(r[c.en]).toLocaleString('es-MX',
                  { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })}
              </div>
            </div>
            <span class="pill ${difiere ? 'alta' : 'digitalizado'}">
              ${difiere ? textoDiferencia(resumen.documentos, resumen.fojas, cambios) : 'Coincide'}
            </span>
          </div>`
        : `<p class="sub">${parcial
            ? `Revisadas ${num(resumen.revisadas)} de ${num(resumen.total)} carpetas; falta terminar.`
            : c.vacio}</p>`}

        ${r[c.notas] ? `<p class="sub" style="margin-top:12px;color:var(--text)">
          <b>Nota:</b> ${esc(r[c.notas])}</p>` : ''}
      </div>
      ${resumen.revisadas ? `
      <div class="card-body no-pad">
        <table class="tabla">
          <thead><tr><th>Carpeta</th><th class="num">${c.campoSituacion ? 'Recibido' : 'Asentado'}</th>
            <th class="num">${c.columna}</th><th class="num">Diferencia</th></tr></thead>
          <tbody>${filas}</tbody>
        </table>
      </div>` : ''}
    </div>`;
}

function abrirCotejo(r, tipo, alTerminar) {
  const c = COTEJOS[tipo];
  const conSituacion = Boolean(c.campoSituacion);
  const situaciones = estado.catalogos.situaciones || [];

  const filaCaptura = (d, n) => {
    const sale = (conSituacion && d[c.campoSituacion]) || d.situacion;
    // una situación que ya no está en el catálogo se ofrece igual, para no cambiarla sin querer
    const opciones = [...new Set([d.situacion, sale, ...situaciones])];
    return `
      <tr style="cursor:default" data-doc="${d.id}" data-caja="${d.caja}" data-cantidad="${d.cantidad}"
          data-fojas="${d.fojas}" data-situacion="${esc(d.situacion)}">
        <td>${n ? `<span class="celda-sec">${n}.</span>` : `<span class="celda-sec">Caja ${d.caja} ·</span>`}
          ${nombreCarpeta(d)}
          ${conSituacion ? `<div class="celda-sec">Se recibió: ${num(d.fojas)} fojas · ${esc(d.situacion)}</div>` : ''}</td>
        ${conSituacion ? '' : `<td class="num celda-sec">${num(d.cantidad)} · ${num(d.fojas)}</td>`}
        <td><input type="number" class="c-cantidad" min="0" step="1" aria-label="Cantidad"
              value="${d[c.campoCantidad] ?? d.cantidad}"></td>
        <td><input type="number" class="c-fojas" min="0" step="1" aria-label="Fojas"
              value="${d[c.campoFojas] ?? d.fojas}"></td>
        ${conSituacion ? `<td><select class="c-situacion" aria-label="Situación al devolver">
            ${opciones.map((s) => `<option${s === sale ? ' selected' : ''}>${esc(s)}</option>`).join('')}
          </select></td>` : ''}
        <td class="num c-dif"></td>
      </tr>`;
  };

  // en la devolución se presenta con la misma estructura de cajas que la recepción
  const cuerpoTabla = conSituacion
    ? agruparCajas(r.documentos).map((caja) => `
        <tr class="fila-caja" data-encabezado="${caja.caja}"><td colspan="5">
          <div class="cotejo-caja">
            <span><b>Caja ${caja.caja}</b> · ${num(caja.carpetas.length)} carpeta${caja.carpetas.length === 1 ? '' : 's'}
              · se recibieron ${num(caja.fojas)} fojas · salen <b class="caja-sale"></b>
              <span class="caja-estado"></span></span>
            <button type="button" class="link-btn" data-igual="${caja.caja}">Sale igual que se recibió</button>
          </div></td></tr>
        ${caja.carpetas.map((d, i) => filaCaptura(d, i + 1)).join('')}`).join('')
    : r.documentos.map((d) => filaCaptura(d)).join('');

  abrirModal({
    titulo: `${c.titulo} · ${r.folio}`,
    ancho: conSituacion,
    cuerpo: `
      <p class="sub" style="margin-bottom:14px">${c.explica}</p>
      <table class="tabla">
        <thead><tr><th>Carpeta</th>
          ${conSituacion ? '' : '<th class="num">Asentado</th>'}
          <th style="width:${conSituacion ? 86 : 104}px">Cantidad</th>
          <th style="width:${conSituacion ? 86 : 104}px">Fojas</th>
          ${conSituacion ? '<th style="width:180px">Situación al devolver</th>' : ''}
          <th class="num">Dif.</th></tr></thead>
        <tbody>${cuerpoTabla}</tbody>
      </table>
      <label class="campo" style="margin-top:16px"><span>Nota del cotejo</span>
        <textarea id="c-notas" rows="2"
          placeholder="Obligatoria si algo no coincide: a qué se debe la diferencia.">${esc(r[c.notas] || '')}</textarea></label>
      <p class="sub" id="c-resumen" style="margin-top:10px"></p>`,
    botones: [
      { texto: 'Cancelar', accion: cerrarModal },
      { texto: 'Guardar cotejo', clase: 'btn btn-primary', accion: async () => {
        const documentos = $$('#modal-cuerpo tr[data-doc]').map((tr) => ({
          id: Number(tr.dataset.doc),
          cantidad: tr.querySelector('.c-cantidad').value,
          fojas: tr.querySelector('.c-fojas').value,
          situacion: tr.querySelector('.c-situacion')?.value
        }));
        try {
          await api(`/api/remisiones/${r.id}/${tipo}`, {
            method: 'PUT',
            body: JSON.stringify({ documentos, notas: $('#c-notas').value })
          });
          cerrarModal();
          aviso(tipo === 'validacion' ? 'Recepción validada.' : 'Devolución cotejada.');
          alTerminar();
        } catch (e) { aviso(e.message, 'error'); }
      } }
    ]
  });

  const recalcular = () => {
    let docs = 0, fojas = 0, cambios = 0;
    const porCaja = new Map();
    $$('#modal-cuerpo tr[data-doc]').forEach((tr) => {
      const fojasSale = Number(tr.querySelector('.c-fojas').value || 0);
      const dc = Number(tr.querySelector('.c-cantidad').value || 0) - Number(tr.dataset.cantidad);
      const df = fojasSale - Number(tr.dataset.fojas);
      const sel = tr.querySelector('.c-situacion');
      const cambio = sel ? sel.value !== tr.dataset.situacion : false;
      docs += dc; fojas += df; cambios += cambio ? 1 : 0;
      tr.querySelector('.c-dif').innerHTML = (dc || df || cambio)
        ? `<b style="color:var(--red)">${[dc || df ? `${signo(dc)} · ${signo(df)}` : '', cambio ? 'situación' : '']
            .filter(Boolean).join(' · ')}</b>`
        : '<span class="celda-sec">=</span>';
      const caja = porCaja.get(tr.dataset.caja) || { fojas: 0, difiere: false };
      caja.fojas += fojasSale;
      caja.difiere ||= Boolean(dc || df || cambio);
      porCaja.set(tr.dataset.caja, caja);
    });
    porCaja.forEach((caja, numero) => {
      const encabezado = $(`#modal-cuerpo tr[data-encabezado="${numero}"]`);
      if (!encabezado) return;
      encabezado.querySelector('.caja-sale').textContent = `${num(caja.fojas)} fojas`;
      encabezado.querySelector('.caja-estado').innerHTML = caja.difiere
        ? '· <b style="color:var(--red)">con diferencias</b>'
        : '· <span style="color:var(--green)">sin cambios</span>';
    });
    $('#c-resumen').innerHTML = (docs || fojas || cambios)
      ? `<b style="color:var(--red)">Diferencia total: ${textoDiferencia(docs, fojas, cambios)}.</b>
         Explica a qué se debe antes de guardar.`
      : (conSituacion ? 'Todas las cajas salen igual que se recibieron.' : 'Todo coincide con lo asentado.');
  };

  // devuelve una caja completa a lo que se asentó al recibirla
  $$('#modal-cuerpo [data-igual]').forEach((b) => b.addEventListener('click', () => {
    $$(`#modal-cuerpo tr[data-doc][data-caja="${b.dataset.igual}"]`).forEach((tr) => {
      tr.querySelector('.c-cantidad').value = tr.dataset.cantidad;
      tr.querySelector('.c-fojas').value = tr.dataset.fojas;
      tr.querySelector('.c-situacion').value = tr.dataset.situacion;
    });
    recalcular();
  }));
  $$('#modal-cuerpo input, #modal-cuerpo select').forEach((i) => i.addEventListener('input', recalcular));
  recalcular();
}

/* ─────────────────────────── sección: recepción ─────────────────────── */

function secResumen(r) {
  return `
    <div class="card">
      <div class="card-head"><h2>Datos de la entrega</h2></div>
      <div class="card-body">
        <div class="datos">
          <div class="dato"><span>Entrega</span><b>${esc(r.entrega_nombre)}</b><span>${esc(r.entrega_cargo || '')}</span></div>
          <div class="dato"><span>Recepciona</span><b>${esc(r.recibe_nombre)}</b><span>${esc(r.recibe_cargo || '')}</span></div>
          <div class="dato"><span>Capturado</span><b>${fechaHora(r.creado_en)}</b></div>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-head"><h2>Cajas y carpetas</h2></div>
      <div class="card-body no-pad">
        <table class="tabla">
          <thead><tr><th>#</th><th>Carpeta (NUC)</th><th>Folios</th><th class="num">Fojas</th><th>Situación</th></tr></thead>
          <tbody>${filasPorCaja(r.documentos, 5, (d, n) => `
            <tr style="cursor:default">
              <td class="celda-sec">${n}</td>
              <td>${nombreCarpeta(d)}${d.observaciones ? `<div class="celda-sec">${esc(d.observaciones)}</div>` : ''}</td>
              <td class="celda-sec">${foliosDe(d)}</td>
              <td class="num">${num(d.fojas)}</td>
              <td><span class="pill">${esc(d.situacion)}</span></td>
            </tr>`)}
          </tbody>
        </table>
      </div>
    </div>

    ${tarjetaCotejo(r, 'validacion')}

    ${r.observaciones ? `<div class="card"><div class="card-head"><h2>Observaciones</h2></div>
      <div class="card-body"><p class="sub" style="color:var(--text)">${esc(r.observaciones)}</p></div></div>` : ''}

    <div class="card">
      <div class="card-head"><h2>Acuse y etiquetas</h2></div>
      <div class="card-body">
        <div class="qr-caja">
          ${QR.svg(r.folio, { modulo: 4, margen: 2 })}
          <p>Cada caja lleva este código con el folio <b>${esc(r.folio)}</b>.
             Al escanearlo con cualquier teléfono se obtiene el folio para buscarlo en la bitácora.</p>
        </div>
        <div class="acciones-detalle" style="margin-top:16px">
          ${r.firmado_en || r.edicion === 'bloqueada' ? '' : '<button class="btn btn-primary" id="det-firmar">Firmar acuse</button>'}
          <button class="btn" id="det-acuse">Imprimir acuse</button>
          <button class="btn" id="det-etiquetas">Imprimir etiquetas${r.cajas ? ` (${num(r.cajas)})` : ''}</button>
        </div>
        ${r.firmado_en ? `
          <div class="firma-hecha" style="margin-top:18px">
            ${r.firma_entrega ? `<figure><img src="${r.firma_entrega}" alt="Firma de quien entrega">
              <figcaption>Entrega · ${esc(r.entrega_nombre)}</figcaption></figure>` : ''}
            ${r.firma_recibe ? `<figure><img src="${r.firma_recibe}" alt="Firma de quien recibe">
              <figcaption>Recibe · ${esc(r.recibe_nombre)}</figcaption></figure>` : ''}
          </div>
          <p class="sub" style="margin-top:10px">Firmado el ${new Date(r.firmado_en).toLocaleString('es-MX')}
             · ya no se modifica; un cambio requiere una corrección autorizada.</p>` : `
          <p class="sub" style="margin-top:14px">Sin firmar. El acuse se puede imprimir en blanco para firma a mano.</p>`}
      </div>
    </div>

    ${tarjetaCambios(r)}`;
}

/* Nada se borra: la recepción se edita mientras no esté validada ni firmada;
   después, solo con una corrección autorizada. Cancelar y eliminar dejan
   la remisión guardada con su motivo y su historial. */
const EXPLICA_EDICION = {
  libre: 'Mientras no se valide ni se firme, la recepción se puede editar. Cada cambio queda en el historial con el antes y el después.',
  autorizada: 'Hay una corrección autorizada: al guardar se anulan la firma y la validación, y hay que volver a hacerlas.',
  requiere_solicitud: 'La recepción ya está validada o firmada. Para cambiarla hay que solicitar una corrección, que autoriza un supervisor distinto de quien la pide.',
  en_proceso: 'Las carpetas ya entraron a digitalización: los datos de la recepción quedaron cerrados. Cualquier hallazgo se registra como incidencia.',
  bloqueada: 'Esta remisión está cancelada o eliminada: solo se puede consultar.'
};

function tarjetaCambios(r) {
  const iniciada = r.documentos.some((d) => d.prep_en);
  const enCurso = (tipo) => r.solicitudes.some((s) => s.tipo === tipo && ['Pendiente', 'Aprobada'].includes(s.estado));
  const yo = estado.sesion.usuario.nombre;
  const botones = !puede('recepcion') ? [] : [
    ['libre', 'autorizada'].includes(r.edicion) && '<button class="btn" id="det-editar">Editar recepción</button>',
    r.edicion === 'requiere_solicitud' && !enCurso('Corrección') &&
      '<button class="btn" data-solicitar="Corrección">Solicitar corrección</button>',
    r.puede_cancelar && ['Supervisor', 'Recepción'].includes(rol()) &&
      '<button class="btn btn-danger" id="det-cancelar">Cancelar recepción</button>',
    !r.eliminada_en && !iniciada && !enCurso('Eliminación') &&
      '<button class="btn btn-danger" data-solicitar="Eliminación">Solicitar eliminación</button>'
  ].filter(Boolean);

  return `
    <div class="card">
      <div class="card-head"><h2>Cambios a la recepción</h2></div>
      <div class="card-body">
        <p class="sub">${EXPLICA_EDICION[r.edicion]}</p>
        ${botones.length ? `<div class="acciones-detalle" style="margin-top:14px">${botones.join('')}</div>` : ''}
      </div>
      ${r.solicitudes.length ? `
      <div class="card-body no-pad"><div class="lista">${r.solicitudes.map((s) => `
        <div class="lista-fila" style="align-items:flex-start">
          <div class="principal">
            <b>${esc(s.tipo)}</b> <span class="pill ${clase(s.estado)}">${esc(s.estado)}</span>
            <div class="secundario">${esc(s.motivo)}</div>
            <div class="secundario">Pidió ${esc(s.solicitada_por)} · ${fechaHora(s.solicitada_en)}
              ${s.resuelta_en ? ` · resolvió ${esc(s.resuelta_por)} · ${fechaHora(s.resuelta_en)}` : ''}
              ${s.respuesta ? ` · «${esc(s.respuesta)}»` : ''}</div>
          </div>
          ${s.estado === 'Pendiente' && esSupervisor() && s.solicitada_por !== yo ? `
            <div style="white-space:nowrap">
              <button class="link-btn" data-aprobar="${s.id}">Aprobar</button>
              <button class="link-btn" data-rechazar="${s.id}" style="color:var(--red);margin-left:10px">Rechazar</button>
            </div>` : ''}
        </div>`).join('')}</div></div>` : ''}
    </div>`;
}

/** Un supervisor aprueba o rechaza; rechazar exige explicar por qué. */
async function resolverSolicitud(solicitudId, aprobar, alTerminar) {
  let respuesta = '';
  if (aprobar) {
    if (!confirm('¿Aprobar la solicitud? Queda registrado a tu nombre.')) return;
  } else {
    respuesta = await pedirMotivo({
      titulo: 'Rechazar solicitud', explica: 'Explica a quien la pidió por qué se rechaza.',
      etiqueta: 'Respuesta', boton: 'Rechazar', peligro: true, minimo: 5
    });
    if (!respuesta) return;
  }
  try {
    await api(`/api/solicitudes/${solicitudId}`, { method: 'PUT', body: JSON.stringify({ aprobar, respuesta }) });
    aviso(aprobar ? 'Solicitud aprobada.' : 'Solicitud rechazada.');
    alTerminar();
  } catch (e) { aviso(e.message, 'error'); }
}

/** Pide un texto obligatorio (motivo, respuesta…) antes de una acción. */
function pedirMotivo({ titulo, explica, etiqueta = 'Motivo', boton, peligro = false, minimo = 10 }) {
  return new Promise((resolver) => {
    abrirModal({
      titulo,
      cuerpo: `
        <p class="sub" style="margin-bottom:14px">${explica}</p>
        <label class="campo"><span>${esc(etiqueta)}</span>
          <textarea id="m-motivo" rows="3"></textarea></label>`,
      botones: [
        { texto: 'Volver', accion: () => { cerrarModal(); resolver(null); } },
        { texto: boton, clase: `btn ${peligro ? 'btn-danger' : 'btn-primary'}`, accion: () => {
          const motivo = $('#m-motivo').value.trim();
          if (motivo.length < minimo) return aviso(`Escribe al menos ${minimo} caracteres.`, 'error');
          cerrarModal();
          resolver(motivo);
        } }
      ]
    });
    $('#m-motivo').focus();
  });
}

/* ────────────────────────── sección: digitalización ─────────────────── */

/* Cada carpeta avanza en orden: preparación (descosido, revisión y retiro
   de insertos) → mesa → escaneo → reintegración y recosido. Nada salta un paso. */

const ACCION_ETAPA = {
  'Por asignar': ['data-a-mesa', 'Asignar a mesa'],
  'En mesa': ['data-preparar', 'Descoser y revisar'],
  'Descosida': ['data-escaneo', 'Registrar escaneo'],
  'Escaneada': ['data-recoser', 'Reintegrar y recoser']
};

/** ¿Puede esta persona trabajar esta carpeta? Solo la sede donde está y,
 *  si trabaja en una mesa, solo lo de su mesa. */
function aMiAlcance(d) {
  const yo = estado.sesion.usuario;
  if (!puede('digitalizacion')) return false;
  if (yo.rol === 'Supervisor') return true;
  if (yo.rol === 'Mesa') return d.mesa_id === yo.mesa_id;
  return d.sede_id === yo.sede_id && !d.en_transito;
}

function secDigitalizacion(r) {
  const cerrada = r.edicion === 'bloqueada';
  const ultima = (d) => r.asignaciones.filter((a) => a.documento_id === d.id).at(-1);
  const insertosDe = (d) => r.insertos.filter((i) => i.documento_id === d.id);

  const fila = (d, n) => {
    const a = ultima(d);
    const ins = insertosDe(d);
    const pendientes = ins.filter((i) => !i.reintegrado_en).length;
    // una carpeta escaneada sin su PDF primero lo sube; después se recose
    const [atributo, texto] = d.etapa === 'Escaneada' && !d.archivo
      ? ['data-subir-pdf', 'Subir PDF'] : ACCION_ETAPA[d.etapa] || [];
    const repetir = d.etapa === 'Por asignar' && a && !a.cuadra;
    return `
      <tr style="cursor:default">
        <td class="celda-sec">${n}</td>
        <td>${nombreCarpeta(d)}<div class="celda-sec">${foliosDe(d)} · ${num(d.fojas)} fojas</div></td>
        <td><span class="pill etapa-${clase(d.etapa)}">${esc(d.etapa)}</span>
          ${repetir ? '<div class="celda-sec" style="color:var(--red)">escaneo incompleto: asignar de nuevo</div>' : ''}</td>
        <td>${d.en_transito ? `<span class="pill en-digitalizacion">${esc(d.ubicacion)}</span>` : esc(d.ubicacion)}
          ${a ? `<div class="celda-sec">${d.mesa_id ? esc(a.responsable) : `última mesa: ${esc(a.mesa)}`}${a.cuadra
            ? ` · ${num(a.fojas_escaneadas)} fojas, ${num(a.imagenes)} imágenes` : ''}</div>` : ''}</td>
        <td>${ins.length ? `${num(ins.length)}<div class="celda-sec">${pendientes
            ? `${num(pendientes)} por reintegrar` : 'reintegrados'}</div>` : '<span class="celda-sec">—</span>'}</td>
        <td>${d.archivo ? `${puedeAbrirPdf(d) ? enlacePdf(d.archivo.id, `PDF · ${num(d.archivo.paginas)} págs.`)
              : `<span class="celda-sec">PDF · ${num(d.archivo.paginas)} págs.</span>`}
            ${aMiAlcance(d) && !r.dev_firmado_en && !cerrada
              ? `<div><button class="link-btn" data-reemplazar-pdf="${d.id}" style="font-size:12px">Reemplazar</button></div>` : ''}`
          : '<span class="celda-sec">—</span>'}</td>
        <td style="text-align:right;white-space:nowrap">
          ${atributo && !cerrada && aMiAlcance(d) ? `<button class="link-btn" ${atributo}="${d.id}"
              ${d.etapa === 'Por asignar' && !r.validada_en ? 'disabled title="Primero valida la recepción"' : ''}>${texto}</button>`
            : d.etapa === 'Recosida' ? '<span class="celda-sec">Terminada</span>' : ''}
          <button class="link-btn" data-traza="${d.id}" style="margin-left:10px">Trazabilidad</button>
        </td>
      </tr>`;
  };

  const cuerpo = agruparCajas(r.documentos).map((caja) => {
    const listas = r.validada_en ? caja.carpetas.filter((d) => d.etapa === 'Por asignar' && aMiAlcance(d)) : [];
    return `
      <tr class="fila-caja"><td colspan="7"><div class="cotejo-caja">
        <span><b>Caja ${caja.caja}</b> · ${num(caja.carpetas.length)} carpeta${caja.carpetas.length === 1 ? '' : 's'}
          · ${num(caja.carpetas.filter((d) => d.etapa === 'Recosida').length)} terminada${caja.carpetas.filter((d) => d.etapa === 'Recosida').length === 1 ? '' : 's'}</span>
        ${listas.length && !cerrada ? `<button type="button" class="link-btn" data-caja-a-mesa="${caja.caja}">
          Asignar ${num(listas.length)} a mesa</button>` : ''}
      </div></td></tr>
      ${caja.carpetas.map((d, i) => fila(d, i + 1)).join('')}`;
  }).join('');

  return `
    <div class="card">
      <div class="card-head"><h2>Avance por carpeta</h2></div>
      <div class="card-body">
        <div class="etapas">${estado.catalogos.etapas.map((e) => `
          <div class="etapa"><span>${esc(e)}</span><b>${num(r.etapas[e] || 0)}</b></div>`).join('')}</div>
        ${!r.validada_en && !cerrada ? `<div class="banner" style="margin-top:14px">
          <b>Primero hay que validar la recepción</b> (pestaña Recepción): contar el lote contra lo asentado.
          Hasta entonces ninguna carpeta puede asignarse a una mesa.</div>` : ''}
      </div>
      <div class="card-body no-pad">
        <table class="tabla">
          <thead><tr><th>#</th><th>Carpeta (NUC)</th><th>Etapa</th><th>Dónde está</th><th>Insertos</th><th>Expediente</th><th></th></tr></thead>
          <tbody>${cuerpo}</tbody>
        </table>
      </div>
    </div>`;
}

/** Dónde estaba un inserto: «hoja 45, reverso». */
const ubicacionInserto = (i) => `hoja ${num(i.foja)}${i.lado ? `, ${esc(i.lado.toLowerCase())}` : ''}`;

/* ── 2. en la mesa: descosido, revisión y retiro de insertos ── */
function prepararCarpeta(r, d, alTerminar) {
  const tipos = estado.catalogos.tipos_inserto || [];
  const lados = estado.catalogos.lados_inserto || [];
  const filaInserto = () => `
    <div class="inserto">
      <select class="i-tipo" aria-label="Tipo">${tipos.map((x) => `<option>${esc(x)}</option>`).join('')}</select>
      <input class="i-descripcion" aria-label="Descripción" placeholder="Qué dice o qué es">
      <input type="number" class="i-foja" aria-label="Número de hoja" min="0" placeholder="Hoja">
      <select class="i-lado" aria-label="Lado de la hoja"><option value="">Lado…</option>
        ${lados.map((x) => `<option>${esc(x)}</option>`).join('')}</select>
      <button type="button" class="quitar" aria-label="Quitar">×</button>
    </div>`;
  const foliada = d.situacion !== 'Sin foliar';

  abrirModal({
    titulo: `Descoser y revisar · ${d.nuc || d.descripcion}`,
    ancho: true,
    cuerpo: `
      <p class="sub" style="margin-bottom:14px">Caja ${d.caja} · ${foliosDe(d)} · se asentaron <b>${num(d.fojas)} fojas</b>.</p>
      <label class="check"><input type="checkbox" id="p-descosida"> Se retiró el estambre (carpeta descosida)</label>
      ${foliada ? `<label class="check"><input type="checkbox" id="p-folios">
        Se revisaron los folios ${num(d.folio_inicial)} a ${num(d.folio_final)}: están completos y en orden</label>` : ''}
      <label class="campo" style="margin-top:12px;max-width:220px"><span>Fojas contadas</span>
        <input type="number" id="p-fojas" min="0" step="1"></label>

      <div style="margin-top:18px">
        <div class="cotejo-caja"><b>Post-its y documentos sueltos retirados</b>
          <button type="button" class="link-btn" id="p-agregar">Agregar inserto</button></div>
        <p class="sub" style="margin:4px 0 8px">Anota en qué hoja estaba cada uno (su número de folio) y de qué lado:
          al frente, al reverso o suelto entre esa hoja y la siguiente. Al recoser habrá que confirmar que volvió ahí.</p>
        <div class="inserto inserto-cols" id="p-insertos-cols" hidden aria-hidden="true">
          <span>Tipo</span><span>Qué es</span><span>Hoja</span><span>Lado</span><span></span></div>
        <div id="p-insertos"></div>
      </div>
      <label class="campo" style="margin-top:12px"><span>Notas</span><textarea id="p-notas" rows="2"></textarea></label>`,
    botones: [
      { texto: 'Cancelar', accion: cerrarModal },
      { texto: 'Registrar', clase: 'btn btn-primary', accion: () => enviar(`/api/remisiones/${r.id}/carpetas/${d.id}/preparacion`, {
        descosida: $('#p-descosida').checked,
        folios_completos: foliada ? $('#p-folios').checked : undefined,
        fojas_contadas: $('#p-fojas').value,
        insertos: $$('#p-insertos .inserto').map((i) => ({
          tipo: i.querySelector('.i-tipo').value,
          descripcion: i.querySelector('.i-descripcion').value,
          foja: i.querySelector('.i-foja').value,
          lado: i.querySelector('.i-lado').value
        })),
        notas: $('#p-notas').value
      }, 'Carpeta descosida y revisada.', alTerminar) }
    ]
  });
  $('#p-agregar').addEventListener('click', () => {
    $('#p-insertos').insertAdjacentHTML('beforeend', filaInserto());
    const nueva = $$('#p-insertos .inserto').at(-1);
    $('#p-insertos-cols').hidden = false;
    nueva.querySelector('.quitar').addEventListener('click', () => {
      nueva.remove();
      $('#p-insertos-cols').hidden = !$$('#p-insertos .inserto').length;
    });
    nueva.querySelector('.i-descripcion').focus();
  });
}

/* ── 1. asignación a una mesa ── */
function enviarAMesa(r, carpetas, alTerminar) {
  const mesas = (estado.catalogos.mesas || []).filter((m) => m.activa && m.responsable);
  if (!mesas.length) return aviso('No hay mesas activas con responsable. Un supervisor las da de alta en Personal.', 'error');
  abrirModal({
    titulo: `Asignar a mesa · ${carpetas.length} carpeta${carpetas.length === 1 ? '' : 's'}`,
    cuerpo: `
      <label class="campo"><span>Mesa</span>
        <select id="a-mesa">${mesas.map((m) => `<option value="${m.id}">${esc(m.nombre)} · responsable: ${esc(m.responsable)}</option>`).join('')}</select></label>
      <p class="sub" style="margin:12px 0 6px">Quedará registrado el responsable de la mesa en este momento.</p>
      <div class="lista">${carpetas.map((d) => `<div class="lista-fila"><div class="principal">${nombreCarpeta(d)}
        <div class="secundario">caja ${d.caja} · ${foliosDe(d)} · ${num(d.fojas)} fojas</div></div></div>`).join('')}</div>`,
    botones: [
      { texto: 'Cancelar', accion: cerrarModal },
      { texto: 'Asignar', clase: 'btn btn-primary', accion: () => enviar(`/api/remisiones/${r.id}/mesa`,
        { documentos: carpetas.map((d) => d.id), mesa: $('#a-mesa').value }, 'Carpetas asignadas a la mesa.', alTerminar) }
    ]
  });
}

/* ── 3. escaneo ── */
function registrarEscaneo(r, d, alTerminar) {
  const a = r.asignaciones.filter((x) => x.documento_id === d.id).at(-1);
  abrirModal({
    titulo: `Escaneo · ${d.nuc || d.descripcion}`,
    cuerpo: `
      <p class="sub" style="margin-bottom:14px">${esc(a.mesa)} · responsable ${esc(a.responsable)} · en la mesa desde
        ${fechaHora(a.entrada_en)} · la carpeta tiene <b>${num(d.fojas)} fojas</b> (${foliosDe(d)})</p>
      <div class="campos" style="grid-template-columns:1fr 1fr">
        <label class="campo" style="grid-column:span 1"><span>Fojas escaneadas</span>
          <input type="number" id="e-fojas" min="0" step="1"></label>
        <label class="campo" style="grid-column:span 1"><span>Imágenes generadas</span>
          <input type="number" id="e-imagenes" min="0" step="1"></label>
      </div>
      <p class="sub" id="e-aviso" style="margin-top:8px"></p>
      <label class="campo" style="margin-top:8px"><span>PDF de la carpeta</span>
        <input type="file" id="e-pdf" accept="application/pdf,.pdf"></label>
      <p class="sub" style="margin-top:4px">Un solo PDF con todas las hojas; sus páginas deben coincidir con las imágenes.
        Si aún no lo tienes, podrás subirlo después, pero la carpeta no se recose sin él.</p>
      <label class="campo" style="margin-top:8px"><span>Notas</span>
        <textarea id="e-notas" rows="2" placeholder="Obligatorias si las fojas no cuadran"></textarea></label>`,
    botones: [
      { texto: 'Cancelar', accion: cerrarModal },
      { texto: 'Registrar escaneo', clase: 'btn btn-primary', accion: async (e) => {
        const archivo = $('#e-pdf').files[0];
        e.target.disabled = true;
        try {
          const despues = await api(`/api/remisiones/${r.id}/carpetas/${d.id}/escaneo`, { method: 'POST', body: JSON.stringify({
            fojas_escaneadas: $('#e-fojas').value, imagenes: $('#e-imagenes').value, notas: $('#e-notas').value
          }) });
          cerrarModal();
          const escaneada = despues.documentos.find((x) => x.id === d.id)?.etapa === 'Escaneada';
          if (archivo && escaneada) {
            aviso(`Escaneo registrado. Subiendo el PDF (${tamano(archivo.size)})…`);
            try {
              await subirPdf(r.id, d.id, archivo);
              aviso('Escaneo y PDF registrados.');
            } catch (err) {
              aviso(`El escaneo quedó registrado, pero el PDF no se subió: ${err.message} Súbelo desde la carpeta.`, 'error');
            }
          } else {
            aviso('Escaneo registrado.');
          }
          alTerminar();
        } catch (err) {
          e.target.disabled = false;
          aviso(err.message, 'error');
        }
      } }
    ]
  });
  $('#e-fojas').addEventListener('input', () => {
    const f = Number($('#e-fojas').value);
    $('#e-aviso').innerHTML = $('#e-fojas').value === '' ? ''
      : f === d.fojas ? '<span style="color:var(--green)">Cuadra con las fojas de la carpeta.</span>'
      : `<b style="color:var(--red)">No cuadra: faltan o sobran ${num(Math.abs(d.fojas - f))} fojas.</b> La carpeta tendrá que asignarse de nuevo a una mesa.`;
  });
}

/* ── 4. reintegración de insertos y recosido ── */
function recoserCarpeta(r, d, alTerminar) {
  const pendientes = r.insertos.filter((i) => i.documento_id === d.id && !i.reintegrado_en);
  abrirModal({
    titulo: `Reintegrar y recoser · ${d.nuc || d.descripcion}`,
    cuerpo: `
      ${pendientes.length ? `<p class="sub" style="margin-bottom:8px">Confirma que cada inserto volvió a su lugar:</p>
        ${pendientes.map((i) => `<label class="check"><input type="checkbox" class="r-inserto" value="${i.id}">
          ${esc(i.tipo)}${i.descripcion ? ` «${esc(i.descripcion)}»` : ''} — ${ubicacionInserto(i)}</label>`).join('')}`
        : '<p class="sub" style="margin-bottom:8px">Esta carpeta no tenía post-its ni documentos sueltos.</p>'}
      <label class="check" style="margin-top:10px"><input type="checkbox" id="r-fojas">
        Conserva sus ${num(d.fojas)} fojas (${foliosDe(d)}) completas y en orden</label>
      <label class="check"><input type="checkbox" id="r-cosida"> Se volvió a coser con estambre</label>
      <label class="campo" style="margin-top:12px"><span>Notas</span><textarea id="r-notas" rows="2"></textarea></label>`,
    botones: [
      { texto: 'Cancelar', accion: cerrarModal },
      { texto: 'Registrar recosido', clase: 'btn btn-primary', accion: () => enviar(`/api/remisiones/${r.id}/carpetas/${d.id}/recosido`, {
        insertos_reintegrados: $$('.r-inserto').filter((c) => c.checked).map((c) => Number(c.value)),
        fojas_completas: $('#r-fojas').checked, cosida: $('#r-cosida').checked, notas: $('#r-notas').value
      }, 'Carpeta terminada.', alTerminar) }
    ]
  });
}

/* ── trazabilidad completa de una carpeta ── */
function verTrazabilidad(r, d) {
  const pasos = [
    [r.creado_en, 'Recibida', `${esc(r.recibe_nombre)} · ${num(d.fojas)} fojas, ${foliosDe(d)}, ${esc(d.situacion)}`],
    d.prep_en && [d.prep_en, 'Descosida y revisada', `${esc(d.prep_por)}${d.prep_notas ? ` · ${esc(d.prep_notas)}` : ''}`],
    ...r.insertos.filter((i) => i.documento_id === d.id).flatMap((i) => [
      [i.retirado_en, `${esc(i.tipo)} retirado`, `${esc(i.retirado_por)} · ${ubicacionInserto(i)}${i.descripcion ? ` · ${esc(i.descripcion)}` : ''}`],
      i.reintegrado_en && [i.reintegrado_en, `${esc(i.tipo)} reintegrado`, `${esc(i.reintegrado_por)} · ${ubicacionInserto(i)}`]
    ]),
    ...r.asignaciones.filter((a) => a.documento_id === d.id).flatMap((a) => [
      [a.entrada_en, `A ${esc(a.mesa)}`, `envió ${esc(a.entrada_por)} · responsable ${esc(a.responsable)}`],
      a.salida_en && [a.salida_en, a.cuadra ? 'Escaneada' : 'Escaneo incompleto',
        `${esc(a.salida_por)} · ${num(a.fojas_escaneadas)} de ${num(d.fojas)} fojas, ${num(a.imagenes)} imágenes${a.notas ? ` · ${esc(a.notas)}` : ''}`]
    ]),
    ...(r.archivos || []).filter((a) => a.documento_id === d.id).map((a) => [a.subido_en,
      a.vigente ? 'PDF subido' : 'PDF subido (versión anterior)',
      `${esc(a.subido_por)} · ${num(a.paginas)} páginas · ${tamano(a.bytes)} · SHA-256 ${esc(a.sha256.slice(0, 12))}…${a.motivo ? ` · ${esc(a.motivo)}` : ''}`]),
    d.recosido_en && [d.recosido_en, 'Recosida y verificada', `${esc(d.recosido_por)}${d.recosido_notas ? ` · ${esc(d.recosido_notas)}` : ''}`]
  ].filter(Boolean).sort((a, b) => a[0].localeCompare(b[0]));

  abrirModal({
    titulo: `Trazabilidad · ${d.nuc || d.descripcion}`,
    cuerpo: `<div class="lista">${pasos.map(([fecha, que, detalle]) => `
      <div class="lista-fila"><div class="principal"><b>${que}</b><div class="secundario">${detalle}</div></div>
        <span class="celda-sec">${fechaHora(fecha)}</span></div>`).join('')}</div>`,
    botones: [{ texto: 'Cerrar', clase: 'btn btn-primary', accion: cerrarModal }]
  });
}

/** Envía una acción del flujo; si una regla no se cumple, el mensaje lo explica. */
async function enviar(ruta, cuerpo, mensaje, alTerminar) {
  try {
    await api(ruta, { method: 'POST', body: JSON.stringify(cuerpo) });
    cerrarModal();
    aviso(mensaje);
    alTerminar();
  } catch (e) { aviso(e.message, 'error'); }
}

/* ─────────────────────────── sección: incidencias ───────────────────── */

function secIncidencias(r) {
  return `
    <div class="card">
      <div class="card-head">
        <h2>Incidencias del servicio</h2>
        ${r.eliminada_en ? '' : '<button class="link-btn" id="inc-nueva">Reportar incidencia</button>'}
      </div>
      <div class="card-body no-pad">
        ${r.incidencias.length ? `<div class="lista">${r.incidencias.map((i) => `
          <div class="lista-fila" style="align-items:flex-start${i.anulada_en ? ';opacity:.6' : ''}">
            <div class="principal">
              <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
                <b>${esc(i.tipo)}</b>
                <span class="pill ${clase(i.gravedad)}">${esc(i.gravedad)}</span>
                ${i.anulada_en ? '<span class="pill">Anulada</span>'
                  : `<span class="pill ${i.estado === 'Abierta' ? 'abierta' : 'digitalizado'}">${esc(i.estado)}</span>`}
              </div>
              <div class="secundario" style="margin-top:4px${i.anulada_en ? ';text-decoration:line-through' : ''}">${esc(i.descripcion)}</div>
              ${i.anulada_en ? `<div class="secundario" style="margin-top:4px"><b>Anulada</b> por ${esc(i.anulada_por)}
                el ${fechaHora(i.anulada_en)}: ${esc(i.anulacion_motivo)}</div>` : ''}
              <div class="secundario" style="margin-top:4px">
                Reportó ${esc(i.reportada_por || '—')} el
                ${new Date(i.reportada_en).toLocaleString('es-MX', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}
              </div>
              ${i.estado === 'Resuelta' ? `<div class="secundario" style="margin-top:4px">
                <b>Resolución:</b> ${esc(i.resolucion)} — ${esc(i.resuelta_por || '')}
                ${new Date(i.resuelta_en).toLocaleDateString('es-MX', { day: '2-digit', month: 'short' })}</div>` : ''}
            </div>
            ${i.anulada_en || r.eliminada_en ? '' : `<div style="white-space:nowrap">
              ${i.estado === 'Abierta' ? `<button class="link-btn" data-resolver="${i.id}">Resolver</button>` : ''}
              <button class="link-btn" data-anular-incidencia="${i.id}" style="color:var(--red);margin-left:10px">Anular</button>
            </div>`}
          </div>`).join('')}</div>`
        : vacio('Sin incidencias', 'Registra aquí faltantes, daños, documentos ilegibles o fallas de equipo.')}
      </div>
    </div>`;
}

/* ─────────────────────────── sección: devolución ────────────────────── */

function secDevolucion(r) {
  if (!puede('devueltas')) {
    return '<div class="card"><div class="card-body"><p class="sub">No tienes acceso a la sección Devueltas.</p></div></div>';
  }
  const faltan = r.documentos.filter((d) => d.etapa !== 'Recosida').length;
  if (r.edicion === 'bloqueada') {
    return `<div class="card"><div class="card-body"><p class="sub">${EXPLICA_EDICION.bloqueada}</p></div></div>`;
  }
  if (!r.dev_fecha && faltan) {
    return `
      <div class="card">
        <div class="card-head"><h2>Devolución</h2></div>
        <div class="card-body"><div class="banner">
          <b>Faltan ${num(faltan)} carpeta${faltan === 1 ? '' : 's'} por terminar.</b>
          Un lote solo se devuelve cuando todas sus carpetas están recosidas y verificadas,
          con sus insertos reintegrados (pestaña Digitalización).</div></div>
      </div>`;
  }
  if (!r.dev_fecha) {
    return `
      ${tarjetaCotejo(r, 'cotejo')}
      <div class="card">
        <div class="card-head"><h2>Registrar devolución</h2></div>
        <div class="card-body">
          <p class="sub" style="margin-bottom:16px">
            Al devolver los documentos físicos y entregar las imágenes, registra aquí el punto de
            aceptación. El lote pasa a <b>Devuelto</b> y se genera el acuse de devolución.
          </p>
          ${formDevolucion(r)}
          <div class="acciones-detalle" style="margin-top:18px">
            <button class="btn btn-primary" id="dev-guardar">Registrar devolución</button>
          </div>
        </div>
      </div>`;
  }

  return `
    ${tarjetaCotejo(r, 'cotejo')}

    <div class="card">
      <div class="card-head">
        <h2>Devolución</h2>
        <span class="pill ${clase(r.dev_aceptacion)}">${esc(r.dev_aceptacion)}</span>
      </div>
      <div class="card-body">
        <div class="datos">
          <div class="dato"><span>Fecha</span><b>${fechaCorta(r.dev_fecha)}</b></div>
          <div class="dato"><span>Entrega</span><b>${esc(r.dev_entrega_nombre)}</b><span>${esc(r.dev_entrega_cargo || '')}</span></div>
          <div class="dato"><span>Recibe</span><b>${esc(r.dev_recibe_nombre)}</b><span>${esc(r.dev_recibe_cargo || '')}</span></div>
          <div class="dato"><span>Medio de entrega digital</span><b>${esc(r.dev_medio || '—')}</b></div>
          <div class="dato"><span>Archivos entregados</span><b>${num(r.dev_archivos)}</b></div>
          <div class="dato"><span>Documentos físicos</span><b>${num(r.carpetas)} carpetas en ${num(r.cajas)} cajas</b>
            <span>${num(r.total_fojas)} fojas</span></div>
        </div>
        ${r.dev_observaciones ? `<p class="sub" style="margin-top:14px;color:var(--text)">
          <b>Observaciones:</b> ${esc(r.dev_observaciones)}</p>` : ''}

        ${r.dev_aceptacion === 'Rechazado' ? `<div class="banner banner-rojo" style="margin-top:14px">
          <b>La dependencia no aceptó la entrega.</b> Las carpetas siguen en resguardo: atiende las
          observaciones y corrige los datos de la devolución cuando se vuelva a entregar.</div>` : ''}

        <div class="acciones-detalle" style="margin-top:18px">
          ${r.dev_firmado_en ? '' : `<button class="btn btn-primary" id="dev-firmar"${r.cotejo_en ? '' : ' disabled title="Primero hay que cotejar la devolución"'}>Firmar devolución</button>`}
          <button class="btn" id="dev-acuse">Imprimir acuse de devolución</button>
          ${r.dev_firmado_en ? '' : '<button class="btn" id="dev-editar">Corregir datos</button>'}
          ${esSupervisor() ? '<button class="btn btn-danger" id="dev-cancelar">Cancelar devolución</button>' : ''}
        </div>

        ${r.dev_firmado_en ? `
          <div class="firma-hecha" style="margin-top:18px">
            ${r.dev_firma_entrega ? `<figure><img src="${r.dev_firma_entrega}" alt="Firma de quien entrega">
              <figcaption>Entrega · ${esc(r.dev_entrega_nombre)}</figcaption></figure>` : ''}
            ${r.dev_firma_recibe ? `<figure><img src="${r.dev_firma_recibe}" alt="Firma de quien recibe">
              <figcaption>Recibe · ${esc(r.dev_recibe_nombre)}</figcaption></figure>` : ''}
          </div>
          <p class="sub" style="margin-top:10px">Firmado el ${new Date(r.dev_firmado_en).toLocaleString('es-MX')}
             · los datos de la devolución quedaron cerrados.</p>` : `
          <p class="sub" style="margin-top:14px">Sin firmar. El acuse se puede imprimir en blanco para firma a mano.</p>`}
      </div>
    </div>`;
}

function formDevolucion(r) {
  const cat = estado.catalogos;
  const hoy = hoyLocal();
  const opciones = (lista, actual) => lista.map((v) =>
    `<option${v === actual ? ' selected' : ''}>${esc(v)}</option>`).join('');
  return `
    <div class="campos">
      <label class="campo campo-sm"><span>Fecha de devolución</span>
        <input type="date" id="dev-fecha" value="${esc(r.dev_fecha || hoy)}"></label>
      <label class="campo campo-sm"><span>Medio de entrega digital</span>
        <select id="dev-medio"><option value=""></option>${opciones(cat.medios_entrega, r.dev_medio)}</select></label>
      <label class="campo campo-sm"><span>Archivos o imágenes entregadas</span>
        <input type="number" id="dev-archivos" min="0" step="1" value="${r.dev_archivos || r.total_imagenes || 0}"></label>
      <label class="campo campo-md"><span>Entrega (nuestro personal)</span>
        <input id="dev-entrega-nombre" list="lista-reciben" value="${esc(r.dev_entrega_nombre || estado.usuario || '')}"></label>
      <label class="campo campo-md"><span>Cargo</span>
        <input id="dev-entrega-cargo" list="lista-cargos" value="${esc(r.dev_entrega_cargo || '')}"></label>
      <label class="campo campo-md"><span>Recibe (dependencia)</span>
        <input id="dev-recibe-nombre" list="lista-entregan" value="${esc(r.dev_recibe_nombre || r.entrega_nombre)}"></label>
      <label class="campo campo-md"><span>Cargo</span>
        <input id="dev-recibe-cargo" list="lista-cargos" value="${esc(r.dev_recibe_cargo || r.entrega_cargo || '')}"></label>
      <label class="campo campo-sm"><span>Punto de aceptación</span>
        <select id="dev-aceptacion">${opciones(cat.aceptaciones, r.dev_aceptacion || 'Aceptado')}</select></label>
      <label class="campo"><span>Observaciones de la aceptación</span>
        <textarea id="dev-observaciones" rows="3"
          placeholder="Conformidad, pendientes, condiciones en que se devuelven los documentos…">${esc(r.dev_observaciones || '')}</textarea></label>
    </div>`;
}

/* ─────────────────────────── sección: historial ─────────────────────── */

function secHistorial(r) {
  return `
    <div class="card">
      <div class="card-head"><h2>Historial del lote</h2></div>
      <div class="card-body no-pad">
        ${r.eventos.length ? `<div class="linea-tiempo">${r.eventos.map((e) => `
          <div class="evento">
            <div class="evento-punto ${clase(e.tipo)}"></div>
            <div class="evento-cuerpo">
              <b>${esc(e.tipo)}</b>
              <div class="secundario">${esc(e.detalle)}</div>
              <div class="secundario">
                ${new Date(e.fecha).toLocaleString('es-MX', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })}
                ${e.usuario ? ` · ${esc(e.usuario)}` : ''}
              </div>
            </div>
          </div>`).join('')}</div>` : vacio('Sin movimientos registrados')}
      </div>
    </div>`;
}

/* ───────────────────── conexión de los controles ────────────────────── */

function conectarSeccion(r) {
  const id = r.id;
  const recargar = async (seccion) => { await abrirDetalle(id, seccion); refrescarVista(); };

  /* recepción */
  $('#det-firmar')?.addEventListener('click', () => firmarRemision(r, () => recargar()));
  $('#det-acuse')?.addEventListener('click', () => imprimirAcuse(r));
  $('#det-etiquetas')?.addEventListener('click', () => imprimirEtiquetas(r));
  $('#det-editar')?.addEventListener('click', () => {
    if (r.edicion === 'autorizada' &&
        !confirm('Al guardar la corrección se anulan la firma y la validación, y hay que volver a hacerlas. ¿Continuar?')) return;
    editarRemision(r);
  });
  $('#det-cancelar')?.addEventListener('click', async () => {
    const motivo = await pedirMotivo({
      titulo: `Cancelar la recepción ${r.folio}`,
      explica: 'La remisión no se borra: queda como «Cancelado», con su motivo, y ya no se puede modificar.',
      boton: 'Cancelar recepción', peligro: true
    });
    if (!motivo) return;
    try {
      await api(`/api/remisiones/${id}/cancelacion`, { method: 'POST', body: JSON.stringify({ motivo }) });
      aviso(`${r.folio} cancelada.`);
      recargar('resumen');
    } catch (e) { aviso(e.message, 'error'); }
  });
  $$('#sheet-seccion [data-solicitar]').forEach((b) => b.addEventListener('click', async () => {
    const tipo = b.dataset.solicitar;
    const motivo = await pedirMotivo({
      titulo: `Solicitar ${tipo.toLowerCase()} · ${r.folio}`,
      explica: tipo === 'Eliminación'
        ? 'Para capturas duplicadas o hechas por error. Si un supervisor la aprueba, la remisión deja de aparecer en las listas, pero se conserva con todo su historial.'
        : 'Explica qué hay que corregir. Si un supervisor la aprueba, podrás editar la recepción una vez; la firma y la validación se tendrán que volver a hacer.',
      boton: 'Enviar solicitud', peligro: tipo === 'Eliminación'
    });
    if (!motivo) return;
    try {
      await api(`/api/remisiones/${id}/solicitudes`, { method: 'POST', body: JSON.stringify({ tipo, motivo }) });
      aviso('Solicitud enviada. La resuelve un supervisor.');
      recargar('resumen');
    } catch (e) { aviso(e.message, 'error'); }
  }));
  $$('#sheet-seccion [data-aprobar], #sheet-seccion [data-rechazar]').forEach((b) =>
    b.addEventListener('click', () => resolverSolicitud(b.dataset.aprobar || b.dataset.rechazar,
      Boolean(b.dataset.aprobar), () => recargar('resumen'))));

  /* digitalización: cada carpeta, paso por paso */
  const carpeta = (docId) => r.documentos.find((d) => d.id === Number(docId));
  const tras = () => recargar('digitalizacion');
  $$('#sheet-seccion [data-preparar]').forEach((b) => b.addEventListener('click', () =>
    prepararCarpeta(r, carpeta(b.dataset.preparar), tras)));
  $$('#sheet-seccion [data-a-mesa]').forEach((b) => b.addEventListener('click', () =>
    enviarAMesa(r, [carpeta(b.dataset.aMesa)], tras)));
  $$('#sheet-seccion [data-caja-a-mesa]').forEach((b) => b.addEventListener('click', () =>
    enviarAMesa(r, r.documentos.filter((d) => d.caja === Number(b.dataset.cajaAMesa) && d.etapa === 'Por asignar'), tras)));
  $$('#sheet-seccion [data-escaneo]').forEach((b) => b.addEventListener('click', () =>
    registrarEscaneo(r, carpeta(b.dataset.escaneo), tras)));
  $$('#sheet-seccion [data-recoser]').forEach((b) => b.addEventListener('click', () =>
    recoserCarpeta(r, carpeta(b.dataset.recoser), tras)));
  $$('#sheet-seccion [data-traza]').forEach((b) => b.addEventListener('click', () =>
    verTrazabilidad(r, carpeta(b.dataset.traza))));
  $$('#sheet-seccion [data-subir-pdf], #sheet-seccion [data-reemplazar-pdf]').forEach((b) => b.addEventListener('click', () =>
    ventanaSubirPdf(r, carpeta(b.dataset.subirPdf || b.dataset.reemplazarPdf), tras)));

  /* incidencias */
  $('#inc-nueva')?.addEventListener('click', () => reportarIncidencia(r, () => recargar('incidencias')));
  $$('#sheet-seccion [data-resolver]').forEach((b) => b.addEventListener('click', () =>
    resolverIncidencia(r.incidencias.find((i) => i.id === Number(b.dataset.resolver)), () => recargar('incidencias'))));
  $$('#sheet-seccion [data-anular-incidencia]').forEach((b) => b.addEventListener('click', async () => {
    const motivo = await pedirMotivo({
      titulo: 'Anular incidencia',
      explica: 'La incidencia no se borra: queda tachada, con el motivo y tu nombre.',
      boton: 'Anular', peligro: true
    });
    if (!motivo) return;
    try {
      await api(`/api/incidencias/${b.dataset.anularIncidencia}`, {
        method: 'PATCH', body: JSON.stringify({ anular: true, motivo })
      });
      recargar('incidencias');
    } catch (e) { aviso(e.message, 'error'); }
  }));

  /* cotejos */
  $$('#sheet-seccion [data-cotejar]').forEach((b) => b.addEventListener('click', () =>
    abrirCotejo(r, b.dataset.cotejar, () => recargar(estado.seccionDetalle))));

  /* devolución */
  $('#dev-guardar')?.addEventListener('click', () => guardarDevolucion(id, () => recargar('devolucion')));
  $('#dev-editar')?.addEventListener('click', () => editarDevolucion(r, () => recargar('devolucion')));
  $('#dev-firmar')?.addEventListener('click', () => firmarDevolucion(r, () => recargar('devolucion')));
  $('#dev-acuse')?.addEventListener('click', () => imprimirAcuseDevolucion(r));
  $('#dev-cancelar')?.addEventListener('click', async () => {
    if (!confirm('¿Cancelar la devolución? Sus datos y firmas se quitan, pero quedan descritos en el historial.')) return;
    await api(`/api/remisiones/${id}/devolucion`, { method: 'DELETE' });
    aviso('Devolución cancelada.');
    recargar('devolucion');
  });
}

function leerFormDevolucion() {
  return {
    dev_fecha: $('#dev-fecha').value,
    dev_medio: $('#dev-medio').value,
    dev_archivos: $('#dev-archivos').value,
    dev_entrega_nombre: $('#dev-entrega-nombre').value,
    dev_entrega_cargo: $('#dev-entrega-cargo').value,
    dev_recibe_nombre: $('#dev-recibe-nombre').value,
    dev_recibe_cargo: $('#dev-recibe-cargo').value,
    dev_aceptacion: $('#dev-aceptacion').value,
    dev_observaciones: $('#dev-observaciones').value
  };
}

async function guardarDevolucion(id, alTerminar) {
  try {
    await api(`/api/remisiones/${id}/devolucion`, { method: 'PUT', body: JSON.stringify(leerFormDevolucion()) });
    aviso('Devolución registrada.');
    alTerminar();
  } catch (e) { aviso(e.message, 'error'); }
}

function editarDevolucion(r, alTerminar) {
  abrirModal({
    titulo: `Corregir devolución · ${r.folio}`,
    cuerpo: formDevolucion(r),
    botones: [
      { texto: 'Cancelar', accion: cerrarModal },
      { texto: 'Guardar', clase: 'btn btn-primary', accion: async () => {
        try {
          await api(`/api/remisiones/${r.id}/devolucion`, { method: 'PUT', body: JSON.stringify(leerFormDevolucion()) });
          cerrarModal();
          aviso('Devolución actualizada.');
          alTerminar();
        } catch (e) { aviso(e.message, 'error'); }
      } }
    ]
  });
}

function cerrarSheet() {
  $('#sheet-fondo').hidden = true;
  document.body.style.overflow = '';
}
function refrescarVista() {
  if (estado.vista === 'panel') cargarPanel();
  if (estado.vista === 'bitacora') cargarBitacora();
  if (estado.vista === 'personal') cargarPersonal();
  if (estado.vista === 'entregas') cargarEntregas();
  if (estado.vista === 'digitalizacion') cargarDigitalizacion();
}

$('#sheet-cerrar').addEventListener('click', cerrarSheet);
$('#sheet-imprimir').addEventListener('click', () => {
  if (estado.remisionActual) imprimirAcuse(estado.remisionActual);
});
$('#sheet-fondo').addEventListener('click', (e) => { if (e.target.id === 'sheet-fondo') cerrarSheet(); });
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('#modal-fondo').hidden) cerrarModal();
  else if (e.key === 'Escape' && !$('#sheet-fondo').hidden) cerrarSheet();
  if ((e.metaKey || e.ctrlKey) && e.key === 's') { e.preventDefault(); if (estado.vista === 'recepcion') $('#btn-guardar').click(); }
});

/* ─────────────────────────────── arranque ───────────────────────────── */

function mostrarAcceso(mensaje) {
  const error = $('#acceso-error');
  if (mensaje) { error.textContent = mensaje; error.hidden = false; }

  $('#btn-google').hidden = !estado.sesion.sso;
  if (!estado.sesion.configurado) {
    error.textContent = 'El acceso con Google no está configurado. Mientras tanto nadie puede entrar: ' +
      'cada registro tiene que quedar a nombre de una persona verificada. Consulta el README.';
    error.hidden = false;
    $('#acceso-nota').hidden = true;
  }

  const cuentas = estado.sesion.cuentas_prueba || [];
  if (estado.sesion.prueba && cuentas.length) {
    $('#acceso-prueba').hidden = false;
    $('#acceso-separador-texto').textContent = estado.sesion.sso
      ? 'o entra con una cuenta de prueba'
      : 'Cuentas de prueba';
    $('#acceso-cuentas').innerHTML = cuentas.map((c) => `
      <button type="button" data-prueba="${esc(c.email)}">
        ${esc(c.nombre)}<span>${esc(c.rol)}</span>
      </button>`).join('');
    $$('#acceso-cuentas button').forEach((b) => b.addEventListener('click', async () => {
      b.disabled = true;
      const res = await fetch('/auth/prueba', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: b.dataset.prueba })
      });
      if (res.ok) return location.replace('/');
      const datos = await res.json().catch(() => ({}));
      error.textContent = (datos.errores || ['No se pudo entrar.']).join(' ');
      error.hidden = false;
      b.disabled = false;
    }));
    if (!estado.sesion.sso) {
      $('#acceso-nota').textContent =
        'El acceso con Google todavía no está configurado; estas cuentas son solo para conocer el sistema.';
    }
  }

  $('#acceso').hidden = false;
  $('.app').style.display = 'none';
}

(async function iniciar() {
  try {
    const parametros = new URLSearchParams(location.search);
    estado.sesion = await api('/api/sesion');

    if (!estado.sesion.usuario) {
      estado.config = await api('/api/config').catch(() => estado.config);
        return mostrarAcceso(parametros.get('acceso'));
    }
    if (parametros.get('acceso')) history.replaceState(null, '', location.pathname);
    estado.usuario = estado.sesion.usuario.nombre;
    $('#aviso-prueba').hidden = !estado.sesion.usuario.es_prueba;

    estado.config = await api('/api/config');
    await cargarCatalogos();
    pintarUsuario();
    aplicarPermisos();
    if (rol() === 'Mesa') document.body.classList.add('modo-mesa');
    nuevaRemision();
    irA(primeraVista());
  } catch (e) {
    aviso(`No se pudo cargar la información: ${e.message}`, 'error');
  }
})();
