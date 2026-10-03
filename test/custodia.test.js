import { test } from 'node:test';
import assert from 'node:assert/strict';
import { etapaDe, prepararCarpeta, recoserCarpeta, registrarEscaneo, ErrorRegla } from '../custodia.js';

/** Un lote con una carpeta de 220 fojas, en la etapa indicada. */
const lote = (etapa, extra = {}) => ({
  id: 1,
  documentos: [{ id: 10, caja: 1, nuc: '12-2026-00451', fojas: 220, folio_inicial: 1, folio_final: 220,
                 situacion: 'Buen estado', etapa, ...extra }],
  asignaciones: [{ id: 5, documento_id: 10, mesa: 'Mesa 2' }],
  insertos: []
});

/** Comprueba que se rechaza con una regla cuyo mensaje dice lo esperado. */
const rechaza = (fn, mensaje) => assert.throws(fn, (e) => e instanceof ErrorRegla && mensaje.test(e.message));

/* ── descosido y revisión ── */

test('una carpeta con fojas de menos no puede avanzar en la mesa', () => {
  const datos = { descosida: true, folios_completos: true, fojas_contadas: 219 };
  rechaza(() => prepararCarpeta(lote('En mesa'), 10, datos, 'Laura Hernández'),
    /Se contaron 219 fojas y en la recepción se asentaron 220/);
});

test('un post-it retirado sin la hoja donde estaba no se acepta', () => {
  const datos = { descosida: true, folios_completos: true, fojas_contadas: 220,
                  insertos: [{ tipo: 'Post-it', descripcion: 'Teléfono del testigo', lado: 'Reverso' }] };
  rechaza(() => prepararCarpeta(lote('En mesa'), 10, datos, 'Laura Hernández'),
    /en qué hoja estaba el inserto 1/);
});

test('un post-it retirado sin el lado donde estaba no se acepta', () => {
  const datos = { descosida: true, folios_completos: true, fojas_contadas: 220,
                  insertos: [{ tipo: 'Post-it', descripcion: 'Teléfono del testigo', foja: 45 }] };
  rechaza(() => prepararCarpeta(lote('En mesa'), 10, datos, 'Laura Hernández'),
    /al frente, al reverso o entre dos hojas/);
});

/* ── escaneo ── */

test('un escaneo con fojas de menos exige explicar qué pasó', () => {
  rechaza(() => registrarEscaneo(lote('Descosida'), 10, { fojas_escaneadas: 218, imagenes: 436 }, 'Laura Hernández'),
    /Se escanearon 218 de 220 fojas: explica qué pasó/);
});

/* ── reintegración y recosido ── */

test('no se recose una carpeta sin su PDF', () => {
  const datos = { fojas_completas: true, cosida: true };
  rechaza(() => recoserCarpeta(lote('Escaneada'), 10, datos, 'Laura Hernández'),
    /sube el PDF/);
});

test('no se recose mientras un post-it no haya vuelto a su lugar', () => {
  const r = lote('Escaneada', { archivo: { id: 3, paginas: 440 } });
  r.insertos = [{ id: 7, documento_id: 10, tipo: 'Post-it', descripcion: 'Teléfono del testigo', foja: 45, lado: 'Reverso' }];
  const datos = { insertos_reintegrados: [], fojas_completas: true, cosida: true };
  rechaza(() => recoserCarpeta(r, 10, datos, 'Laura Hernández'),
    /«Teléfono del testigo» volvió a su lugar \(hoja 45, reverso\)/);
});

/* ── etapa de cada carpeta ── */

const carpeta = { id: 10, prep_en: '', recosido_en: '' };
const enMesa = { documento_id: 10, salida_en: '' };

test('una carpeta sin mesa está por asignar', () => {
  assert.equal(etapaDe(carpeta, []), 'Por asignar');
});

test('una carpeta asignada y sin descoser está en mesa', () => {
  assert.equal(etapaDe(carpeta, [enMesa]), 'En mesa');
});

test('una carpeta descosida que sigue en la mesa está descosida', () => {
  assert.equal(etapaDe({ ...carpeta, prep_en: '2026-10-02T10:00:00Z' }, [enMesa]), 'Descosida');
});

test('una carpeta con escaneo completo está escaneada', () => {
  assert.equal(etapaDe(carpeta, [{ documento_id: 10, salida_en: '2026-10-02T11:00:00Z', cuadra: 1 }]), 'Escaneada');
});

test('una carpeta con escaneo incompleto regresa a por asignar', () => {
  assert.equal(etapaDe(carpeta, [{ documento_id: 10, salida_en: '2026-10-02T11:00:00Z', cuadra: 0 }]), 'Por asignar');
});

test('una carpeta recosida está recosida', () => {
  assert.equal(etapaDe({ ...carpeta, recosido_en: '2026-10-02T12:00:00Z' }, []), 'Recosida');
});
