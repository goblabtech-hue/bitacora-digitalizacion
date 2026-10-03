// Recorre el flujo completo contra un servidor de prueba y comprueba cada regla.
// Lo lanza integracion.test.js con su propio servidor; uso: node flujo-completo.mjs <ruta de la base>
const BASE = process.env.BASE_PRUEBAS;
let fallas = 0;

async function entrar(email) {
  const r = await fetch(`${BASE}/auth/prueba`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email })
  });
  const galleta = r.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  return async (ruta, metodo = 'GET', cuerpo) => {
    const esPdf = metodo === 'POST-PDF';
    const res = await fetch(BASE + ruta, {
      method: esPdf ? 'POST' : metodo === 'GET-PDF' ? 'GET' : metodo,
      headers: { 'Content-Type': esPdf ? 'application/pdf' : 'application/json', Cookie: galleta },
      body: esPdf ? cuerpo : cuerpo ? JSON.stringify(cuerpo) : undefined
    });
    if (metodo === 'GET-PDF' && res.ok) {
      return { status: res.status, tipo: res.headers.get('content-type'), bytes: (await res.arrayBuffer()).byteLength };
    }
    const datos = await res.json().catch(() => ({}));
    return { status: res.status, datos, error: (datos.errores || [datos.error]).join(' ') };
  };
}

function ok(cond, nombre, extra = '') {
  console.log(`${cond ? '✔' : '✘'} ${nombre}${extra ? `  → ${extra}` : ''}`);
  if (!cond) fallas++;
}

const sup = await entrar('supervisora@prueba.local');
const ope = await entrar('operador@prueba.local');
const rec = await entrar('recepcion@prueba.local');
const sup2 = await entrar('supervisor2@prueba.local');
const mesa1 = await entrar('mesa1@prueba.local');
const norte = await entrar('norte@prueba.local');

// sin sesión no hay API
const anon = await fetch(`${BASE}/api/remisiones`);
ok(anon.status === 401, 'Sin sesión la API responde 401');

// ── recepción con NUC y folios ──
const base = { fecha: '2026-10-02', dependencia: 'PGJEH', area: 'CAT', entrega_nombre: 'Pepe Pérez', recibe_nombre: 'Recepción de prueba' };
let x = await rec('/api/remisiones', 'POST', { ...base, documentos: [{ caja: 1, fojas: 10 }] });
ok(x.status === 400 && /NUC/.test(x.error) && /folio/.test(x.error), 'Exige NUC y folios', x.error);

x = await rec('/api/remisiones', 'POST', { ...base, documentos: [{ caja: 1, nuc: 'n-1', folio_inicial: 1, folio_final: 10, fojas: 12 }] });
ok(x.status === 400 && /explica la diferencia/.test(x.error), 'Fojas distintas al rango exigen explicación', x.error);

x = await rec('/api/remisiones', 'POST', { ...base, estado: 'Devuelto', documentos: [
  { caja: 1, nuc: 'nuc-10029-343', folio_inicial: 1, folio_final: 14, fojas: 14 },
  { caja: 1, nuc: 'NUC-2', folio_inicial: 1, folio_final: 5, fojas: 6, observaciones: 'folio 3 bis' },
  { caja: 2, nuc: 'NUC-3', fojas: 7, situacion: 'Sin foliar' }
] });
ok(x.status === 201, 'Recepción válida se guarda', x.error);
let r = x.datos;
const id = r.id;
ok(r.estado === 'Recibido', 'El estado lo pone el sistema, no el cliente', r.estado);
ok(r.documentos[0].nuc === 'NUC-10029-343', 'NUC se guarda en mayúsculas');
ok(r.edicion === 'libre', 'Recién recibida se edita libremente', r.edicion);

x = await rec('/api/nuc?valor=NUC-2');
ok(x.datos.length === 1 && x.datos[0].folio === r.folio, 'Detecta NUC ya registrado');

// ── no hay rutas de borrado ni de estado manual ──
x = await sup(`/api/remisiones/${id}`, 'DELETE');
ok(x.status === 404, 'DELETE de remisión ya no existe', String(x.status));
x = await sup(`/api/remisiones/${id}`, 'PATCH', { estado: 'Devuelto' });
ok(x.status === 404, 'PATCH de estado manual ya no existe', String(x.status));

// ── edición libre con registro del antes y el después ──
const docs = r.documentos.map((d) => ({ ...d }));
docs[0].observaciones = 'portada rota';
x = await rec(`/api/remisiones/${id}`, 'PUT', { ...base, documentos: docs });
ok(x.status === 200 && x.datos.documentos[0].id === r.documentos[0].id, 'La edición conserva la identidad de cada carpeta', x.error);
ok(/observaciones — → portada rota/.test(x.datos.eventos[0].detalle), 'El historial guarda el antes y el después', x.datos.eventos[0].detalle);

