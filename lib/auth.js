// Inicio de sesión con las cuentas de Firebase (correo y contraseña),
// igual que en Ikasgela. El navegador entra con Firebase y le pasa al
// servidor un comprobante firmado por Google (ID token). El servidor
// revisa la firma, revisa que el correo esté autorizado en config.json
// y abre una sesión que dura un año en ese dispositivo.

import crypto from 'node:crypto';

export const SESSION_DAYS = 365;

const CERTS_URL = process.env.FIREBASE_CERTS_URL
  || 'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com';

let certCache = { keys: null, expires: 0 };

async function googleCerts() {
  if (certCache.keys && Date.now() < certCache.expires) return certCache.keys;
  const r = await fetch(CERTS_URL);
  if (!r.ok) throw new Error(`No se pudieron leer las llaves de Google (${r.status}).`);
  const keys = await r.json();
  const maxAge = Number((r.headers.get('cache-control') || '').match(/max-age=(\d+)/)?.[1] || 3600);
  certCache = { keys, expires: Date.now() + maxAge * 1000 };
  return keys;
}

const b64json = (s) => JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));

// Devuelve { email, uid } si el comprobante es válido; si no, lanza un error.
export async function verifyFirebaseToken(idToken, projectId) {
  const parts = String(idToken || '').split('.');
  if (parts.length !== 3) throw new Error('Comprobante con formato inválido.');
  const [h, p, sig] = parts;
  const header = b64json(h);
  const claims = b64json(p);
  if (header.alg !== 'RS256') throw new Error('Algoritmo no permitido.');
  let keys = await googleCerts();
  if (!keys[header.kid]) { certCache.expires = 0; keys = await googleCerts(); }
  const pem = keys[header.kid];
  if (!pem) throw new Error('Llave desconocida.');
  const ok = crypto.verify('RSA-SHA256', Buffer.from(`${h}.${p}`), crypto.createPublicKey(pem), Buffer.from(sig, 'base64url'));
  if (!ok) throw new Error('Firma inválida.');
  const now = Math.floor(Date.now() / 1000);
  if (claims.aud !== projectId) throw new Error('El comprobante es de otro proyecto de Firebase.');
  if (claims.iss !== `https://securetoken.google.com/${projectId}`) throw new Error('Emisor inválido.');
  if (!(claims.exp > now)) throw new Error('El comprobante venció.');
  if (!(claims.iat <= now + 300)) throw new Error('Fecha del comprobante inválida.');
  if (!claims.sub || !claims.email) throw new Error('El comprobante no trae correo.');
  return { email: String(claims.email).toLowerCase(), uid: claims.sub };
}

export function newToken() {
  return crypto.randomBytes(32).toString('hex');
}

export function tokenHash(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function newId() {
  return Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
}

export function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
