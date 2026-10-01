/* ══════════════════════ Bitácora de digitalización ══════════════════════ */

const $  = (s, ctx = document) => ctx.querySelector(s);
const $$ = (s, ctx = document) => [...ctx.querySelectorAll(s)];

const estado = {
  vista: 'panel',
  usuario: (() => { try { return localStorage.getItem('bitacora.usuario') || ''; } catch { return ''; } })(),
  entregas: [],
  filtroEntregas: 'pendientes',
  sesion: { sso: false, prueba: false, acceso: false, cuentas_prueba: [], usuario: null },
  seccionDetalle: 'resumen',
  editando: null,
  remisionActual: null,
  config: { organizacion: '', leyenda_acuse: '' },
  catalogos: { estados: [], situaciones: [] },
  filtros: { q: '', estado: '', desde: '', hasta: '' }
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
      'X-Usuario': encodeURIComponent(estado.usuario || ''),
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

function irA(vista) {
  estado.vista = vista;
  $$('.vista').forEach((v) => v.classList.toggle('is-active', v.id === `vista-${vista}`));
  $$('.nav-item').forEach((b) => b.classList.toggle('is-active', b.dataset.vista === vista));
  window.scrollTo({ top: 0 });
  if (vista === 'panel') cargarPanel();
  if (vista === 'bitacora') cargarBitacora();
  if (vista === 'personal') cargarPersonal();
  if (vista === 'entregas') cargarEntregas();
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

  $('#sel-estado').innerHTML = c.estados.map((e) => `<option>${esc(e)}</option>`).join('');
  llenarRecibe();
  $('#f-estado').innerHTML = ['Todos', ...c.estados]
    .map((e, i) => `<button type="button" data-estado="${i ? esc(e) : ''}"${i ? '' : ' class="is-active"'}>${esc(e)}</button>`)
    .join('');
  $$('#f-estado button').forEach((b) => b.addEventListener('click', () => {
    $$('#f-estado button').forEach((x) => x.classList.remove('is-active'));
    b.classList.add('is-active');
    estado.filtros.estado = b.dataset.estado;
    cargarBitacora();
  }));
}

/* ─────────────────────────────── panel ──────────────────────────────── */

async function cargarPanel() {
  const [s, recientes, dependencias] = await Promise.all([
    api('/api/estadisticas'),
    api('/api/remisiones'),
    api('/api/dependencias').catch(() => [])
  ]);
  estado.dependencias = dependencias;

  $('#fecha-hoy').textContent = fechaLarga(new Date().toISOString().slice(0, 10))
    .replace(/^./, (c) => c.toUpperCase());

  const enProceso = (s.porEstado.find((e) => e.estado === 'Recibido')?.total || 0) +
                    (s.porEstado.find((e) => e.estado === 'En digitalización')?.total || 0);

  $('#stats').innerHTML = [
    ['Recepciones hoy', s.hoy.remisiones, `${num(s.hoy.documentos)} documentos`],
    ['Fojas hoy', s.hoy.fojas, 'recibidas el día de hoy'],
    ['Imágenes hoy', s.produccion.imagenes_hoy,
      s.produccion.capturas_abiertas
        ? `${num(s.produccion.capturas_abiertas)} captura${s.produccion.capturas_abiertas === 1 ? '' : 's'} en curso`
        : 'sin capturas abiertas'],
    ['Lotes en proceso', enProceso, 'pendientes de concluir'],
    ['Incidencias abiertas', s.incidencias.abiertas || 0, `${num(s.incidencias.total || 0)} en total`],
    ['Acumulado', s.global.documentos, `${num(s.global.fojas)} fojas · ${num(s.produccion.imagenes)} imágenes`]
  ].map(([label, valor, pie]) => `
    <div class="stat">
      <div class="stat-label">${label}</div>
      <div class="stat-valor">${num(valor)}</div>
      <div class="stat-pie">${pie}</div>
    </div>`).join('');

  const totalEstados = s.porEstado.reduce((a, e) => a + e.total, 0) || 1;
  $('#panel-estados').innerHTML = estado.catalogos.estados.map((e) => {
    const total = s.porEstado.find((x) => x.estado === e)?.total || 0;
    return `<div style="margin-bottom:14px">
      <div class="lista-fila" style="padding:0;border:0">
        <span class="pill ${clase(e)}">${esc(e)}</span>
        <span class="cifra">${num(total)}</span>
      </div>
      <div class="barra"><i style="width:${(total / totalEstados * 100).toFixed(1)}%"></i></div>
    </div>`;
  }).join('');

  const maxSit = Math.max(1, ...s.porSituacion.map((x) => x.documentos));
  $('#panel-situacion').innerHTML = s.porSituacion.length
    ? s.porSituacion.map((x) => `
      <div style="margin-bottom:14px">
        <div class="lista-fila" style="padding:0;border:0">
          <span>${esc(x.situacion)}</span><span class="cifra">${num(x.documentos)}</span>
        </div>
        <div class="barra"><i style="width:${(x.documentos / maxSit * 100).toFixed(1)}%"></i></div>
      </div>`).join('')
    : '<p class="sub">Sin documentos registrados.</p>';

  $('#panel-dependencias').innerHTML = s.porDependencia.length
    ? `<div class="lista">${s.porDependencia.map((d) => {
        const registro = dependencias.find((x) => x.nombre === d.dependencia);
        return `
        <div class="lista-fila">
          <div class="principal">
            <b>${esc(d.dependencia)}</b>
            <div class="secundario">${num(d.remisiones)} remisiones · ${num(d.documentos)} docs · ${num(d.fojas)} fojas</div>
          </div>
          ${registro ? `<button class="link-btn" data-tablero="${registro.id}">
            ${registro.activo ? 'Tablero' : 'Tablero desactivado'}</button>` : ''}
        </div>`; }).join('')}</div>`
    : vacio('Aún no hay dependencias registradas.');

  $$('#panel-dependencias [data-tablero]').forEach((b) => b.addEventListener('click', () =>
    compartirTablero(dependencias.find((x) => x.id === Number(b.dataset.tablero)))));

  const maxOp = Math.max(1, ...s.porOperador.map((o) => o.imagenes));
  $('#panel-operadores').innerHTML = s.porOperador.length
    ? `<div class="lista">${s.porOperador.map((o) => `
        <div class="lista-fila">
          <div class="principal">
            <b>${esc(o.operador)}</b>
            <div class="secundario">${num(o.sesiones)} sesion${o.sesiones === 1 ? '' : 'es'} de captura</div>
            <div class="barra" style="width:180px"><i style="width:${(o.imagenes / maxOp * 100).toFixed(1)}%"></i></div>
          </div>
          <div class="cifra">${num(o.imagenes)} imágenes</div>
        </div>`).join('')}</div>`
    : vacio('Sin capturas registradas', 'Aparecerá aquí cuando alguien inicie la digitalización de un lote.');

  $('#panel-recientes').innerHTML = tabla(recientes.slice(0, 6));
  enlazarFilas('#panel-recientes');
  cargarActividad();
  cargarRespaldos();
}

async function cargarActividad() {
  const eventos = await api('/api/eventos?limite=12');
  $('#panel-actividad').innerHTML = eventos.length
    ? `<div class="linea-tiempo">${eventos.map((e) => `
        <div class="evento">
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
      </p>
      <div class="acciones-detalle" style="margin-top:14px">
        <button type="button" class="btn" id="cfg-personas">Personas del equipo</button>
      </div>`,
    botones: [
      { texto: 'Cancelar', accion: cerrarModal },
      { texto: 'Guardar', clase: 'btn btn-primary', accion: async () => {
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
      } }
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
  estado.filtros = { q: '', estado: '', desde: '', hasta: '' };
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
  const pendientes = (estado.entregas || []).filter((r) => !r.dev_fecha);
  if (!pendientes.length) {
    return aviso('No hay lotes en resguardo: todo lo recibido ya se devolvió.', 'error');
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
          <b>${num(r.total_documentos)} documentos · ${num(r.total_fojas)} fojas · ${num(r.cajas)} cajas${r.carpetas ? ` · ${num(r.carpetas)} carpetas` : ''}</b>
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
        Después de registrar la salida hay que <b>cotejar la entrega</b> partida por partida;
        sin ese cotejo el acuse no se puede firmar. Al guardar te llevo directo ahí.
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
            descripcion,
            reportada_por: estado.usuario
          })
        });
      }

      cerrarModal();
      aviso('Salida registrada. Falta cotejar la entrega para poder firmar.');
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

/* ═══════════════════════════ entregas ═══════════════════════════ */

const diasDesde = (iso) => {
  if (!iso) return 0;
  const [a, m, d] = iso.split('-').map(Number);
  return Math.max(0, Math.round((Date.now() - new Date(a, m - 1, d)) / 86400000));
};

/** Qué le falta a un lote para poder cerrarse. */
function pendienteDe(r) {
  if (!r.dev_fecha) return { texto: 'Sin registrar la devolución', clase: 'alta' };
  if (!r.cotejo_en) return { texto: 'Falta cotejar la entrega', clase: 'media' };
  if (!r.dev_firmado_en) return { texto: 'Falta la firma del acuse', clase: 'media' };
  return null;
}

async function cargarEntregas() {
  const lotes = await api('/api/remisiones');
  estado.entregas = lotes;

  const enResguardo = lotes.filter((r) => !r.dev_fecha);
  const entregadas = lotes.filter((r) => r.dev_fecha);
  const listasParaEntregar = enResguardo.filter((r) => r.estado === 'Digitalizado');
  const conPendientes = entregadas.filter((r) => pendienteDe(r));

  $('#entregas-stats').innerHTML = [
    ['En resguardo', enResguardo.length,
      `${num(enResguardo.reduce((a, r) => a + r.cajas, 0))} cajas · ${num(enResguardo.reduce((a, r) => a + r.carpetas, 0))} carpetas`],
    ['Listas para entregar', listasParaEntregar.length, 'digitalizadas sin devolver'],
    ['Entregadas', entregadas.length, `${num(entregadas.reduce((a, r) => a + r.cajas, 0))} cajas devueltas`],
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
  const visibles = filtro === 'pendientes' ? lotes.filter((r) => !r.dev_fecha)
    : filtro === 'entregadas' ? lotes.filter((r) => r.dev_fecha)
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

  const enResguardo = filtro !== 'entregadas';
  $('#tabla-entregas').innerHTML = `
    <table class="tabla">
      <thead><tr>
        <th>Folio</th><th>Dependencia</th>
        <th>${enResguardo ? 'En resguardo desde' : 'Devuelto'}</th>
        <th class="num">Docs.</th><th class="num">Cajas</th>
        <th>${enResguardo ? 'Digitalización' : 'Entrega digital'}</th>
        <th>${enResguardo ? 'Estado' : 'Aceptación'}</th>
      </tr></thead>
      <tbody>${visibles.map((r) => {
        const falta = pendienteDe(r);
        const avance = r.total_fojas ? Math.min(100, r.total_imagenes / r.total_fojas * 100) : 0;
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
                 <div class="celda-sec">${r.total_imagenes ? `${num(r.total_imagenes)} imágenes` : 'sin iniciar'}</div>`}
          </td>
          <td>
            ${r.dev_fecha
              ? `<span class="pill ${clase(r.dev_aceptacion)}">${esc(r.dev_aceptacion || '—')}</span>`
              : `<span class="pill ${clase(r.estado)}">${esc(r.estado)}</span>`}
            ${falta ? `<div class="celda-sec" style="color:var(--${falta.clase === 'alta' ? 'red' : 'orange'});margin-top:3px">
              ${esc(falta.texto)}</div>` : ''}
            ${!r.dev_fecha && r.estado !== 'Recibido'
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

  const activos = gente.filter((p) => p.activo).length;
  $('#personal-sub').textContent = gente.length
    ? `${num(activos)} en activo de ${num(gente.length)} · ${num(gente.filter((p) => p.rol === 'Operador').length)} operadores`
    : 'Quiénes reciben y quiénes digitalizan';

  $('#tabla-personal').innerHTML = gente.length ? `
    <table class="tabla">
      <thead><tr>
        <th>Persona</th><th>Rol</th><th>Contacto</th>
        <th class="num">Recepciones</th><th class="num">Sesiones</th><th class="num">Imágenes</th>
        <th>Última actividad</th><th></th>
      </tr></thead>
      <tbody>${gente.map((p) => `
        <tr style="cursor:default"${p.activo ? '' : ' class="baja"'}>
          <td>
            <b style="font-weight:500">${esc(p.nombre)}</b>
            ${p.activo ? '' : ' <span class="pill">Baja</span>'}
            ${p.cargo ? `<div class="celda-sec">${esc(p.cargo)}</div>` : ''}
          </td>
          <td><span class="pill ${clase(p.rol)}">${esc(p.rol)}</span></td>
          <td class="celda-sec">${esc(p.email || '—')}${p.telefono ? `<div>${esc(p.telefono)}</div>` : ''}</td>
          <td class="num">${num(p.recepciones)}</td>
          <td class="num">${num(p.sesiones)}</td>
          <td class="num">${num(p.imagenes)}</td>
          <td class="celda-sec">${p.ultima_actividad
            ? new Date(p.ultima_actividad).toLocaleDateString('es-MX', { day: '2-digit', month: 'short', year: 'numeric' })
            : 'sin movimientos'}</td>
          <td style="text-align:right;white-space:nowrap">
            <button class="link-btn" data-editar-persona="${p.id}">Editar</button>
            <button class="link-btn" data-quitar-persona="${p.id}" style="color:var(--red);margin-left:10px">Quitar</button>
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
    if (p.recepciones || p.sesiones) {
      return aviso(`${p.nombre} tiene trabajo registrado. Edítala y márcala como baja para conservar su historial.`, 'error');
    }
    if (!confirm(`¿Quitar a ${p.nombre} del personal?`)) return;
    try {
      await api(`/api/usuarios/${p.id}`, { method: 'DELETE' });
      aviso(`${p.nombre} fue dada de baja del registro.`);
      cargarPersonal();
    } catch (e) { aviso(e.message, 'error'); }
  }));
}

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
        <label class="campo" style="grid-column:span 1"><span>Correo de Google</span>
          <input id="p-email" maxlength="160" value="${esc(p.email)}" placeholder="persona@empresa.com"></label>
        <label class="campo" style="grid-column:span 1"><span>Teléfono</span>
          <input id="p-telefono" maxlength="40" value="${esc(p.telefono)}" placeholder="Opcional"></label>
        <label class="campo" style="grid-column:span 2;flex-direction:row;align-items:center;gap:9px">
          <input type="checkbox" id="p-activo" style="width:auto"${p.activo ? ' checked' : ''}>
          <span style="padding:0">En activo</span></label>
      </div>
      <p class="sub">
        El cargo se imprime en los acuses junto a la firma. El correo solo hace falta
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
          activo: $('#p-activo').checked
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
}

$('#btn-alta-persona').addEventListener('click', () => formularioPersona());

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

function filaPartida(d = {}) {
  const situaciones = estado.catalogos.situaciones || [];
  const div = document.createElement('div');
  div.className = 'partida';
  div.innerHTML = `
    <div class="partida-head">
      <span class="etiqueta">Partida</span>
      <button type="button" class="quitar">Quitar</button>
    </div>
    <div class="campos">
      <label class="campo campo-md">
        <span>Descripción del documento o expediente</span>
        <input class="p-descripcion" placeholder="Ej. Expedientes de personal 2019" value="${esc(d.descripcion)}">
      </label>
      <label class="campo campo-sm">
        <span>Tipo documental</span>
        <input class="p-tipo" list="lista-tipos" placeholder="Ej. Expediente" value="${esc(d.tipo)}">
      </label>
      <label class="campo campo-sm">
        <span>Situación en que se entrega</span>
        <select class="p-situacion">
          ${situaciones.map((s) => `<option${(d.situacion || 'Buen estado') === s ? ' selected' : ''}>${esc(s)}</option>`).join('')}
        </select>
      </label>
      <label class="campo campo-sm">
        <span>Cantidad de documentos</span>
        <input type="number" class="p-cantidad" min="1" step="1" value="${d.cantidad ?? 1}">
      </label>
      <label class="campo campo-sm">
        <span>Número de fojas</span>
        <input type="number" class="p-fojas" min="0" step="1" value="${d.fojas ?? 0}">
      </label>
      <label class="campo campo-md">
        <span>Observaciones</span>
        <input class="p-observaciones" placeholder="Detalles del estado físico, faltantes…" value="${esc(d.observaciones)}">
      </label>
    </div>`;

  div.querySelector('.quitar').addEventListener('click', () => {
    if ($$('.partida').length === 1) return aviso('Debe existir al menos una partida.', 'error');
    div.remove();
    renumerar();
  });
  div.addEventListener('input', renumerar);
  return div;
}

function renumerar() {
  const partidas = $$('.partida');
  let docs = 0, fojas = 0;
  partidas.forEach((p, i) => {
    p.querySelector('.etiqueta').textContent = `Partida ${i + 1}`;
    docs  += Number(p.querySelector('.p-cantidad').value || 0);
    fojas += Number(p.querySelector('.p-fojas').value || 0);
  });
  $('#res-partidas').textContent = num(partidas.length);
  $('#res-documentos').textContent = num(docs);
  $('#res-fojas').textContent = num(fojas);
}

function agregarPartida(d) {
  $('#partidas').appendChild(filaPartida(d));
  renumerar();
}
$('#btn-agregar-partida').addEventListener('click', () => {
  agregarPartida();
  $$('.partida').at(-1).querySelector('.p-descripcion').focus();
});

function nuevaRemision() {
  estado.editando = null;
  const f = $('#form-remision');
  f.reset();
  const ahora = new Date();
  f.fecha.value = ahora.toISOString().slice(0, 10);
  f.hora.value = ahora.toTimeString().slice(0, 5);
  f.estado.value = 'Recibido';
  f.cajas.value = 0;
  f.carpetas.value = 0;
  llenarRecibe(estado.usuario || undefined);
  $('#partidas').innerHTML = '';
  agregarPartida();
  $('#recepcion-titulo').textContent = 'Recepción de documentos';
  $('#recepcion-sub').textContent = 'Registra la entrega física de un lote.';
  $('#btn-guardar').textContent = 'Guardar recepción';
  $('#btn-cancelar-edicion').hidden = true;
}

function editarRemision(r) {
  estado.editando = r.id;
  const f = $('#form-remision');
  ['fecha', 'hora', 'dependencia', 'area', 'cajas', 'carpetas', 'entrega_nombre', 'entrega_cargo',
   'recibe_nombre', 'recibe_cargo', 'estado', 'observaciones'].forEach((k) => { f[k].value = r[k] || ''; });
  llenarRecibe(r.recibe_nombre);
  if ($('#sel-recibe').value !== r.recibe_nombre) {
    $('#sel-recibe').value = OTRA_PERSONA;   // alguien que ya no está en el padrón
    aplicarRecibe();
    f.recibe_nombre.value = r.recibe_nombre;
  }
  $('#partidas').innerHTML = '';
  r.documentos.forEach(agregarPartida);
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
    cajas: f.cajas.value,
    carpetas: f.carpetas.value,
    entrega_nombre: f.entrega_nombre.value,
    entrega_cargo: f.entrega_cargo.value,
    recibe_nombre: nombreRecibe(),
    recibe_cargo: f.recibe_cargo.value,
    estado: f.estado.value,
    observaciones: f.observaciones.value,
    documentos: $$('.partida').map((p) => ({
      descripcion: p.querySelector('.p-descripcion').value,
      tipo: p.querySelector('.p-tipo').value,
      situacion: p.querySelector('.p-situacion').value,
      cantidad: p.querySelector('.p-cantidad').value,
      fojas: p.querySelector('.p-fojas').value,
      observaciones: p.querySelector('.p-observaciones').value
    }))
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
    pintarLogo();
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

const CLAVE_USUARIO = 'bitacora.usuario';

function usuariosActivos() {
  return (estado.catalogos.usuarios || []).filter((u) => u.activo);
}

const esSupervisor = () => !estado.sesion.acceso || estado.sesion.usuario?.rol === 'Supervisor';

function pintarUsuario() {
  if (estado.sesion.acceso) {
    const u = estado.sesion.usuario;
    $('#usuario-actual').innerHTML = `<b>${esc(u.nombre)}</b><span>${esc(u.rol)}</span>`;
    return;
  }
  const u = (estado.catalogos.usuarios || []).find((x) => x.nombre === estado.usuario);
  $('#usuario-actual').innerHTML = estado.usuario
    ? `<b>${esc(estado.usuario)}</b><span>${esc(u?.rol || 'Sin registrar')}</span>`
    : '<b>Identifícate</b><span>Nadie seleccionado</span>';
}

function elegirUsuario() {
  return estado.sesion.acceso ? administrarPersonas() : identidadLocal();
}

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

function identidadLocal() {
  const lista = usuariosActivos();
  abrirModal({
    titulo: 'Quién usa este equipo',
    cuerpo: `
      <p class="sub" style="margin-bottom:14px">
        Todo lo que registres desde este equipo queda a nombre de la persona elegida.
        Se recuerda en este navegador hasta que la cambies.
      </p>
      ${lista.length ? `<div class="lista">${lista.map((u) => `
        <button type="button" class="lista-fila fila-btn${u.nombre === estado.usuario ? ' es-actual' : ''}" data-usuario="${esc(u.nombre)}">
          <div class="principal"><b>${esc(u.nombre)}</b><div class="secundario">${esc(u.rol)}</div></div>
          ${u.nombre === estado.usuario ? '<span class="pill recibido">En uso</span>' : ''}
        </button>`).join('')}</div>`
        : '<p class="sub">Todavía no hay personas dadas de alta. Agrega la primera abajo.</p>'}
      <div class="campos" style="grid-template-columns:3fr 2fr;margin-top:18px">
        <label class="campo" style="grid-column:span 1"><span>Agregar persona</span>
          <input id="u-nombre" placeholder="Nombre completo" maxlength="120"></label>
        <label class="campo" style="grid-column:span 1"><span>Rol</span>
          <select id="u-rol">${(estado.catalogos.roles || []).map((r) => `<option>${esc(r)}</option>`).join('')}</select></label>
      </div>`,
    botones: [
      { texto: 'Ajustes', accion: () => { cerrarModal(); $('#btn-ajustes').click(); } },
      { texto: 'Cerrar', accion: cerrarModal },
      { texto: 'Agregar', clase: 'btn btn-primary', accion: async () => {
        const nombre = $('#u-nombre').value.trim();
        if (!nombre) return aviso('Escribe el nombre.', 'error');
        try {
          estado.catalogos.usuarios = await api('/api/usuarios', {
            method: 'POST', body: JSON.stringify({ nombre, rol: $('#u-rol').value })
          });
          fijarUsuario(nombre);
          cerrarModal();
        } catch (e) { aviso(e.message, 'error'); }
      } }
    ]
  });

  $$('#modal-cuerpo [data-usuario]').forEach((b) => b.addEventListener('click', () => {
    fijarUsuario(b.dataset.usuario);
    cerrarModal();
  }));
}

function fijarUsuario(nombre) {
  estado.usuario = nombre;
  try { localStorage.setItem(CLAVE_USUARIO, nombre); } catch { /* sin almacenamiento */ }
  pintarUsuario();
  aviso(`Trabajando como ${nombre}.`);
}

/** Pide confirmar quién realiza una acción; devuelve el nombre o null. */
function pedirUsuario(titulo) {
  const lista = usuariosActivos();
  if (!lista.length) {
    aviso('Primero da de alta a las personas del equipo.', 'error');
    elegirUsuario();
    return Promise.resolve(null);
  }
  return new Promise((resolver) => {
    abrirModal({
      titulo,
      cuerpo: `
        <label class="campo" style="margin-bottom:6px"><span>Persona</span>
          <select id="sel-persona">${lista.map((u) =>
            `<option${u.nombre === estado.usuario ? ' selected' : ''}>${esc(u.nombre)}</option>`).join('')}</select>
        </label>`,
      botones: [
        { texto: 'Cancelar', accion: () => { cerrarModal(); resolver(null); } },
        { texto: 'Continuar', clase: 'btn btn-primary', accion: () => {
          const nombre = $('#sel-persona').value;
          cerrarModal();
          resolver(nombre);
        } }
      ]
    });
  });
}

/* ══════════════════ captura e incidencias ══════════════════ */

function finalizarCaptura(captura, alTerminar) {
  if (!captura) return;
  abrirModal({
    titulo: `${captura.fin ? 'Editar' : 'Finalizar'} captura · ${esc(captura.operador)}`,
    cuerpo: `
      <div class="campos" style="grid-template-columns:1fr 1fr">
        <label class="campo" style="grid-column:span 1"><span>Imágenes generadas</span>
          <input type="number" id="cap-imagenes" min="0" step="1" value="${captura.imagenes || 0}"></label>
        <label class="campo" style="grid-column:span 1"><span>Inicio</span>
          <input value="${new Date(captura.inicio).toLocaleString('es-MX')}" disabled></label>
        <label class="campo"><span>Notas de la sesión</span>
          <input id="cap-notas" maxlength="600" value="${esc(captura.notas || '')}"
            placeholder="Incidencias menores, parte del lote cubierta…"></label>
      </div>`,
    botones: [
      { texto: 'Cancelar', accion: cerrarModal },
      { texto: captura.fin ? 'Guardar' : 'Finalizar captura', clase: 'btn btn-primary', accion: async () => {
        try {
          await api(`/api/capturas/${captura.id}`, {
            method: 'PATCH',
            body: JSON.stringify({
              fin: captura.fin || undefined,
              imagenes: $('#cap-imagenes').value,
              notas: $('#cap-notas').value
            })
          });
          cerrarModal();
          aviso('Sesión de captura registrada.');
          alTerminar();
        } catch (e) { aviso(e.message, 'error'); }
      } }
    ]
  });
}

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
            placeholder="Qué ocurrió, en qué partida o expediente, qué se necesita para resolverlo…"></textarea></label>
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
              descripcion: $('#inc-descripcion').value,
              reportada_por: estado.usuario
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
            body: JSON.stringify({ resolucion: $('#inc-resolucion').value, resuelta_por: estado.usuario })
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
          <div class="dato"><span>Dependencia</span><b>${esc(r.dependencia)}</b><span>${esc(r.area || '')}</span></div>
          <div class="dato"><span>Documentos</span><b>${num(r.total_documentos)} en ${num(r.total_partidas)} partida${r.total_partidas === 1 ? '' : 's'}</b>
            <span>${num(r.total_fojas)} fojas${r.cajas ? ` · ${num(r.cajas)} cajas` : ''}${r.carpetas ? ` · ${num(r.carpetas)} carpetas` : ''}</span></div>
          <div class="dato"><span>Imágenes generadas</span><b>${num(r.total_imagenes)}</b>
            <span>${r.total_fojas ? `${(r.total_imagenes / r.total_fojas * 100).toFixed(0)}% de las fojas` : ''}</span></div>
        </div>
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

/* ═════════════════════════ cotejo de partidas ═════════════════════════ */

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
  cotejo: {
    titulo: 'Cotejo de la entrega',
    accion: 'Cotejar entrega',
    columna: 'Devuelto',
    campoCantidad: 'cantidad_devuelta',
    campoFojas: 'fojas_devueltas',
    por: 'cotejo_por', en: 'cotejo_en', notas: 'cotejo_notas',
    explica: `Confirma que se devuelve exactamente lo que se recibió.
              Sin este cotejo no se puede firmar el acuse de devolución.`,
    vacio: 'Sin cotejar. Hay que confirmar lo que se devuelve antes de firmar.'
  }
};

const signo = (n) => `${n > 0 ? '+' : ''}${num(n)}`;

function tarjetaCotejo(r, tipo) {
  const c = COTEJOS[tipo];
  const resumen = r[tipo];
  const hecho = Boolean(r[c.en]);
  const parcial = resumen.revisadas > 0 && !resumen.completo;
  const difiere = resumen.documentos !== 0 || resumen.fojas !== 0;

  const filas = r.documentos.map((d) => {
    const cant = d[c.campoCantidad];
    const fojas = d[c.campoFojas];
    const sinRevisar = cant === null || cant === undefined;
    const dCant = sinRevisar ? 0 : cant - d.cantidad;
    const dFojas = sinRevisar ? 0 : (fojas ?? d.fojas) - d.fojas;
    return `
      <tr style="cursor:default">
        <td>${esc(d.descripcion)}</td>
        <td class="num">${num(d.cantidad)} · ${num(d.fojas)}</td>
        <td class="num">${sinRevisar ? '—' : `${num(cant)} · ${num(fojas ?? 0)}`}</td>
        <td class="num">${sinRevisar ? '<span class="celda-sec">sin revisar</span>'
          : (dCant || dFojas
              ? `<b style="color:var(--red)">${signo(dCant)} · ${signo(dFojas)}</b>`
              : '<span class="celda-sec">coincide</span>')}</td>
      </tr>`;
  }).join('');

  return `
    <div class="card">
      <div class="card-head">
        <h2>${c.titulo}</h2>
        <button class="link-btn" data-cotejar="${tipo}">${hecho || parcial ? 'Revisar de nuevo' : c.accion}</button>
      </div>
      <div class="card-body">
        ${hecho ? `
          <div class="lista-fila" style="padding:0;border:0">
            <div class="principal">
              <b>${difiere ? 'Cotejado con diferencias' : 'Cotejado sin diferencias'}</b>
              <div class="secundario">
                ${esc(r[c.por] || '—')} · ${new Date(r[c.en]).toLocaleString('es-MX',
                  { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })}
              </div>
            </div>
            <span class="pill ${difiere ? 'alta' : 'digitalizado'}">
              ${difiere ? `${signo(resumen.documentos)} docs · ${signo(resumen.fojas)} fojas` : 'Coincide'}
            </span>
          </div>`
        : `<p class="sub">${parcial
            ? `Revisadas ${num(resumen.revisadas)} de ${num(resumen.total)} partidas; falta terminar.`
            : c.vacio}</p>`}

        ${r[c.notas] ? `<p class="sub" style="margin-top:12px;color:var(--text)">
          <b>Nota:</b> ${esc(r[c.notas])}</p>` : ''}
      </div>
      ${resumen.revisadas ? `
      <div class="card-body no-pad">
        <table class="tabla">
          <thead><tr><th>Partida</th><th class="num">Asentado</th>
            <th class="num">${c.columna}</th><th class="num">Diferencia</th></tr></thead>
          <tbody>${filas}</tbody>
        </table>
      </div>` : ''}
    </div>`;
}

function abrirCotejo(r, tipo, alTerminar) {
  const c = COTEJOS[tipo];
  abrirModal({
    titulo: `${c.titulo} · ${r.folio}`,
    cuerpo: `
      <p class="sub" style="margin-bottom:14px">${c.explica}</p>
      <table class="tabla">
        <thead><tr><th>Partida</th><th class="num">Asentado</th>
          <th style="width:104px">Cantidad</th><th style="width:104px">Fojas</th><th class="num">Dif.</th></tr></thead>
        <tbody>${r.documentos.map((d) => `
          <tr style="cursor:default" data-doc="${d.id}" data-cantidad="${d.cantidad}" data-fojas="${d.fojas}">
            <td>${esc(d.descripcion)}</td>
            <td class="num celda-sec">${num(d.cantidad)} · ${num(d.fojas)}</td>
            <td><input type="number" class="c-cantidad" min="0" step="1"
                  value="${d[c.campoCantidad] ?? d.cantidad}"></td>
            <td><input type="number" class="c-fojas" min="0" step="1"
                  value="${d[c.campoFojas] ?? d.fojas}"></td>
            <td class="num c-dif"></td>
          </tr>`).join('')}
        </tbody>
      </table>
      <label class="campo" style="margin-top:16px"><span>Nota del cotejo</span>
        <textarea id="c-notas" rows="2"
          placeholder="Obligatoria si algo no coincide: a qué se debe la diferencia.">${esc(r[c.notas] || '')}</textarea></label>
      <p class="sub" id="c-resumen" style="margin-top:10px"></p>`,
    botones: [
      { texto: 'Cancelar', accion: cerrarModal },
      { texto: 'Guardar cotejo', clase: 'btn btn-primary', accion: async () => {
        const documentos = $$('#modal-cuerpo tbody tr').map((tr) => ({
          id: Number(tr.dataset.doc),
          cantidad: tr.querySelector('.c-cantidad').value,
          fojas: tr.querySelector('.c-fojas').value
        }));
        try {
          await api(`/api/remisiones/${r.id}/${tipo}`, {
            method: 'PUT',
            body: JSON.stringify({ documentos, notas: $('#c-notas').value, por: estado.usuario })
          });
          cerrarModal();
          aviso(tipo === 'validacion' ? 'Recepción validada.' : 'Entrega cotejada.');
          alTerminar();
        } catch (e) { aviso(e.message, 'error'); }
      } }
    ]
  });

  const recalcular = () => {
    let docs = 0, fojas = 0;
    $$('#modal-cuerpo tbody tr').forEach((tr) => {
      const dc = Number(tr.querySelector('.c-cantidad').value || 0) - Number(tr.dataset.cantidad);
      const df = Number(tr.querySelector('.c-fojas').value || 0) - Number(tr.dataset.fojas);
      docs += dc; fojas += df;
      tr.querySelector('.c-dif').innerHTML = (dc || df)
        ? `<b style="color:var(--red)">${signo(dc)} · ${signo(df)}</b>`
        : '<span class="celda-sec">=</span>';
    });
    $('#c-resumen').innerHTML = (docs || fojas)
      ? `<b style="color:var(--red)">Diferencia total: ${signo(docs)} documentos · ${signo(fojas)} fojas.</b>
         Explica a qué se debe antes de guardar.`
      : 'Todo coincide con lo asentado.';
  };
  $$('#modal-cuerpo input').forEach((i) => i.addEventListener('input', recalcular));
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
          <div class="dato"><span>Capturado</span><b>${new Date(r.creado_en).toLocaleString('es-MX',
            { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })}</b></div>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-head"><h2>Documentos recibidos</h2></div>
      <div class="card-body no-pad">
        <table class="tabla">
          <thead><tr><th>#</th><th>Descripción</th><th>Tipo</th>
            <th class="num">Cant.</th><th class="num">Fojas</th><th>Situación</th></tr></thead>
          <tbody>${r.documentos.map((d, i) => `
            <tr style="cursor:default">
              <td class="celda-sec">${i + 1}</td>
              <td>${esc(d.descripcion)}${d.observaciones ? `<div class="celda-sec">${esc(d.observaciones)}</div>` : ''}</td>
              <td class="celda-sec">${esc(d.tipo || '—')}</td>
              <td class="num">${num(d.cantidad)}</td>
              <td class="num">${num(d.fojas)}</td>
              <td><span class="pill">${esc(d.situacion)}</span></td>
            </tr>`).join('')}
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
          <button class="btn btn-primary" id="det-firmar">${r.firmado_en ? 'Volver a firmar' : 'Firmar acuse'}</button>
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
             · editar la remisión anula las firmas.</p>` : `
          <p class="sub" style="margin-top:14px">Sin firmar. El acuse se puede imprimir en blanco para firma a mano.</p>`}
      </div>
    </div>

    <div class="card">
      <div class="card-head"><h2>Seguimiento</h2></div>
      <div class="card-body">
        <div class="acciones-detalle">
          ${estado.catalogos.estados.map((e) => `
            <button class="btn${e === r.estado ? ' btn-primary' : ''}" data-estado="${esc(e)}">${esc(e)}</button>`).join('')}
        </div>
        <div class="acciones-detalle" style="margin-top:16px">
          <button class="btn" id="det-editar">Editar remisión</button>
          <button class="btn btn-danger" id="det-eliminar">Eliminar</button>
        </div>
      </div>
    </div>`;
}

/* ────────────────────────── sección: digitalización ─────────────────── */

function formatoDuracion(minutos) {
  if (!(minutos > 0)) return '—';
  if (minutos < 1) return 'menos de 1 min';
  const m = Math.round(minutos);
  const h = Math.floor(m / 60);
  return h ? `${h} h ${m % 60} min` : `${m} min`;
}

function duracion(inicio, fin) {
  if (!inicio || !fin) return '—';
  return formatoDuracion((new Date(fin) - new Date(inicio)) / 60000);
}

function secDigitalizacion(r) {
  const abiertas = r.capturas.filter((c) => !c.fin);
  const minutos = r.capturas.filter((c) => c.fin)
    .reduce((a, c) => a + (new Date(c.fin) - new Date(c.inicio)) / 60000, 0);
  // con sesiones de menos de cinco minutos el ritmo por hora no dice nada
  const ritmo = minutos >= 5 ? Math.round(r.total_imagenes / (minutos / 60)) : 0;

  return `
    <div class="card">
      <div class="card-head">
        <h2>Sesiones de captura</h2>
        <button class="link-btn" id="cap-iniciar">Iniciar captura</button>
      </div>
      <div class="card-body">
        <div class="datos">
          <div class="dato"><span>Fojas recibidas</span><b>${num(r.total_fojas)}</b></div>
          <div class="dato"><span>Imágenes generadas</span><b>${num(r.total_imagenes)}</b>
            <span>${r.total_fojas && r.total_imagenes ? `diferencia de ${num(Math.abs(r.total_imagenes - r.total_fojas))}` : ''}</span></div>
          <div class="dato"><span>Tiempo capturado</span><b>${formatoDuracion(minutos)}</b>
            <span>${ritmo ? `${num(ritmo)} imágenes por hora` : ''}</span></div>
        </div>
        ${abiertas.length ? `<p class="sub" style="margin-top:14px">
          ${abiertas.map((c) => `<b>${esc(c.operador)}</b> tiene una captura abierta desde las
            ${new Date(c.inicio).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' })}.`).join(' ')}
        </p>` : ''}
      </div>
    </div>

    <div class="card">
      <div class="card-body no-pad">
        ${r.capturas.length ? `
        <table class="tabla">
          <thead><tr><th>Operador</th><th>Inicio</th><th>Fin</th><th>Duración</th>
            <th class="num">Imágenes</th><th></th></tr></thead>
          <tbody>${r.capturas.map((c) => `
            <tr style="cursor:default">
              <td>${esc(c.operador)}${c.notas ? `<div class="celda-sec">${esc(c.notas)}</div>` : ''}</td>
              <td>${new Date(c.inicio).toLocaleString('es-MX', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}</td>
              <td>${c.fin ? new Date(c.fin).toLocaleString('es-MX', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })
                          : '<span class="pill en-digitalizacion">En curso</span>'}</td>
              <td class="celda-sec">${duracion(c.inicio, c.fin)}</td>
              <td class="num">${c.fin ? num(c.imagenes) : '—'}</td>
              <td style="text-align:right;white-space:nowrap">
                ${c.fin ? `<button class="link-btn" data-editar-captura="${c.id}">Editar</button>`
                        : `<button class="link-btn" data-finalizar="${c.id}">Finalizar</button>`}
                <button class="link-btn" data-borrar-captura="${c.id}" style="color:var(--red);margin-left:10px">Quitar</button>
              </td>
            </tr>`).join('')}
          </tbody>
        </table>` : vacio('Sin sesiones de captura', 'Registra el inicio cuando alguien empiece a digitalizar este lote.')}
      </div>
    </div>`;
}

/* ─────────────────────────── sección: incidencias ───────────────────── */

function secIncidencias(r) {
  return `
    <div class="card">
      <div class="card-head">
        <h2>Incidencias del servicio</h2>
        <button class="link-btn" id="inc-nueva">Reportar incidencia</button>
      </div>
      <div class="card-body no-pad">
        ${r.incidencias.length ? `<div class="lista">${r.incidencias.map((i) => `
          <div class="lista-fila" style="align-items:flex-start">
            <div class="principal">
              <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
                <b>${esc(i.tipo)}</b>
                <span class="pill ${clase(i.gravedad)}">${esc(i.gravedad)}</span>
                <span class="pill ${i.estado === 'Abierta' ? 'abierta' : 'digitalizado'}">${esc(i.estado)}</span>
              </div>
              <div class="secundario" style="margin-top:4px">${esc(i.descripcion)}</div>
              <div class="secundario" style="margin-top:4px">
                Reportó ${esc(i.reportada_por || '—')} el
                ${new Date(i.reportada_en).toLocaleString('es-MX', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}
              </div>
              ${i.estado === 'Resuelta' ? `<div class="secundario" style="margin-top:4px">
                <b>Resolución:</b> ${esc(i.resolucion)} — ${esc(i.resuelta_por || '')}
                ${new Date(i.resuelta_en).toLocaleDateString('es-MX', { day: '2-digit', month: 'short' })}</div>` : ''}
            </div>
            <div style="white-space:nowrap">
              ${i.estado === 'Abierta' ? `<button class="link-btn" data-resolver="${i.id}">Resolver</button>` : ''}
              <button class="link-btn" data-borrar-incidencia="${i.id}" style="color:var(--red);margin-left:10px">Quitar</button>
            </div>
          </div>`).join('')}</div>`
        : vacio('Sin incidencias', 'Registra aquí faltantes, daños, documentos ilegibles o fallas de equipo.')}
      </div>
    </div>`;
}

/* ─────────────────────────── sección: devolución ────────────────────── */

function secDevolucion(r) {
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
          <div class="dato"><span>Documentos físicos</span><b>${num(r.total_documentos)} en ${num(r.cajas || 0)} cajas</b>
            <span>${r.carpetas ? `${num(r.carpetas)} carpetas` : ''}</span></div>
        </div>
        ${r.dev_observaciones ? `<p class="sub" style="margin-top:14px;color:var(--text)">
          <b>Observaciones:</b> ${esc(r.dev_observaciones)}</p>` : ''}

        <div class="acciones-detalle" style="margin-top:18px">
          <button class="btn btn-primary" id="dev-firmar"${r.cotejo_en ? '' : ' disabled title="Primero hay que cotejar la entrega"'}>${r.dev_firmado_en ? 'Volver a firmar' : 'Firmar devolución'}</button>
          <button class="btn" id="dev-acuse">Imprimir acuse de devolución</button>
          <button class="btn" id="dev-editar">Corregir datos</button>
          <button class="btn btn-danger" id="dev-cancelar">Cancelar devolución</button>
        </div>

        ${r.dev_firmado_en ? `
          <div class="firma-hecha" style="margin-top:18px">
            ${r.dev_firma_entrega ? `<figure><img src="${r.dev_firma_entrega}" alt="Firma de quien entrega">
              <figcaption>Entrega · ${esc(r.dev_entrega_nombre)}</figcaption></figure>` : ''}
            ${r.dev_firma_recibe ? `<figure><img src="${r.dev_firma_recibe}" alt="Firma de quien recibe">
              <figcaption>Recibe · ${esc(r.dev_recibe_nombre)}</figcaption></figure>` : ''}
          </div>
          <p class="sub" style="margin-top:10px">Firmado el ${new Date(r.dev_firmado_en).toLocaleString('es-MX')}
             · corregir los datos anula las firmas.</p>` : `
          <p class="sub" style="margin-top:14px">Sin firmar. El acuse se puede imprimir en blanco para firma a mano.</p>`}
      </div>
    </div>`;
}

function formDevolucion(r) {
  const cat = estado.catalogos;
  const hoy = new Date().toISOString().slice(0, 10);
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
  $$('#sheet-seccion [data-estado]').forEach((b) => b.addEventListener('click', async () => {
    await api(`/api/remisiones/${id}`, { method: 'PATCH', body: JSON.stringify({ estado: b.dataset.estado }) });
    aviso(`Estado actualizado a “${b.dataset.estado}”.`);
    recargar();
  }));
  $('#det-firmar')?.addEventListener('click', () => firmarRemision(r, () => recargar()));
  $('#det-acuse')?.addEventListener('click', () => imprimirAcuse(r));
  $('#det-etiquetas')?.addEventListener('click', () => imprimirEtiquetas(r));
  $('#det-editar')?.addEventListener('click', () => {
    if (r.firmado_en && !confirm('Esta remisión ya está firmada. Al editarla se anulan las firmas. ¿Continuar?')) return;
    editarRemision(r);
  });
  $('#det-eliminar')?.addEventListener('click', async () => {
    if (!confirm(`¿Eliminar la remisión ${r.folio}? Esta acción no se puede deshacer.`)) return;
    await api(`/api/remisiones/${id}`, { method: 'DELETE' });
    cerrarSheet();
    aviso(`${r.folio} eliminada.`);
    refrescarVista();
  });

  /* digitalización */
  $('#cap-iniciar')?.addEventListener('click', async () => {
    const operador = await pedirUsuario('¿Quién inicia la captura?');
    if (!operador) return;
    try {
      await api(`/api/remisiones/${id}/capturas`, { method: 'POST', body: JSON.stringify({ operador }) });
      aviso(`Captura iniciada por ${operador}.`);
      recargar('digitalizacion');
    } catch (e) { aviso(e.message, 'error'); }
  });
  $$('#sheet-seccion [data-finalizar]').forEach((b) => b.addEventListener('click', () =>
    finalizarCaptura(r.capturas.find((c) => c.id === Number(b.dataset.finalizar)), () => recargar('digitalizacion'))));
  $$('#sheet-seccion [data-editar-captura]').forEach((b) => b.addEventListener('click', () =>
    finalizarCaptura(r.capturas.find((c) => c.id === Number(b.dataset.editarCaptura)), () => recargar('digitalizacion'))));
  $$('#sheet-seccion [data-borrar-captura]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('¿Quitar esta sesión de captura?')) return;
    await api(`/api/capturas/${b.dataset.borrarCaptura}`, { method: 'DELETE' });
    recargar('digitalizacion');
  }));

  /* incidencias */
  $('#inc-nueva')?.addEventListener('click', () => reportarIncidencia(r, () => recargar('incidencias')));
  $$('#sheet-seccion [data-resolver]').forEach((b) => b.addEventListener('click', () =>
    resolverIncidencia(r.incidencias.find((i) => i.id === Number(b.dataset.resolver)), () => recargar('incidencias'))));
  $$('#sheet-seccion [data-borrar-incidencia]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('¿Quitar esta incidencia del registro?')) return;
    await api(`/api/incidencias/${b.dataset.borrarIncidencia}`, { method: 'DELETE' });
    recargar('incidencias');
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
    if (!confirm('¿Cancelar la devolución? Se borran sus datos y firmas.')) return;
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

function pintarLogo() {
  const { logo, logo_marca: marca, organizacion } = estado.config;
  if (!logo) return;

  // en la barra lateral solo cabe el símbolo; el nombre lo pone el texto
  const enBarra = $('#brand-logo');
  if (enBarra) {
    enBarra.src = marca || logo;
    enBarra.alt = organizacion;
    enBarra.hidden = false;
    $('#brand-mark').hidden = true;
    $('#brand-titulo').textContent = 'Bitácora';
    $('#brand-sub').textContent = 'Digitalización';
  }

  // en el acceso hay espacio para el logotipo completo
  const enAcceso = $('#acceso-logo');
  if (enAcceso) {
    enAcceso.src = logo;
    enAcceso.alt = organizacion;
    enAcceso.hidden = false;
    $('#acceso-mark').hidden = true;
    $('#acceso-titulo').hidden = true;
  }
}

function mostrarAcceso(mensaje) {
  const error = $('#acceso-error');
  if (mensaje) { error.textContent = mensaje; error.hidden = false; }

  $('#btn-google').hidden = !estado.sesion.sso;

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

    if (estado.sesion.acceso && !estado.sesion.usuario) {
      estado.config = await api('/api/config').catch(() => estado.config);
      pintarLogo();
      return mostrarAcceso(parametros.get('acceso'));
    }
    if (parametros.get('acceso')) history.replaceState(null, '', location.pathname);
    if (estado.sesion.acceso) {
      estado.usuario = estado.sesion.usuario.nombre;
      $('#aviso-prueba').hidden = !estado.sesion.usuario.es_prueba;
    }

    estado.config = await api('/api/config');
    pintarLogo();
    await cargarCatalogos();
    pintarUsuario();
    nuevaRemision();
    await cargarPanel();
  } catch (e) {
    aviso(`No se pudo cargar la información: ${e.message}`, 'error');
  }
})();