// ── no se descose sin estar en mesa ──
x = await ope(`/api/remisiones/${id}/carpetas/${r.documentos[0].id}/preparacion`, 'POST', { descosida: true, fojas_contadas: 14, folios_completos: true });
ok(x.status === 400 && /asignarse a una mesa/.test(x.error), 'No se descose sin estar en mesa', x.error);

// validación completa
r = (await rec(`/api/remisiones/${id}`)).datos;
x = await rec(`/api/remisiones/${id}/validacion`, 'PUT', { por: 'Alguien Falso', documentos: r.documentos.map((d) => ({ id: d.id, cantidad: 1, fojas: d.fojas })) });
ok(x.status === 200 && x.datos.validada_por === 'Recepción de prueba', 'Quien valida sale de la sesión, no del navegador', x.datos.validada_por);
r = x.datos;
ok(r.edicion === 'requiere_solicitud', 'Validada ya no se edita sin solicitud', r.edicion);
x = await rec(`/api/remisiones/${id}`, 'PUT', { ...base, documentos: r.documentos });
ok(x.status === 400 && /solicita una corrección/.test(x.error), 'Editar validada exige corrección', x.error);

// ── solicitud de corrección: la resuelve otro supervisor ──
x = await rec(`/api/remisiones/${id}/solicitudes`, 'POST', { tipo: 'Corrección', motivo: 'Se capturó mal el área' });
ok(x.status === 201, 'Se solicita corrección', x.error);
const sol = x.datos.solicitudes[0];
x = await ope(`/api/solicitudes/${sol.id}`, 'PUT', { aprobar: true });
ok(x.status === 403, 'Un operador no resuelve solicitudes');
x = await sup(`/api/solicitudes/${sol.id}`, 'PUT', { aprobar: true });
ok(x.status === 200 && x.datos.edicion === 'autorizada', 'Supervisor aprueba y queda autorizada', x.datos.edicion);
x = await rec(`/api/remisiones/${id}`, 'PUT', { ...base, area: 'CAT Norte', documentos: x.datos.documentos });
ok(x.status === 200 && !x.datos.validada_en && x.datos.edicion === 'libre', 'La corrección se aplica y anula la validación', x.error);
ok(x.datos.solicitudes[0].estado === 'Usada', 'La autorización se consume');
r = x.datos;
x = await rec(`/api/remisiones/${id}/validacion`, 'PUT', { documentos: r.documentos.map((d) => ({ id: d.id, cantidad: 1, fojas: d.fojas })) });
r = x.datos;
ok(Boolean(r.validada_en), 'Se vuelve a validar');

// ── mesas ──
const sedes = (await sup('/api/sedes')).datos;
const principal = sedes.find((s) => s.nombre === 'Sede principal').id;
const sedeNorte = sedes.find((s) => s.nombre === 'Sede Norte').id;
x = await ope('/api/mesas', 'POST', { nombre: 'Mesa 2', responsable: 'Operador de prueba', sede_id: principal });
ok(x.status === 403, 'Un operador no da de alta mesas');
x = await sup('/api/mesas', 'POST', { nombre: 'Mesa 1', responsable: 'Operador de prueba', sede_id: principal });
ok(x.status === 400 && /ya existe/i.test(x.error), 'No se repite el nombre de mesa en la misma sede', x.error);
x = await sup('/api/mesas', 'POST', { nombre: 'Mesa 1', responsable: 'Recepción Norte de prueba', sede_id: sedeNorte });
ok(x.status === 201, 'Otra sede sí puede tener su propia Mesa 1', x.error);
const mesaNorte = x.datos.find((m) => m.sede_id === sedeNorte).id;
const mesaId = x.datos.find((m) => m.sede_id === principal && m.nombre === 'Mesa 1').id;

