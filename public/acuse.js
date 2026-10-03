/* ══════════════════════════════════════════════════════════════════════
   Acuse de recepción, etiquetas de caja y captura de firma.
   ══════════════════════════════════════════════════════════════════════ */

/* ─────────────────────────── modal genérico ─────────────────────────── */

function abrirModal({ titulo, cuerpo, botones = [], ancho = false }) {
  document.querySelector('.modal').classList.toggle('modal-ancho', ancho);
  document.getElementById('modal-titulo').textContent = titulo;
  document.getElementById('modal-cuerpo').innerHTML = cuerpo;
  const pie = document.getElementById('modal-pie');
  pie.innerHTML = '';
  botones.forEach(({ texto, clase = 'btn', accion }) => {
    const b = document.createElement('button');
    b.className = clase;
    b.textContent = texto;
    b.addEventListener('click', accion);
    pie.appendChild(b);
  });
  document.getElementById('modal-fondo').hidden = false;
}

function cerrarModal() {
  document.getElementById('modal-fondo').hidden = true;
  document.getElementById('modal-cuerpo').innerHTML = '';
}

document.getElementById('modal-cerrar').addEventListener('click', cerrarModal);
document.getElementById('modal-fondo').addEventListener('click', (e) => {
  if (e.target.id === 'modal-fondo') cerrarModal();
});

/* ──────────────────────────── tableta de firma ──────────────────────── */

function crearPad(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const caja = canvas.getBoundingClientRect();
  canvas.width = Math.round(caja.width * dpr);
  canvas.height = Math.round(caja.height * dpr);

  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.lineWidth = 2.2;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = '#111';

  let trazando = false;
  let vacio = true;
  const punto = (e) => {
    const b = canvas.getBoundingClientRect();
    return { x: e.clientX - b.left, y: e.clientY - b.top };
  };

  canvas.addEventListener('pointerdown', (e) => {
    trazando = true; vacio = false;
    try { canvas.setPointerCapture(e.pointerId); } catch { /* puntero sin captura */ }
    const p = punto(e);
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
    ctx.lineTo(p.x + 0.1, p.y);      // un toque simple deja marca
    ctx.stroke();
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!trazando) return;
    const p = punto(e);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
  });
  const fin = () => { trazando = false; };
  canvas.addEventListener('pointerup', fin);
  canvas.addEventListener('pointercancel', fin);
  canvas.addEventListener('pointerleave', fin);

  return {
    limpiar() { ctx.clearRect(0, 0, canvas.width, canvas.height); vacio = true; },
    get vacio() { return vacio; },
    imagen() {
      const salida = document.createElement('canvas');
      salida.width = canvas.width;
      salida.height = canvas.height;
      const c = salida.getContext('2d');
      c.fillStyle = '#fff';
      c.fillRect(0, 0, salida.width, salida.height);
      c.drawImage(canvas, 0, 0);
      return salida.toDataURL('image/png');
    }
  };
}

/** Captura de firmas genérica: dos trazos, se envían a `ruta`. */
function capturarFirmas({ titulo, nota, entrega, recibe, ruta, alGuardar }) {
  const bloque = (clave, papel, persona) => `
    <div class="firma-bloque">
      <div class="firma-cab"><b>${papel}</b><span>${esc(persona.nombre)}${persona.cargo ? ' · ' + esc(persona.cargo) : ''}</span></div>
      <canvas class="firma-lienzo" id="pad-${clave}"></canvas>
      <div class="firma-pie"><small>${esc(persona.pie)}</small>
        <button type="button" class="link-btn" data-limpiar="${clave}">Limpiar</button></div>
    </div>`;

  abrirModal({
    titulo,
    cuerpo: `<p class="sub" style="margin-bottom:16px">${nota}</p>
      ${bloque('entrega', 'Entrega', entrega)}
      ${bloque('recibe', 'Recibe', recibe)}`,
    botones: [
      { texto: 'Cancelar', accion: cerrarModal },
      { texto: 'Guardar firmas', clase: 'btn btn-primary', accion: guardar }
    ]
  });

  const pads = {
    entrega: crearPad(document.getElementById('pad-entrega')),
    recibe: crearPad(document.getElementById('pad-recibe'))
  };
  document.querySelectorAll('[data-limpiar]').forEach((b) =>
    b.addEventListener('click', () => pads[b.dataset.limpiar].limpiar()));

  async function guardar() {
    if (pads.entrega.vacio && pads.recibe.vacio) return aviso('Captura al menos una firma.', 'error');
    try {
      const actualizada = await api(ruta, {
        method: 'POST',
        body: JSON.stringify({
          firma_entrega: pads.entrega.vacio ? '' : pads.entrega.imagen(),
          firma_recibe: pads.recibe.vacio ? '' : pads.recibe.imagen()
        })
      });
      cerrarModal();
      aviso('Firmas guardadas.');
      alGuardar?.(actualizada);
    } catch (e) {
      aviso(e.message, 'error');
    }
  }
}

