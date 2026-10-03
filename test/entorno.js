/* Se carga antes que cualquier prueba (npm test usa --import).
   Los módulos abren la base y la carpeta de expedientes en cuanto se
   importan, así que aquí se apuntan a lugares desechables: las pruebas
   nunca deben tocar data/bitacora.db, los respaldos ni la NAS. */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const temporal = mkdtempSync(join(tmpdir(), 'bitacora-pruebas-'));
process.env.BITACORA_DB = ':memory:';
process.env.BITACORA_ARCHIVO = join(temporal, 'archivo');
process.env.BITACORA_RESPALDOS = join(temporal, 'respaldos');
