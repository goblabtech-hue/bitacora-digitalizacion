/* ══════════════════════════════════════════════════════════════════════
   Inicio de sesión con Google (OAuth 2.0 + PKCE, OpenID Connect).

   Se activa cuando existen GOOGLE_CLIENT_ID y GOOGLE_CLIENT_SECRET.
   Sin esas variables el sistema sigue en modo local: la identidad se
   declara desde cada equipo, como antes.
   ══════════════════════════════════════════════════════════════════════ */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { db, secretoSesion } from './db.js';

/* Los secretos casi siempre se pegan a mano: un espacio o un salto de línea
   de más viaja hasta Google y devuelve un «invalid_client» imposible de
   diagnosticar. Se limpian aquí de una vez. */
const CLIENT_ID = (process.env.GOOGLE_CLIENT_ID || '').trim();
const CLIENT_SECRET = (process.env.GOOGLE_CLIENT_SECRET || '').trim();
const DOMINIO = (process.env.BITACORA_DOMINIO || '').trim().toLowerCase();
const HORAS_SESION = Number(process.env.BITACORA_HORAS_SESION) || 12;

const AUTORIZAR = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN = 'https://oauth2.googleapis.com/token';
const EMISORES = ['https://accounts.google.com', 'accounts.google.com'];

export const ssoActivo = () => Boolean(CLIENT_ID && CLIENT_SECRET);

/* ── entrada de prueba ──────────────────────────────────────────────────
   Permite conocer el sistema con sesiones reales antes de tener las
   credenciales de Google. Se enciende solo con BITACORA_ACCESO_PRUEBA=1 y
   únicamente admite cuentas del dominio ficticio, para que jamás sirva
   para entrar como una persona real.                                    */
const DOMINIO_PRUEBA = 'prueba.local';

export const pruebaActiva = () => process.env.BITACORA_ACCESO_PRUEBA === '1';

/** Hay control de acceso si está Google o si está la entrada de prueba. */
export const accesoActivo = () => ssoActivo() || pruebaActiva();

/** Crea las cuentas de prueba la primera vez, si no hay nadie dado de alta. */
export function sembrarPrueba() {
  if (!pruebaActiva()) return;
  if (db.prepare('SELECT COUNT(*) AS n FROM usuarios').get().n > 0) return;
  const t = new Date().toISOString();
  const alta = db.prepare('INSERT INTO usuarios (nombre, email, rol, creado_en) VALUES (?,?,?,?)');
  for (const [nombre, correo, rol] of [
    ['Supervisora de prueba', `supervisora@${DOMINIO_PRUEBA}`, 'Supervisor'],
    ['Operador de prueba',    `operador@${DOMINIO_PRUEBA}`,    'Operador'],
    ['Recepción de prueba',   `recepcion@${DOMINIO_PRUEBA}`,   'Recepción']
  ]) alta.run(nombre, correo, rol, t);
}

export function usuariosPrueba() {
  if (!pruebaActiva()) return [];
  return db.prepare(
    'SELECT nombre, email, rol FROM usuarios WHERE activo = 1 AND email LIKE ? ORDER BY id'
  ).all(`%@${DOMINIO_PRUEBA}`);
}

export const esCuentaPrueba = (correo) =>
  String(correo || '').toLowerCase().endsWith(`@${DOMINIO_PRUEBA}`);

export function entrarPrueba(req, res, correo) {
  if (!pruebaActiva()) throw new Error('La entrada de prueba no está habilitada.');
  const email = String(correo || '').toLowerCase().trim();
  if (!esCuentaPrueba(email)) {
    throw new Error(`La entrada de prueba solo admite cuentas de ${DOMINIO_PRUEBA}.`);
  }
  const persona = db.prepare('SELECT * FROM usuarios WHERE lower(email) = ?').get(email);
  if (!persona || !persona.activo) throw new Error('Esa cuenta de prueba no existe.');

  ponerCookie(res, 'bitacora_sesion', firmar({ correo: email, exp: Date.now() + HORAS_SESION * 3600_000 }), {
    segundos: HORAS_SESION * 3600, seguro: baseUrl(req).startsWith('https')
  });
  return persona;
}