/** Firmas del acuse de recepción. */
function firmarRemision(r, alGuardar) {
  capturarFirmas({
    titulo: `Firma del acuse · ${r.folio}`,
    nota: `Firma con el dedo, el ratón o un lápiz digital. La firma queda unida a este acuse;
           si más adelante se edita la remisión, las firmas se anulan.`,
    entrega: { nombre: r.entrega_nombre, cargo: r.entrega_cargo, pie: 'Trazo de quien entrega los documentos' },
    recibe: { nombre: r.recibe_nombre, cargo: r.recibe_cargo, pie: 'Trazo de quien recibe los documentos' },
    ruta: `/api/remisiones/${r.id}/firma`,
    alGuardar
  });
}

/** Firmas del acuse de devolución y punto de aceptación. */
function firmarDevolucion(r, alGuardar) {
  capturarFirmas({
    titulo: `Firma de la devolución · ${r.folio}`,
    nota: `Con estas firmas se cierra la custodia: quien devuelve los documentos y las imágenes,
           y quien los recibe de conformidad en la dependencia.`,
    entrega: { nombre: r.dev_entrega_nombre, cargo: r.dev_entrega_cargo, pie: 'Trazo de quien devuelve' },
    recibe: { nombre: r.dev_recibe_nombre, cargo: r.dev_recibe_cargo, pie: 'Trazo de quien recibe de conformidad' },
    ruta: `/api/remisiones/${r.id}/devolucion/firma`,
    alGuardar
  });
}

/* ───────────────────────── cajas de un lote ─────────────────────────── */

/** Cómo se nombra una carpeta: su NUC y, si la hay, su descripción. */
function nombreCarpeta(d) {
  const nuc = d.nuc ? `<b class="nuc">${esc(d.nuc)}</b>` : '';
  return [nuc, esc(d.descripcion || '')].filter(Boolean).join(' · ') || `Carpeta ${d.id}`;
}

/** Rango de folios de una carpeta, para comprobar que no falta ninguna hoja. */
const foliosDe = (d) => (d.folio_inicial !== null && d.folio_inicial !== undefined && d.folio_final !== null
  ? `fs. ${num(d.folio_inicial)}–${num(d.folio_final)}` : 'sin foliar');

/** Agrupa las carpetas de un lote por caja, con sus totales. */
function agruparCajas(documentos) {
  const cajas = new Map();
  for (const d of documentos) {
    if (!cajas.has(d.caja)) cajas.set(d.caja, { caja: d.caja, carpetas: [], fojas: 0 });
    const c = cajas.get(d.caja);
    c.carpetas.push(d);
    c.fojas += d.fojas;
  }
  return [...cajas.values()];
}

/** Filas de tabla por caja: un renglón de encabezado con el subtotal y
 *  después sus carpetas, numeradas dentro de la caja. */
function filasPorCaja(documentos, columnas, fila) {
  return agruparCajas(documentos).map((c) => `
    <tr class="fila-caja"><td colspan="${columnas}">
      <b>Caja ${c.caja}</b> · ${num(c.carpetas.length)} carpeta${c.carpetas.length === 1 ? '' : 's'}
      · ${num(c.fojas)} fojas</td></tr>
    ${c.carpetas.map((d, i) => fila(d, i + 1)).join('')}`).join('');
}

/* ───────────────────────── documentos imprimibles ───────────────────── */

function imprimir(html) {
  const caja = document.getElementById('impresion');
  caja.innerHTML = html;
  const limpiar = () => { caja.innerHTML = ''; window.removeEventListener('afterprint', limpiar); };
  window.addEventListener('afterprint', limpiar);
  window.print();
}