// ── asignación a mesa: lo primero, y solo con la recepción validada ──
const [c1, c2, c3] = r.documentos;
const idSinValidar = (await rec('/api/remisiones', 'POST', { ...base, documentos: [{ caja: 1, nuc: 'NUC-77', folio_inicial: 1, folio_final: 2, fojas: 2 }] })).datos.id;
const sinValidar = (await rec(`/api/remisiones/${idSinValidar}`)).datos;
x = await ope(`/api/remisiones/${idSinValidar}/mesa`, 'POST', { documentos: [sinValidar.documentos[0].id], mesa: mesaId });
ok(x.status === 400 && /validar la recepción/.test(x.error), 'No se asigna a mesa sin validar', x.error);
x = await ope(`/api/remisiones/${id}/carpetas/${c1.id}/escaneo`, 'POST', { fojas_escaneadas: 14, imagenes: 28 });
ok(x.status === 400, 'No se escanea sin estar en mesa', x.error);
x = await ope(`/api/remisiones/${id}/mesa`, 'POST', { documentos: [c1.id, c2.id, c3.id], mesa: mesaId });
ok(x.status === 200 && x.datos.documentos.every((d) => d.etapa === 'En mesa'), 'Tres carpetas a la Mesa 1', x.error);
ok(x.datos.estado === 'En digitalización', 'Al asignar a mesa el lote pasa a En digitalización', x.datos.estado);
ok(x.datos.asignaciones[0].responsable === 'Mesa 1 de prueba', 'Queda el responsable de ese momento');
ok(/Sede principal · Mesa 1/.test(x.datos.documentos[0].ubicacion), 'La ubicación dice sede y mesa', x.datos.documentos[0].ubicacion);
// el rol mesa solo ve lo suyo
x = await mesa1('/api/remisiones');
ok(x.status === 403, 'La mesa no ve la lista general de remisiones');
x = await mesa1('/api/digitalizacion');
ok(x.status === 200 && x.datos.en_mesas.length === 3 && !x.datos.por_asignar.length, 'La mesa ve solo sus carpetas', JSON.stringify(x.datos.en_mesas.length));
x = await mesa1(`/api/remisiones/${idSinValidar}`);
ok(x.status === 404, 'La mesa no ve un lote que no le llegó');
x = await mesa1(`/api/remisiones/${id}`);
ok(x.status === 200, 'La mesa sí ve el lote de sus carpetas');
x = await mesa1(`/api/remisiones/${id}/mesa`, 'POST', { documentos: [], mesa: mesaId });
ok(x.status === 403, 'La mesa no asigna carpetas');
x = await mesa1(`/api/remisiones/${id}/carpetas/${c1.id}/preparacion`, 'POST', { descosida: true, fojas_contadas: 1, folios_completos: true });
ok(x.status === 400 && /no coinciden|reporta/.test(x.error), 'La mesa sí trabaja sus carpetas (aquí la detiene la regla de fojas)', x.error);
// otra sede no ve ni asigna lo de la principal
x = await norte(`/api/remisiones/${id}`);
ok(x.status === 404, 'Otra sede no ve un lote que no está en ella');
x = await norte('/api/remisiones');
ok(x.status === 200 && !x.datos.some((r) => r.id === id), 'La lista de otra sede no lo incluye');
x = await ope(`/api/remisiones/${idSinValidar}/mesa`, 'POST', { documentos: [], mesa: mesaNorte });
ok(x.status === 400, 'No se asigna a una mesa sin validar el lote');
x = await rec(`/api/remisiones/${id}`);
ok(x.datos.edicion === 'en_proceso', 'Con carpetas en mesa la recepción queda cerrada', x.datos.edicion);
x = await rec(`/api/remisiones/${id}/cancelacion`, 'POST', { motivo: 'ya no se quiere cancelar' });
ok(x.status === 400, 'Ya no se puede cancelar', x.error);
x = await rec(`/api/remisiones/${id}/solicitudes`, 'POST', { tipo: 'Eliminación', motivo: 'Quiero borrar esta remisión' });
ok(x.status === 400, 'Ya no se puede pedir eliminarla', x.error);
x = await rec(`/api/remisiones/${id}/validacion`, 'PUT', { documentos: [] });
ok(x.status === 400, 'La validación queda cerrada', x.error);
x = await sup(`/api/mesas/${mesaId}`, 'PUT', { nombre: 'Mesa 1', responsable: 'Mesa 1 de prueba', activa: false, sede_id: principal });
ok(x.status === 400 && /en proceso/.test(x.error), 'No se desactiva una mesa ocupada', x.error);
x = await ope('/api/digitalizacion');
ok(x.datos.en_mesas.length === 3 && x.datos.sin_validar.some((l) => l.id === idSinValidar), 'El tablero de digitalización muestra mesas y lotes sin validar');