export function baseUrl(req) {
  if (process.env.BITACORA_URL) return process.env.BITACORA_URL.trim().replace(/\/+$/, '');
  const cab = req.headers || {};
  const host = cab.host || `localhost:${process.env.PORT || 4321}`;
  // detrás de un proxy que termina TLS, el esquema real llega en la cabecera
  const esquema = process.env.BITACORA_TLS_CERT ? 'https'
    : String(cab['x-forwarded-proto'] || '').split(',')[0].trim() || 'http';
  return `${esquema}://${host}`;
}

const redirectUri = (req) => `${baseUrl(req)}/auth/google/callback`;

/* ──────────────────────────── cookies ──────────────────────────── */

export function leerCookies(req) {
  const salida = {};
  for (const parte of (req.headers.cookie || '').split(';')) {
    const i = parte.indexOf('=');
    if (i < 0) continue;
    salida[parte.slice(0, i).trim()] = decodeURIComponent(parte.slice(i + 1).trim());
  }
  return salida;
}

function ponerCookie(res, nombre, valor, { segundos, seguro }) {
  const partes = [
    `${nombre}=${encodeURIComponent(valor)}`,
    'Path=/', 'HttpOnly', 'SameSite=Lax',
    segundos === 0 ? 'Max-Age=0' : `Max-Age=${segundos}`
  ];
  if (seguro) partes.push('Secure');
  const previas = res.getHeader('Set-Cookie') || [];
  res.setHeader('Set-Cookie', [...(Array.isArray(previas) ? previas : [previas]), partes.join('; ')]);
}

/* ──────────────────────── firma de los sobres ──────────────────── */

function firmar(datos) {
  const cuerpo = Buffer.from(JSON.stringify(datos)).toString('base64url');
  const firma = createHmac('sha256', secretoSesion()).update(cuerpo).digest('base64url');
  return `${cuerpo}.${firma}`;
}

function abrir(sobre) {
  if (typeof sobre !== 'string' || !sobre.includes('.')) return null;
  const [cuerpo, firma] = sobre.split('.', 2);
  const esperada = createHmac('sha256', secretoSesion()).update(cuerpo).digest('base64url');
  const a = Buffer.from(firma), b = Buffer.from(esperada);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const datos = JSON.parse(Buffer.from(cuerpo, 'base64url').toString());
    return datos.exp && datos.exp < Date.now() ? null : datos;
  } catch { return null; }
}

/* ──────────────────────────── entrada ──────────────────────────── */

/** Paso 1: manda al usuario a Google. */
export function iniciar(req, res) {
  const verificador = randomBytes(32).toString('base64url');
  const estado = randomBytes(16).toString('base64url');
  const reto = createHash('sha256').update(verificador).digest('base64url');

  ponerCookie(res, 'bitacora_oauth', firmar({ verificador, estado, exp: Date.now() + 10 * 60_000 }), {
    segundos: 600, seguro: baseUrl(req).startsWith('https')
  });

  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: redirectUri(req),
    response_type: 'code',
    scope: 'openid email profile',
    state: estado,
    code_challenge: reto,
    code_challenge_method: 'S256',
    access_type: 'online',
    prompt: 'select_account'
  });
  if (DOMINIO) params.set('hd', DOMINIO);

  res.writeHead(302, { Location: `${AUTORIZAR}?${params}` });
  res.end();
}

/** Lee las afirmaciones del id_token. Llega directo de Google por TLS,
 *  aun así se comprueban emisor, destinatario y vigencia. */