function acuseHTML(r) {
  const cfg = estado.config;
  const filas = filasPorCaja(r.documentos, 5, (d, n) => `
    <tr>
      <td>${n}</td>
      <td>${nombreCarpeta(d)}${d.observaciones ? `<br><small>${esc(d.observaciones)}</small>` : ''}</td>
      <td>${foliosDe(d)}</td>
      <td class="num">${num(d.fojas)}</td>
      <td>${esc(d.situacion)}</td>
    </tr>`);

  const firma = (imagen, nombre, cargo, papel) => `
    <div class="doc-firma">
      <div class="trazo">${imagen ? `<img src="${imagen}" alt="Firma de ${esc(nombre)}">` : ''}</div>
      <b>${esc(nombre)}</b>
      ${cargo ? `<span>${esc(cargo)}</span>` : ''}
      <span>${esc(papel)}</span>
    </div>`;

  return `
  <article class="doc">
    <header class="doc-cab">
      <div>
        <div class="org">${esc(cfg.organizacion)}</div>
        <h1>Acuse de recepción de documentos</h1>
        <div class="folio">${esc(r.folio)}</div>
      </div>
      ${QR.svg(r.folio, { modulo: 3, margen: 2 })}
    </header>

    <div class="doc-datos">
      <div><span>Fecha</span><b>${fechaCorta(r.fecha)}${r.hora ? ` ${esc(r.hora)} h` : ''}</b></div>
      <div><span>Dependencia</span><b>${esc(r.dependencia)}</b></div>
      <div><span>Área o unidad</span><b>${esc(r.area || '—')}</b></div>
      <div><span>Estado del lote</span><b>${esc(r.estado)}</b></div>
      <div><span>Cajas</span><b>${num(r.cajas)}</b></div>
      <div><span>Carpetas</span><b>${num(r.carpetas)}</b></div>
      <div><span>Fojas</span><b>${num(r.total_fojas)}</b></div>
    </div>

    <table>
      <thead><tr><th>#</th><th>Carpeta (NUC)</th><th>Folios</th><th class="num">Fojas</th><th>Situación</th></tr></thead>
      <tbody>${filas}</tbody>
      <tfoot><tr><td colspan="3">Totales · ${num(r.cajas)} caja${r.cajas === 1 ? '' : 's'} ·
          ${num(r.carpetas)} carpeta${r.carpetas === 1 ? '' : 's'}</td>
        <td class="num">${num(r.total_fojas)}</td><td></td></tr></tfoot>
    </table>

    ${r.observaciones ? `<div class="doc-obs"><b>Observaciones</b>${esc(r.observaciones)}</div>` : ''}

    ${r.validada_en ? `<div class="doc-obs"><b>Validación del lote</b>
      Cotejado físicamente por ${esc(r.validada_por || '—')} el
      ${new Date(r.validada_en).toLocaleDateString('es-MX', { day: '2-digit', month: 'long', year: 'numeric' })}:
      ${r.validacion.documentos === 0 && r.validacion.fojas === 0
        ? 'coincide con lo asentado.'
        : `diferencia de ${num(r.validacion.documentos)} documentos y ${num(r.validacion.fojas)} fojas.`}
      ${r.validacion_notas ? esc(r.validacion_notas) : ''}</div>` : ''}

    <p class="doc-leyenda">${esc(cfg.leyenda_acuse)}</p>

    <div class="doc-firmas">
      ${firma(r.firma_entrega, r.entrega_nombre, r.entrega_cargo, 'Entrega')}
      ${firma(r.firma_recibe, r.recibe_nombre, r.recibe_cargo, 'Recibe')}
    </div>

    <p class="doc-pie">
      ${esc(r.folio)} · generado el ${new Date().toLocaleString('es-MX')}
      ${r.firmado_en ? ` · firmado el ${new Date(r.firmado_en).toLocaleString('es-MX')}` : ''}
    </p>
  </article>`;
}

function etiquetasHTML(r) {
  const cfg = estado.config;
  const cajas = agruparCajas(r.documentos);
  const total = cajas.length;
  const qr = QR.svg(r.folio, { modulo: 3, margen: 2 });
  const etiquetas = cajas.map((c, i) => `
    <div class="etiqueta">
      ${qr}
      <div class="etiqueta-datos">
        <div class="org">${esc(cfg.organizacion)}</div>
        <div class="folio">${esc(r.folio)}</div>
        <div class="caja">Caja ${i + 1} de ${total}</div>
        <div class="dep">${esc(r.dependencia)}</div>
        <div class="meta">${esc(r.area || '')}</div>
        <div class="meta">${fechaCorta(r.fecha)} · ${num(c.carpetas.length)} carpeta${c.carpetas.length === 1 ? '' : 's'} · ${num(c.fojas)} fojas</div>
      </div>
    </div>`).join('');
  return `<div class="etiquetas">${etiquetas}</div>`;
}