// ── en la mesa: descosido y revisión ──
x = await ope(`/api/remisiones/${id}/carpetas/${c1.id}/escaneo`, 'POST', { fojas_escaneadas: 14, imagenes: 28 });
ok(x.status === 400 && /descoserse/.test(x.error), 'No se escanea sin descoser', x.error);
x = await ope(`/api/remisiones/${id}/carpetas/${c1.id}/preparacion`, 'POST', { descosida: true, fojas_contadas: 13, folios_completos: true });
ok(x.status === 400 && /reporta una incidencia/.test(x.error), 'Fojas contadas distintas bloquean', x.error);
x = await ope(`/api/remisiones/${id}/carpetas/${c1.id}/preparacion`, 'POST', {
  descosida: true, fojas_contadas: 14, folios_completos: true,
  insertos: [{ tipo: 'Post-it', descripcion: 'nota amarilla', foja: 5, lado: 'Reverso' }, { tipo: 'Fotografía', descripcion: 'foto' }]
});
ok(x.status === 400 && /en qué hoja/.test(x.error), 'Inserto sin hoja se rechaza', x.error);
x = await ope(`/api/remisiones/${id}/carpetas/${c1.id}/preparacion`, 'POST', {
  descosida: true, fojas_contadas: 14, folios_completos: true,
  insertos: [{ tipo: 'Post-it', descripcion: 'nota amarilla', foja: 5 }]
});
ok(x.status === 400 && /frente, al reverso/.test(x.error), 'Inserto sin lado se rechaza', x.error);
x = await ope(`/api/remisiones/${id}/carpetas/${c1.id}/preparacion`, 'POST', {
  descosida: true, fojas_contadas: 14, folios_completos: true,
  insertos: [{ tipo: 'Post-it', descripcion: 'nota amarilla', foja: 5, lado: 'Reverso' }]
});
ok(x.status === 200 && x.datos.documentos[0].etapa === 'Descosida', 'Etapa: Descosida', x.error);
for (const c of [c2, c3]) {
  const sinFolio = c.situacion === 'Sin foliar';
  x = await ope(`/api/remisiones/${id}/carpetas/${c.id}/preparacion`, 'POST', { descosida: true, fojas_contadas: c.fojas, folios_completos: !sinFolio });
  ok(x.status === 200, `Descosida ${c.nuc}`, x.error);
}

// ── escaneo ──
x = await ope(`/api/remisiones/${id}/carpetas/${c1.id}/escaneo`, 'POST', { fojas_escaneadas: 13, imagenes: 26 });
ok(x.status === 400 && /explica/.test(x.error), 'Escaneo incompleto exige explicación', x.error);
x = await ope(`/api/remisiones/${id}/carpetas/${c1.id}/escaneo`, 'POST', { fojas_escaneadas: 13, imagenes: 26, notas: 'se atoró la foja 9' });
ok(x.status === 200 && x.datos.documentos[0].etapa === 'Por asignar', 'Escaneo incompleto regresa la carpeta a Por asignar', x.datos.documentos?.[0]?.etapa);
x = await ope(`/api/remisiones/${id}/carpetas/${c1.id}/recosido`, 'POST', { cosida: true, fojas_completas: true });
ok(x.status === 400, 'No se recose sin escaneo completo', x.error);
await ope(`/api/remisiones/${id}/mesa`, 'POST', { documentos: [c1.id], mesa: mesaId });
r = (await ope(`/api/remisiones/${id}`)).datos;
ok(r.documentos[0].etapa === 'Descosida', 'Al volver a mesa no se descose dos veces', r.documentos[0].etapa);
x = await ope(`/api/remisiones/${id}/carpetas/${c1.id}/escaneo`, 'POST', { fojas_escaneadas: 14, imagenes: 28 });
ok(x.status === 200 && x.datos.documentos[0].etapa === 'Escaneada', 'Segundo escaneo completo', x.error);
for (const c of [c2, c3]) await ope(`/api/remisiones/${id}/carpetas/${c.id}/escaneo`, 'POST', { fojas_escaneadas: c.fojas, imagenes: c.fojas * 2 });

// ── expediente digital: el PDF de cada carpeta ──
const pdf = (n) => Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n2 0 obj << /Type /Pages /Kids [' +
  Array.from({ length: n }, (_, i) => `${i + 3} 0 R`).join(' ') + `] /Count ${n} >> endobj\n` +
  Array.from({ length: n }, (_, i) => `${i + 3} 0 obj << /Type /Page /Parent 2 0 R >> endobj\n`).join('') + '%%EOF', 'latin1');
