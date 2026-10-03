import { test } from 'node:test';
import assert from 'node:assert/strict';
import { db, registrarEvento } from '../db.js';

/** Una remisión con un evento en su bitácora; devuelve su id. */
function remisionConEvento(folio) {
  const { lastInsertRowid: id } = db.prepare(`INSERT INTO remisiones (folio, fecha, dependencia, entrega_nombre, recibe_nombre, creado_en, actualizado_en)
    VALUES (?, '2026-10-02', 'PGJEH', 'Pepe Pérez', 'Recepción', '2026-10-02T09:00:00Z', '2026-10-02T09:00:00Z')`).run(folio);
  registrarEvento(id, 'Recepción', 'Lote recibido', 'Recepción');
  return id;
}

test('una remisión no se puede borrar de la base', () => {
  const id = remisionConEvento('BIT-T-0001');
  assert.throws(() => db.prepare('DELETE FROM remisiones WHERE id = ?').run(id), /Las remisiones no se borran/);
});

test('la bitácora de auditoría no se puede borrar', () => {
  const id = remisionConEvento('BIT-T-0002');
  assert.throws(() => db.prepare('DELETE FROM eventos WHERE remision_id = ?').run(id), /no se borra/);
});

test('la bitácora de auditoría no se puede modificar', () => {
  const id = remisionConEvento('BIT-T-0003');
  assert.throws(() => db.prepare("UPDATE eventos SET detalle = 'otro' WHERE remision_id = ?").run(id), /no se modifica/);
});
