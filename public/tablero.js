/* ══════════════════════════════════════════════════════════════════════
   Tablero de la dependencia. Solo lectura: consulta el avance de sus
   documentos con la llave que trae el enlace.
   ══════════════════════════════════════════════════════════════════════ */

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

const num = (n) => Number(n || 0).toLocaleString('es-MX');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clase = (s) => String(s || '').toLowerCase()
  .normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z]+/g, '-');

function fechaLarga(iso) {
  if (!iso) return '';
  const [a, m, d] = iso.split('-').map(Number);
  return new Date(a, m - 1, d).toLocaleDateString('es-MX',
    { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
}
function fechaCorta(iso) {
  if (!iso) return '—';
  const [a, m, d] = iso.split('-').map(Number);
  return new Date(a, m - 1, d).toLocaleDateString('es-MX', { day: '2-digit', month: 'short', year: 'numeric' });
}

const llave = location.pathname.split('/').filter(Boolean).pop();
let expandido = null;

async function cargar() {
  let datos;
  try {
    const res = await fetch(`/api/tablero/${encodeURIComponent(llave)}`);
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'No disponible');
    datos = await res.json();
  } catch (e) {
    $('#t-error-texto').textContent = e.message;
    $('#t-error').hidden = false;
    return;
  }

  document.title = `${datos.dependencia} · Estado de sus documentos`;
  $('#t-dependencia').textContent = datos.dependencia;
  $('#t-sub').textContent = `Estado de los documentos entregados a ${datos.organizacion} para su digitalización`;
  $('#t-pie').textContent = `${datos.organizacion} · Esta página es de consulta; los datos provienen de la bitácora de recepción.`;
  $('#t-actualizado').textContent = `Actualizado ${new Date(datos.generado_en)
    .toLocaleString('es-MX', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}`;

  const r = datos.resumen;
  $('#t-stats').innerHTML = [
    ['Entregas', r.lotes, `${num(r.cajas)} cajas · ${num(r.carpetas)} carpetas`],
    ['Documentos', r.documentos, `${num(r.fojas)} fojas`],
    ['Digitalizadas', r.imagenes, r.fojas ? `${(r.imagenes / r.fojas * 100).toFixed(0)}% de las fojas` : ''],
    ['En proceso', r.en_proceso, 'lotes sin concluir'],
    ['Devueltos', r.devueltos, 'lotes cerrados'],
    ['Incidencias', r.incidencias_abiertas, 'abiertas']
  ].map(([etiqueta, valor, pie]) => `
    <div class="stat">
      <div class="stat-label">${etiqueta}</div>
      <div class="stat-valor">${num(valor)}</div>
      <div class="stat-pie">${pie}</div>
    </div>`).join('');

  pintarLotes(datos.lotes);
}

function pintarLotes(lotes) {
  if (!lotes.length) {
    $('#t-lotes').innerHTML = `<div class="vacio"><strong>Todavía no hay entregas registradas</strong>
      <span>Aquí aparecerán en cuanto se reciba el primer lote.</span></div>`;
    return;
  }

  $('#t-lotes').innerHTML = `
    <table class="tabla">
      <thead><tr>
        <th>Folio</th><th>Recibido</th><th class="num">Documentos</th><th class="num">Fojas</th>
        <th class="num">Cajas</th><th>Avance</th><th>Estado</th>
      </tr></thead>
      <tbody>${lotes.map((l, i) => filaLote(l, i)).join('')}</tbody>
    </table>`;

  $$('#t-lotes tbody tr[data-lote]').forEach((tr) => tr.addEventListener('click', () => {
    expandido = expandido === Number(tr.dataset.lote) ? null : Number(tr.dataset.lote);
    pintarLotes(lotes);
  }));
}

function filaLote(l, i) {
  const avance = l.total_fojas ? Math.min(100, l.total_imagenes / l.total_fojas * 100) : 0;
  const abierta = l.incidencias.filter((x) => x.estado === 'Abierta').length;

  const detalle = expandido === i ? `
    <tr class="detalle-lote"><td colspan="7">
      <div class="detalle-caja">
        <div>
          <b>Documentos entregados</b>
          <table class="tabla tabla-anidada">
            <thead><tr><th>Descripción</th><th>Tipo</th>
              <th class="num">Cant.</th><th class="num">Fojas</th><th>Situación al recibir</th></tr></thead>
            <tbody>${l.documentos.map((d) => `
              <tr><td>${esc(d.descripcion)}</td><td class="celda-sec">${esc(d.tipo || '—')}</td>
                <td class="num">${num(d.cantidad)}</td><td class="num">${num(d.fojas)}</td>
                <td class="celda-sec">${esc(d.situacion)}</td></tr>`).join('')}
            </tbody>
          </table>
        </div>

        ${l.incidencias.length ? `
          <div style="margin-top:16px">
            <b>Incidencias</b>
            ${l.incidencias.map((x) => `
              <div class="lista-fila" style="padding:8px 0;border-top:1px solid var(--separator)">
                <div class="principal">
                  <b>${esc(x.tipo)}</b> <span class="pill ${clase(x.gravedad)}">${esc(x.gravedad)}</span>
                  <div class="secundario">${esc(x.descripcion)}</div>
                </div>
                <span class="pill ${x.estado === 'Abierta' ? 'abierta' : 'digitalizado'}">${esc(x.estado)}</span>
              </div>`).join('')}
          </div>` : ''}

        ${l.dev_fecha ? `
          <p class="sub" style="margin-top:16px">
            <b>Devuelto el ${fechaCorta(l.dev_fecha)}</b> · ${esc(l.dev_aceptacion || '')}
            ${l.dev_archivos ? ` · ${num(l.dev_archivos)} archivos entregados` : ''}
            ${l.dev_medio ? ` por ${esc(l.dev_medio).toLowerCase()}` : ''}
          </p>` : ''}
      </div>
    </td></tr>` : '';

  return `
    <tr data-lote="${i}">
      <td class="folio">${esc(l.folio)}</td>
      <td>${fechaCorta(l.fecha)}<div class="celda-sec">${esc(l.hora || '')}</div></td>
      <td class="num">${num(l.total_documentos)}</td>
      <td class="num">${num(l.total_fojas)}</td>
      <td class="num">${num(l.cajas)}${l.carpetas ? `<div class="celda-sec">${num(l.carpetas)} carp.</div>` : ''}</td>
      <td style="min-width:130px">
        <div class="barra"><i style="width:${avance.toFixed(1)}%"></i></div>
        <div class="celda-sec">${l.total_imagenes ? `${num(l.total_imagenes)} imágenes` : 'sin iniciar'}</div>
      </td>
      <td>
        <span class="pill ${clase(l.estado)}">${esc(l.estado)}</span>
        ${abierta ? `<span class="pill alta" style="margin-left:5px">${num(abierta)}</span>` : ''}
      </td>
    </tr>${detalle}`;
}

cargar().then(() => { $('#tablero').hidden = false; });
setInterval(cargar, 120000);   // se refresca solo cada dos minutos