function acuseDevolucionHTML(r) {
  const cfg = estado.config;
  const leyendas = {
    'Aceptado':
      `Recibí de conformidad los documentos físicos descritos y las imágenes digitalizadas correspondientes,
       sin observaciones.`,
    'Aceptado con observaciones':
      `Recibí los documentos físicos descritos y las imágenes digitalizadas correspondientes, con las
       observaciones asentadas en este acuse, que quedan pendientes de atender.`,
    'Rechazado':
      `Se hace constar que la entrega no fue aceptada por las razones asentadas en este acuse.`
  };

  // con cotejo, los totales del encabezado son los realmente devueltos
  const devueltos = {
    documentos: r.documentos.reduce((a, d) => a + (d.cantidad_devuelta ?? 0), 0),
    fojas: r.documentos.reduce((a, d) => a + (d.fojas_devueltas ?? 0), 0)
  };
  const totalDevuelto = r.cotejo_en ? devueltos.documentos : r.total_documentos;
  const fojasDevueltas = r.cotejo_en ? devueltos.fojas : r.total_fojas;

  const filas = filasPorCaja(r.documentos, 7, (d, n) => {
    const devuelto = d.cantidad_devuelta ?? null;
    const dif = devuelto === null ? 0 : devuelto - d.cantidad;
    const difFojas = devuelto === null ? 0 : (d.fojas_devueltas ?? 0) - d.fojas;
    const sale = d.situacion_devuelta || '';
    // cómo sale cada carpeta comparado con cómo se recibió
    const condicion = devuelto === null ? `${esc(d.situacion)} · sin cotejar`
      : [dif ? `<b>${dif > 0 ? '+' : ''}${num(dif)} carpeta</b>` : '',
         difFojas ? `<b>${difFojas > 0 ? '+' : ''}${num(difFojas)} fojas</b>` : '',
         sale && sale !== d.situacion ? `<b>${esc(d.situacion)} → ${esc(sale)}</b>` : ''
        ].filter(Boolean).join(' · ') || `Sin cambios · ${esc(d.situacion)}`;
    return `
    <tr><td>${n}</td><td>${nombreCarpeta(d)}<br><small>${foliosDe(d)}</small></td>
      <td class="num">${num(d.cantidad)}</td><td class="num">${num(d.fojas)}</td>
      <td class="num">${devuelto === null ? '—' : num(devuelto)}</td>
      <td class="num">${devuelto === null ? '—' : num(d.fojas_devueltas ?? 0)}</td>
      <td>${condicion}</td></tr>`;
  });

  const incidencias = r.incidencias.length ? `
    <table style="margin-top:4px">
      <thead><tr><th>Incidencia</th><th>Gravedad</th><th>Estado</th><th>Resolución</th></tr></thead>
      <tbody>${r.incidencias.map((i) => `
        <tr><td>${esc(i.tipo)}<br><small>${esc(i.descripcion)}</small></td>
          <td>${esc(i.gravedad)}</td><td>${esc(i.estado)}</td>
          <td>${esc(i.resolucion || '—')}</td></tr>`).join('')}
      </tbody>
    </table>` : '<p class="doc-obs">Sin incidencias registradas durante el servicio.</p>';

  const firma = (imagen, nombre, cargo, papel) => `
    <div class="doc-firma">
      <div class="trazo">${imagen ? `<img src="${imagen}" alt="Firma de ${esc(nombre)}">` : ''}</div>
      <b>${esc(nombre)}</b>${cargo ? `<span>${esc(cargo)}</span>` : ''}<span>${esc(papel)}</span>
    </div>`;

  return `
  <article class="doc">
    <header class="doc-cab">
      <div>
        <div class="org">${esc(cfg.organizacion)}</div>
        <h1>Acuse de devolución y aceptación</h1>
        <div class="folio">${esc(r.folio)}</div>
      </div>
      ${QR.svg(r.folio, { modulo: 3, margen: 2 })}
    </header>

    <div class="doc-datos">
      <div><span>Fecha de devolución</span><b>${fechaCorta(r.dev_fecha)}</b></div>
      <div><span>Dependencia</span><b>${esc(r.dependencia)}</b></div>
      <div><span>Recepción original</span><b>${fechaCorta(r.fecha)}</b></div>
      <div><span>Resultado</span><b>${esc(r.dev_aceptacion)}</b></div>
      <div><span>Documentos devueltos</span><b>${num(totalDevuelto)}</b>
        ${r.cotejo_en && totalDevuelto !== r.total_documentos
          ? `<span>de ${num(r.total_documentos)} recibidos</span>` : ''}</div>
      <div><span>Fojas</span><b>${num(fojasDevueltas)}</b></div>
      <div><span>Cajas y carpetas</span>
        <b>${num(r.cajas)} caja${r.cajas === 1 ? '' : 's'} · ${num(r.carpetas)} carpeta${r.carpetas === 1 ? '' : 's'}</b></div>
      <div><span>Imágenes entregadas</span><b>${num(r.dev_archivos)}</b></div>
    </div>

    <p class="doc-obs"><b>Medio de entrega digital</b>${esc(r.dev_medio || 'No especificado')}</p>

    <table>
      <thead>
        <tr><th rowspan="2">#</th><th rowspan="2">Carpeta</th>
          <th class="num" colspan="2">Recibido</th>
          <th class="num" colspan="2">Devuelto</th>
          <th rowspan="2">Condición al devolver</th></tr>
        <tr><th class="num">Cant.</th><th class="num">Fojas</th>
            <th class="num">Cant.</th><th class="num">Fojas</th></tr>
      </thead>
      <tbody>${filas}</tbody>
      <tfoot><tr><td colspan="2">Totales</td>
        <td class="num">${num(r.total_documentos)}</td>
        <td class="num">${num(r.total_fojas)}</td>
        <td class="num">${num(devueltos.documentos)}</td>
        <td class="num">${num(devueltos.fojas)}</td>
        <td></td></tr></tfoot>
    </table>

    ${r.cotejo_en ? `<p class="doc-obs"><b>Cotejo de la devolución</b>
      Verificado caja por caja por ${esc(r.cotejo_por || '—')} el
      ${new Date(r.cotejo_en).toLocaleDateString('es-MX', { day: '2-digit', month: 'long', year: 'numeric' })}:
      ${r.cotejo.documentos === 0 && r.cotejo.fojas === 0 && !r.cotejo.cambios
        ? `las ${num(r.cajas)} cajas se devuelven con las mismas carpetas, las mismas fojas y en la misma
           situación en que se recibieron.`
        : [r.cotejo.documentos || r.cotejo.fojas
            ? `diferencia de ${num(r.cotejo.documentos)} carpetas y ${num(r.cotejo.fojas)} fojas` : '',
           r.cotejo.cambios === 1 ? '1 carpeta cambió de situación'
            : r.cotejo.cambios ? `${num(r.cotejo.cambios)} carpetas cambiaron de situación` : ''
          ].filter(Boolean).join('; ') + '.'}
      ${r.cotejo_notas ? esc(r.cotejo_notas) : ''}</p>` : ''}

    <p class="doc-obs"><b>Incidencias del servicio</b></p>
    ${incidencias}

    ${r.dev_observaciones ? `<div class="doc-obs" style="margin-top:12px">
      <b>Observaciones de la aceptación</b>${esc(r.dev_observaciones)}</div>` : ''}

    <p class="doc-leyenda">${leyendas[r.dev_aceptacion] || ''}</p>

    <div class="doc-firmas">
      ${firma(r.dev_firma_entrega, r.dev_entrega_nombre, r.dev_entrega_cargo, 'Entrega y devuelve')}
      ${firma(r.dev_firma_recibe, r.dev_recibe_nombre, r.dev_recibe_cargo, 'Recibe de conformidad')}
    </div>

    <p class="doc-pie">
      ${esc(r.folio)} · acuse de devolución generado el ${new Date().toLocaleString('es-MX')}
      ${r.dev_firmado_en ? ` · firmado el ${new Date(r.dev_firmado_en).toLocaleString('es-MX')}` : ''}
    </p>
  </article>`;
}

const imprimirAcuse = (r) => imprimir(acuseHTML(r));
const imprimirAcuseDevolucion = (r) => imprimir(acuseDevolucionHTML(r));
const imprimirEtiquetas = (r) => imprimir(etiquetasHTML(r));