function afirmaciones(idToken) {
  const partes = String(idToken || '').split('.');
  if (partes.length !== 3) throw new Error('Google devolvió un identificador ilegible.');
  let datos;
  try {
    datos = JSON.parse(Buffer.from(partes[1], 'base64url').toString());
  } catch {
    throw new Error('Google devolvió un identificador ilegible.');
  }

  if (!EMISORES.includes(datos.iss)) throw new Error('El identificador no proviene de Google.');
  if (datos.aud !== CLIENT_ID) throw new Error('El identificador es de otra aplicación.');
  if (!datos.exp || datos.exp * 1000 < Date.now()) throw new Error('El identificador ya venció.');
  if (datos.email_verified === false) throw new Error('Ese correo no está verificado en Google.');
  if (DOMINIO && String(datos.hd || '').toLowerCase() !== DOMINIO) {
    throw new Error(`Solo se permiten cuentas de ${DOMINIO}.`);
  }
  return datos;
}

/** Paso 2: Google regresa con el código; se canjea y se abre la sesión. */
export async function regresar(req, url, res) {
  const sobre = abrir(leerCookies(req).bitacora_oauth);
  ponerCookie(res, 'bitacora_oauth', '', { segundos: 0, seguro: baseUrl(req).startsWith('https') });

  if (url.searchParams.get('error')) throw new Error('Se canceló el inicio de sesión.');
  if (!sobre) throw new Error('La solicitud expiró. Inténtalo de nuevo.');
  if (url.searchParams.get('state') !== sobre.estado) throw new Error('La solicitud no coincide.');

  const codigo = url.searchParams.get('code');
  if (!codigo) throw new Error('Google no devolvió el código de acceso.');

  const respuesta = await fetch(TOKEN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code: codigo,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      redirect_uri: redirectUri(req),
      grant_type: 'authorization_code',
      code_verifier: sobre.verificador
    })
  });
  const cuerpo = await respuesta.json().catch(() => ({}));
  if (!respuesta.ok) {
    throw new Error(`Google rechazó el intercambio (${cuerpo.error || respuesta.status}).`);
  }

  const datos = afirmaciones(cuerpo.id_token);
  const correo = String(datos.email || '').toLowerCase();
  if (!correo) throw new Error('La cuenta de Google no expuso un correo.');

  const persona = autorizar(correo, datos.name || correo, datos.picture || '');
  ponerCookie(res, 'bitacora_sesion', firmar({ correo, exp: Date.now() + HORAS_SESION * 3600_000 }), {
    segundos: HORAS_SESION * 3600, seguro: baseUrl(req).startsWith('https')
  });
  return persona;
}

/** Comprueba que el correo esté dado de alta; la primera cuenta arranca como Supervisor. */
function autorizar(correo, nombre, foto) {
  let persona = db.prepare('SELECT * FROM usuarios WHERE lower(email) = ?').get(correo);

  if (!persona) {
    const hayAlguien = db.prepare('SELECT COUNT(*) AS n FROM usuarios').get().n > 0;
    if (hayAlguien) {
      throw new Error(`${correo} no está dado de alta en PROYECTAI. Pide a un supervisor que te agregue.`);
    }
    // primer acceso del sistema: quien entra queda como supervisor
    db.prepare('INSERT INTO usuarios (nombre, email, rol, creado_en) VALUES (?,?,?,?)')
      .run(nombre, correo, 'Supervisor', new Date().toISOString());
    persona = db.prepare('SELECT * FROM usuarios WHERE lower(email) = ?').get(correo);
  }

  if (!persona.activo) throw new Error(`El acceso de ${correo} está dado de baja.`);

  db.prepare('UPDATE usuarios SET nombre = ?, foto = ?, ultimo_acceso = ? WHERE id = ?')
    .run(nombre || persona.nombre, foto, new Date().toISOString(), persona.id);
  return db.prepare('SELECT * FROM usuarios WHERE id = ?').get(persona.id);
}

/** Persona de la petición actual, o null si no hay sesión válida. */
export function sesionDe(req) {
  const sobre = abrir(leerCookies(req).bitacora_sesion);
  if (!sobre?.correo) return null;
  const persona = db.prepare('SELECT * FROM usuarios WHERE lower(email) = ?').get(sobre.correo);
  return persona && persona.activo ? persona : null;
}

export function salir(req, res) {
  ponerCookie(res, 'bitacora_sesion', '', { segundos: 0, seguro: baseUrl(req).startsWith('https') });
}