async function subir(quien, rid, did, cuerpo, consulta = '') {
  return quien(`/api/remisiones/${rid}/carpetas/${did}/archivo${consulta}`, 'POST-PDF', cuerpo);
}
x = await subir(ope, id, c1.id, pdf(27));
ok(x.status === 400 && /27 páginas.*28 imágenes/.test(x.error), 'Un PDF con páginas de menos se rechaza', x.error);
x = await subir(ope, id, c1.id, Buffer.from('no soy un pdf'));
ok(x.status === 400 && /no es un PDF/.test(x.error), 'Un archivo que no es PDF se rechaza', x.error);
x = await ope(`/api/remisiones/${id}/carpetas/${c1.id}/recosido`, 'POST', { cosida: true, fojas_completas: true });
ok(x.status === 400 && /sube el PDF/.test(x.error), 'No se recose sin su PDF', x.error);
x = await subir(ope, id, c1.id, pdf(28), '?nombre=NUC-10029.pdf');
ok(x.status === 201 && x.datos.documentos[0].archivo?.paginas === 28, 'El PDF correcto se guarda con sus páginas', x.error);
const archivo1 = x.datos.documentos[0].archivo;
ok(/^[0-9a-f]{64}$/.test(archivo1.sha256), 'Se registra su huella SHA-256');
x = await subir(ope, id, c1.id, pdf(28));
ok(x.status === 400 && /explica por qué se reemplaza/.test(x.error), 'Reemplazar exige motivo', x.error);
x = await subir(ope, id, c1.id, pdf(28), '?motivo=' + encodeURIComponent('Se volvió a escanear con mejor resolución'));
ok(x.status === 201 && x.datos.archivos.length === 2 && x.datos.archivos.filter((a) => a.vigente).length === 1, 'El reemplazo conserva la versión anterior', x.error);
const archivo2 = x.datos.documentos[0].archivo;
ok(/\.v2\.pdf$/.test(archivo2.ruta), 'La nueva versión no sobrescribe a la anterior', archivo2.ruta);
for (const c of [c2, c3]) {
  x = await subir(ope, id, c.id, pdf(c.fojas * 2));
  ok(x.status === 201, `PDF de ${c.nuc}`, x.error);
}
x = await ope(`/api/archivos/${archivo2.id}`);
ok(x.status === 403, 'Sin la sección Expedientes no se abre el PDF');
x = await sup(`/api/archivos/${archivo2.id}`, 'GET-PDF');
ok(x.status === 200 && x.tipo === 'application/pdf' && x.bytes > 100, 'Un supervisor abre el PDF', `${x.status} ${x.tipo}`);
x = await sup(`/api/remisiones/${id}`);
ok(x.datos.eventos.some((e) => e.tipo === 'Consulta' && e.usuario === 'Supervisora de prueba'), 'Cada consulta queda registrada');
x = await sup(`/api/archivos/${archivo2.id}/verificacion`);
ok(x.datos.ok === true, 'La huella del archivo guardado coincide');
x = await mesa1(`/api/archivos/${archivo2.id}`, 'GET-PDF');
ok(x.status === 200, 'La mesa abre el PDF de una carpeta que está en su mesa', String(x.status));
x = await norte(`/api/archivos/${archivo2.id}`, 'GET-PDF');
ok(x.status === 403 || x.status === 404, 'Otra sede no abre el PDF', String(x.status));
x = await sup('/api/carpetas?con_archivo=1');
ok(x.datos.length === 3 && x.datos.every((c) => c.archivo), 'Listado de expedientes digitales');

// ── reintegración y recosido ──
r = (await ope(`/api/remisiones/${id}`)).datos;
x = await ope(`/api/remisiones/${id}/carpetas/${c1.id}/recosido`, 'POST', { cosida: true, fojas_completas: true, insertos_reintegrados: [] });
ok(x.status === 400 && /hoja 5, reverso/.test(x.error), 'No se recose sin reintegrar el post-it', x.error);
const inserto = r.insertos[0].id;
x = await ope(`/api/remisiones/${id}/carpetas/${c1.id}/recosido`, 'POST', { cosida: true, fojas_completas: true, insertos_reintegrados: [inserto] });
ok(x.status === 200 && x.datos.insertos[0].reintegrado_en, 'Reintegrado y recosido', x.error);

// devolución antes de terminar
x = await rec(`/api/remisiones/${id}/devolucion`, 'PUT', { dev_fecha: '2026-10-05', dev_entrega_nombre: 'Recepción de prueba', dev_recibe_nombre: 'Pepe', dev_aceptacion: 'Aceptado' });
ok(x.status === 400 && /Faltan 2 carpetas/.test(x.error), 'No se devuelve con carpetas sin terminar', x.error);
for (const c of [c2, c3]) {
  x = await ope(`/api/remisiones/${id}/carpetas/${c.id}/recosido`, 'POST', { cosida: true, fojas_completas: true });
  ok(x.status === 200, `Recosida ${c.nuc}`, x.error);
}
ok(x.datos.estado === 'Digitalizado', 'Todas recosidas: lote Digitalizado', x.datos.estado);

// rechazada no cuenta como devuelta
x = await rec(`/api/remisiones/${id}/devolucion`, 'PUT', { dev_fecha: '2026-10-05', dev_entrega_nombre: 'Recepción de prueba', dev_recibe_nombre: 'Pepe', dev_aceptacion: 'Rechazado', dev_observaciones: 'faltan imágenes' });
ok(x.status === 200 && x.datos.estado === 'Digitalizado', 'Devolución rechazada no marca Devuelto', x.datos.estado);
x = await rec(`/api/remisiones/${id}/devolucion`, 'PUT', { dev_fecha: '2026-10-06', dev_entrega_nombre: 'Recepción de prueba', dev_recibe_nombre: 'Pepe', dev_aceptacion: 'Aceptado' });
ok(x.status === 200 && x.datos.estado === 'Devuelto', 'Devolución aceptada marca Devuelto', x.datos.estado);

