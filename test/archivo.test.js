import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { db } from '../db.js';
import { contarPaginas, ErrorArchivo } from '../archivo.js';

/** Un PDF mínimo con su árbol de páginas, como lo guarda un escáner sencillo. */
const pdfDe = (paginas) => Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n' +
  `2 0 obj << /Type /Pages /Kids [] /Count ${paginas} >> endobj\n%%EOF`, 'latin1');

test('las pruebas usan una base en memoria, nunca la real', () => {
  assert.equal(db.location(), null);
});

test('cuenta las páginas de un PDF por su árbol de páginas', () => {
  assert.equal(contarPaginas(pdfDe(28)), 28);
});

test('cuenta las páginas cuando el escáner comprime el árbol de páginas', () => {
  const comprimido = deflateSync(Buffer.from('<< /Type /Pages /Kids [] /Count 492 >>', 'latin1'));
  const pdf = Buffer.concat([
    Buffer.from('%PDF-1.5\n5 0 obj << /Type /ObjStm /N 1 /Filter /FlateDecode >> stream\n', 'latin1'),
    comprimido,
    Buffer.from('\nendstream endobj\n%%EOF', 'latin1')
  ]);
  assert.equal(contarPaginas(pdf), 492);
});

test('rechaza un archivo que no es PDF', () => {
  assert.throws(() => contarPaginas(Buffer.from('hola')), ErrorArchivo);
});