// ── incidencias: se anulan, no se borran ──
x = await ope(`/api/remisiones/${id}/incidencias`, 'POST', { tipo: 'Otra', descripcion: 'prueba', reportada_por: 'Otro' });
ok(x.datos.incidencias[0].reportada_por === 'Operador de prueba', 'Quien reporta sale de la sesión');
const inc = x.datos.incidencias[0].id;
x = await ope(`/api/incidencias/${inc}`, 'DELETE');
ok(x.status === 404, 'No existe DELETE de incidencias', String(x.status));
x = await ope(`/api/incidencias/${inc}`, 'PATCH', { anular: true, motivo: 'corto' });
ok(x.status === 400, 'Anular exige motivo');
x = await ope(`/api/incidencias/${inc}`, 'PATCH', { anular: true, motivo: 'Se reportó por error en otro lote' });
ok(x.status === 200 && x.datos.incidencias[0].anulada_en, 'Incidencia anulada con motivo');

// ── cancelación y eliminación de otra remisión ──
x = await rec('/api/remisiones', 'POST', { ...base, documentos: [{ caja: 1, nuc: 'NUC-9', folio_inicial: 1, folio_final: 3, fojas: 3 }] });
const id2 = x.datos.id;
x = await ope(`/api/remisiones/${id2}/cancelacion`, 'POST', { motivo: 'La dependencia retiró el lote' });
ok(x.status === 403, 'Un operador no cancela');
x = await rec(`/api/remisiones/${id2}/cancelacion`, 'POST', { motivo: 'La dependencia retiró el lote' });
ok(x.status === 200 && x.datos.estado === 'Cancelado', 'Recepción cancela con motivo', x.error);
x = await rec(`/api/remisiones/${id2}`, 'PUT', { ...base, documentos: x.datos.documentos });
ok(x.status === 400, 'Cancelada ya no se edita', x.error);
x = await sup(`/api/remisiones/${id2}/solicitudes`, 'POST', { tipo: 'Eliminación', motivo: 'Captura duplicada de prueba' });
ok(x.status === 201, 'Supervisora solicita eliminar', x.error);
const sol2 = x.datos.solicitudes[0].id;
x = await sup(`/api/solicitudes/${sol2}`, 'PUT', { aprobar: true });
ok(x.status === 400 && /distinto de quien la pidió/.test(x.error), 'Nadie aprueba su propia solicitud', x.error);
x = await sup2(`/api/solicitudes/${sol2}`, 'PUT', { aprobar: true });
ok(x.status === 200 && x.datos.eliminada_en, 'Otro supervisor aprueba la eliminación', x.error);
x = await rec('/api/remisiones');
ok(!x.datos.some((r) => r.id === id2), 'La eliminada ya no aparece en las listas');

// ── traslado de cajas entre sedes ──
x = await rec('/api/remisiones', 'POST', { ...base, documentos: [
  { caja: 1, nuc: 'T-1', folio_inicial: 1, folio_final: 10, fojas: 10 },
  { caja: 2, nuc: 'T-2', folio_inicial: 1, folio_final: 20, fojas: 20 }] });
const idT = x.datos.id;
let rt = x.datos;
x = await rec('/api/traslados', 'POST', { destino: sedeNorte, transporta: 'Juan Chofer', cajas: [{ remision_id: idT, caja: 1 }] });
ok(x.status === 400 && /validada/.test(x.error), 'No sale una caja sin validar el lote', x.error);
rt = (await rec(`/api/remisiones/${idT}/validacion`, 'PUT', { documentos: rt.documentos.map((d) => ({ id: d.id, cantidad: 1, fojas: d.fojas })) })).datos;
x = await rec('/api/traslados', 'POST', { destino: sedeNorte, cajas: [{ remision_id: idT, caja: 1 }] });
ok(x.status === 400 && /transporta/.test(x.error), 'El traslado exige quién transporta', x.error);
x = await norte('/api/traslados', 'POST', { destino: principal, transporta: 'X', cajas: [{ remision_id: idT, caja: 1 }] });
ok(x.status === 400, 'Otra sede no envía cajas que no tiene', x.error);
x = await rec('/api/traslados', 'POST', { destino: sedeNorte, transporta: 'Juan Chofer', cajas: [{ remision_id: idT, caja: 1 }] });
ok(x.status === 201, 'Se envía la caja 1 a Sede Norte', x.error);
const trasladoId = x.datos.id;
rt = (await rec(`/api/remisiones/${idT}`)).datos;
ok(rt.documentos[0].en_transito && /En tránsito: Sede principal → Sede Norte/.test(rt.documentos[0].ubicacion), 'La carpeta aparece en tránsito', rt.documentos[0].ubicacion);
x = await ope(`/api/remisiones/${idT}/mesa`, 'POST', { documentos: [rt.documentos[0].id], mesa: mesaId });
ok(x.status === 400 && /tránsito/.test(x.error), 'Lo que va en tránsito no se asigna', x.error);
x = await norte(`/api/remisiones/${idT}`);
ok(x.status === 200, 'La sede destino ya ve el lote que va hacia ella');
x = await rec(`/api/traslados/${trasladoId}/recepcion`, 'PUT', { cajas: [] });
ok(x.status === 400 && /sede destino/.test(x.error), 'Solo la sede destino recibe');
const tc = (await norte('/api/traslados')).datos.find((t) => t.id === trasladoId).cajas[0];
x = await norte(`/api/traslados/${trasladoId}/recepcion`, 'PUT', { cajas: [{ id: tc.id, carpetas: 1, fojas: 9 }] });
ok(x.status === 400 && /explica/.test(x.error), 'Recibir con diferencia exige explicación', x.error);
x = await norte(`/api/traslados/${trasladoId}/recepcion`, 'PUT', { cajas: [{ id: tc.id, carpetas: 1, fojas: 10 }] });
ok(x.status === 200, 'La Sede Norte recibe la caja', x.error);
rt = (await norte(`/api/remisiones/${idT}`)).datos;
ok(rt.documentos[0].sede === 'Sede Norte' && !rt.documentos[0].en_transito, 'La carpeta ya está en Sede Norte', rt.documentos[0].ubicacion);
x = await sup(`/api/remisiones/${idT}/mesa`, 'POST', { documentos: [rt.documentos[0].id], mesa: mesaId });
ok(x.status === 400 && /otra sede/.test(x.error), 'Ni un supervisor asigna a una mesa de otra sede', x.error);
x = await ope(`/api/remisiones/${idT}/mesa`, 'POST', { documentos: [rt.documentos[0].id], mesa: mesaId });
ok(x.status === 403, 'La sede de origen ya no asigna lo que se fue', x.error);
x = await norte(`/api/remisiones/${idT}/mesa`, 'POST', { documentos: [rt.documentos[0].id], mesa: mesaNorte });
ok(x.status === 200, 'La Sede Norte la asigna a su propia Mesa 1', x.error);
x = await norte(`/api/remisiones/${idT}/mesa`, 'POST', { documentos: [rt.documentos[1].id], mesa: mesaNorte });
ok(x.status === 403 && /Sede principal/.test(x.error), 'Otra sede no asigna carpetas que no tiene', x.error);
x = await norte(`/api/remisiones/${id}/carpetas/${c2.id}/escaneo`, 'POST', { fojas_escaneadas: 1, imagenes: 1 });
ok(x.status === 404, 'Otra sede no trabaja carpetas de un lote ajeno');
x = await norte('/api/digitalizacion');
ok(x.datos.en_mesas.some((c) => c.nuc === 'T-1') && !x.datos.por_asignar.some((c) => c.nuc === 'T-2'), 'Cada sede ve solo sus carpetas');
x = await rec(`/api/remisiones/${idT}/devolucion`, 'PUT', { dev_fecha: '2026-10-06', dev_entrega_nombre: 'R', dev_recibe_nombre: 'P', dev_aceptacion: 'Aceptado' });
ok(x.status === 400 && /sedes distintas/.test(x.error), 'No se devuelve un lote repartido en dos sedes', x.error);

// ── la base misma impide borrar ──
const { DatabaseSync } = await import('node:sqlite');
const db = new DatabaseSync(process.argv[2]);
for (const [sql, nombre] of [
  [`DELETE FROM remisiones WHERE id = ${id2}`, 'remisiones'],
  ['DELETE FROM eventos', 'eventos'],
  ["UPDATE eventos SET detalle = 'x'", 'reescribir eventos'],
  ['DELETE FROM insertos', 'insertos'],
  [`DELETE FROM documentos WHERE remision_id = ${id}`, 'carpetas en proceso']
]) {
  let bloqueado = false;
  try { db.exec(sql); } catch { bloqueado = true; }
  ok(bloqueado, `La base impide borrar/alterar ${nombre}`);
}

// ── listados para ir del Panel al detalle ──
x = await rec('/api/carpetas?fecha=2026-10-02');
ok(x.status === 200 && x.datos.length > 0 && x.datos.every((c) => c.fecha === '2026-10-02'), 'Listado de carpetas recibidas en el día', String(x.datos.length));
x = await rec('/api/carpetas?situacion=Sin%20foliar');
ok(x.datos.length > 0 && x.datos.every((c) => c.situacion === 'Sin foliar'), 'Listado de carpetas por situación');
x = await rec('/api/carpetas?escaneadas=' + new Date(Date.now() - 6 * 3600e3).toISOString().slice(0, 10) + '&desfase=360');
ok(x.datos.length > 0 && x.datos.every((c) => c.escaneo), 'Listado de carpetas escaneadas hoy', String(x.datos.length));
x = await rec('/api/carpetas?q=nuc-2');
ok(x.datos.some((c) => c.nuc === 'NUC-2'), 'Búsqueda de carpetas por NUC');
x = await norte('/api/carpetas');
ok(!x.datos.some((c) => c.nuc === 'NUC-2'), 'Otra sede no ve carpetas ajenas en el listado');
x = await sup('/api/incidencias');
ok(x.status === 200 && !x.datos.some((i) => i.anulada_en), 'Listado de incidencias sin las anuladas');
x = await mesa1('/api/carpetas');
ok(x.status === 403, 'La mesa no consulta listados generales');

// ── periodo del Panel y del Reporte ──
x = await sup('/api/estadisticas?desde=2026-09-01&hasta=2026-09-30');
ok(x.status === 200 && x.datos.hoy.remisiones === 0, 'Un periodo sin recepciones da cero', String(x.datos.hoy.remisiones));
const dia = await sup('/api/estadisticas?fecha=2026-10-02');
const semana = await sup('/api/estadisticas?desde=2026-09-26&hasta=2026-10-02');
ok(semana.datos.hoy.remisiones === dia.datos.hoy.remisiones && dia.datos.hoy.remisiones > 0, 'La semana incluye lo del día', `${dia.datos.hoy.remisiones}/${semana.datos.hoy.remisiones}`);
x = await sup('/api/estadisticas?desde=2026-10-05&hasta=2026-10-01');
ok(x.status === 200, 'Un periodo al revés se ordena solo');
x = await sup('/api/reporte?desde=2026-10-01&hasta=2026-10-06');
ok(x.datos.desde === '2026-10-01' && x.datos.hasta === '2026-10-06' && x.datos.devolucion.lotes === 1 && x.datos.recepcion.lotes > 0,
  'El reporte de varios días junta recepciones y devoluciones', JSON.stringify([x.datos.recepcion.lotes, x.datos.devolucion.lotes]));
x = await sup('/api/reporte?fecha=2026-10-02');
ok(x.datos.devolucion.lotes === 0, 'El reporte de un día no incluye la devolución de otro día');
x = await sup('/api/carpetas?desde=2026-10-01&hasta=2026-10-03');
ok(x.datos.length > 0 && x.datos.every((c) => c.fecha >= '2026-10-01' && c.fecha <= '2026-10-03'), 'Listado de carpetas recibidas en un periodo');

// ── secciones que puede ver cada persona ──
const operador = (await sup('/api/usuarios')).datos.find((u) => u.email === 'operador@prueba.local');
ok(operador.secciones.includes('panel') && !operador.secciones.includes('personal'), 'Un operador ve las secciones de su rol', operador.secciones.join(','));
x = await sup(`/api/usuarios/${operador.id}`, 'PUT', { ...operador, permisos: [] });
ok(x.status === 400 && /al menos una/.test(x.error), 'No se deja a nadie sin secciones', x.error);
x = await sup(`/api/usuarios/${operador.id}`, 'PUT', { ...operador, permisos: ['digitalizacion'] });
ok(x.status === 200, 'Supervisor limita al operador a Digitalización', x.error);
x = await ope('/api/sesion');
ok(JSON.stringify(x.datos.usuario.permisos) === '["digitalizacion"]', 'La sesión informa sus secciones', JSON.stringify(x.datos.usuario.permisos));
x = await ope('/api/estadisticas');
ok(x.status === 403, 'Sin Panel no ve las cifras');
x = await ope('/api/remisiones');
ok(x.status === 403, 'Sin Bitácora ni Panel no ve la lista de remisiones');
x = await ope('/api/reporte?fecha=2026-10-02');
ok(x.status === 403, 'Sin Reporte no ve el reporte');
x = await ope('/api/digitalizacion');
ok(x.status === 200, 'Sí ve Digitalización');
x = await sup(`/api/usuarios/${operador.id}`, 'PUT', { ...operador, rol: 'Supervisor', permisos: ['panel'] });
x = await sup('/api/usuarios');
ok(x.datos.find((u) => u.id === operador.id).secciones.length === 8, 'Un supervisor siempre ve todo');
await sup(`/api/usuarios/${operador.id}`, 'PUT', { ...operador, rol: 'Operador', permisos: ['panel', 'digitalizacion', 'devueltas', 'bitacora', 'reporte'] });

// ── confidencialidad ──
x = await ope('/api/exportar.csv');
ok(x.status === 403, 'Un operador no exporta CSV');
const dep = (await sup('/api/dependencias')).datos[0];
const tab = await fetch(`${BASE}/api/tablero/${dep.llave}`).then((res) => res.text());
ok(!/NUC/.test(tab) && !/nota amarilla/.test(tab), 'El tablero público no expone NUC ni descripciones');

console.log(`\n${fallas ? `✘ ${fallas} fallas` : '✔ todo en orden'}`);
process.exit(fallas ? 1 : 0);
