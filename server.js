// Servidor de Gastos familiares.
// Sirve la app (carpeta public/) y la API en /api. No necesita instalar
// paquetes: solo Node.js 20 o más reciente.
//
// Iniciar:  node server.js        (o doble clic en iniciar.bat en Windows)
// Puerto:   8080 por defecto; se cambia con la variable PORT.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as store from './lib/store.js';
import * as auth from './lib/auth.js';
import { readConfig, firebaseReady, CONFIG_FILE } from './lib/config.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, 'public');
const PORT = Number(process.env.PORT) || 8080;
const HOST = process.env.HOST || '0.0.0.0';
const COOKIE = 'sesion';
const FIRESTORE_URL = process.env.FIRESTORE_URL || 'https://firestore.googleapis.com/v1';
const MODO_PRUEBA = process.env.GASTOS_MODO_PRUEBA === '1';

store.load();
cleanSessions();
store.backup();
setInterval(() => { try { store.backup(); cleanSessions(); } catch (e) { console.error('Respaldo falló:', e); } }, 6 * 60 * 60 * 1000);

// ── Utilidades ─────────────────────────────────────────────────────────

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const fail = (status, message) => { throw new HttpError(status, message); };

function send(res, status, body, headers = {}) {
  const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': typeof body === 'object' && !Buffer.isBuffer(body) ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  res.end(data);
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 1_000_000) fail(413, 'Datos demasiado grandes.');
    chunks.push(c);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { fail(400, 'Formato inválido.'); }
}

function cleanSessions() {
  const now = Date.now();
  const s = store.get();
  const before = s.sessions.length;
  s.sessions = s.sessions.filter((x) => x.expiresAt > now);
  if (s.sessions.length !== before) store.save();
}

function currentUser(req) {
  const token = auth.parseCookies(req.headers.cookie)[COOKIE];
  if (!token) return null;
  const h = auth.tokenHash(token);
  const s = store.get();
  const session = s.sessions.find((x) => x.tokenHash === h && x.expiresAt > Date.now());
  // Si quitan un correo de config.json, esa persona pierde el acceso al instante.
  return session ? readConfig().usuarios.find((u) => u.id === session.userId) || null : null;
}

function startSession(res, user, req) {
  const token = auth.newToken();
  const maxAge = auth.SESSION_DAYS * 24 * 60 * 60;
  store.mutate((s) => {
    s.sessions.push({ tokenHash: auth.tokenHash(token), userId: user.id, createdAt: Date.now(), expiresAt: Date.now() + maxAge * 1000 });
  });
  const secure = req.headers['x-forwarded-proto'] === 'https' || req.socket.encrypted ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${secure}`);
}

const publicUser = (u) => ({ id: u.id, displayName: u.displayName });

const isPeriodKey = (k) => typeof k === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(k);
const isDate = (d) => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d) && !isNaN(new Date(d + 'T12:00:00'));
const money = (n) => Math.round(Number(n) * 100) / 100;

function cleanText(t, field, max = 120) {
  if (typeof t !== 'string' || !t.trim()) fail(400, `Falta ${field}.`);
  const v = t.trim();
  if (v.length > max) fail(400, `${field} es demasiado largo (máximo ${max} caracteres).`);
  return v;
}

function positiveAmount(n, field) {
  const v = money(n);
  if (!Number.isFinite(v) || v <= 0) fail(400, `${field} debe ser mayor a cero.`);
  return v;
}

function threshold(n) {
  const v = Math.round(Number(n ?? 80));
  if (!Number.isFinite(v) || v < 1 || v > 100) fail(400, 'La alerta debe estar entre 1 y 100 %.');
  return v;
}

// Categoría de donde se descuenta el gasto, si es distinta de la suya.
// Ej.: un gasto de Ocio que, por excepción, se descuenta de Gasolina.
function chargeCategory(s, b) {
  const v = b.chargeCatId;
  if (!v || v === b.catId) return null;
  if (!s.categories.some((c) => c.id === v)) fail(400, 'La categoría de donde se descuenta no existe.');
  return v;
}

// Suma meses a una fecha AAAA-MM-DD conservando el día (o el último día
// del mes si no existe, p. ej. 31 → 28). Como el corte es el 22, cada
// cuota cae en el período siguiente.
function addMonths(ds, k) {
  const [y, m, d] = ds.split('-').map(Number);
  const t = (m - 1) + k;
  const ny = y + Math.floor(t / 12), nm = ((t % 12) + 12) % 12;
  const dim = new Date(ny, nm + 1, 0).getDate();
  return `${ny}-${String(nm + 1).padStart(2, '0')}-${String(Math.min(d, dim)).padStart(2, '0')}`;
}

// Reparte un total en n cuotas iguales; la última ajusta los centavos.
function splitCuotas(total, n) {
  const per = Math.floor((total / n) * 100) / 100;
  return Array.from({ length: n }, (_, k) => (k < n - 1 ? per : money(total - per * (n - 1))));
}

function payload() {
  const s = store.get();
  return { categories: s.categories, expenses: s.expenses, users: readConfig().usuarios.map(publicUser) };
}

// Fija el límite de una categoría desde un período en adelante.
// Los períodos anteriores conservan el límite que tenían.
function setLimitFrom(cat, from, limit) {
  cat.limits = (cat.limits || []).filter((l) => l.from < from);
  cat.limits.push({ from, limit });
  cat.limits.sort((a, b) => a.from.localeCompare(b.from));
}

// ── Conversión desde Firebase (Firestore REST) ─────────────────────────

function fromFirestore(v) {
  if (v == null) return null;
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return Number(v.doubleValue);
  if ('booleanValue' in v) return v.booleanValue;
  if ('nullValue' in v) return null;
  if ('timestampValue' in v) return v.timestampValue;
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(fromFirestore);
  if ('mapValue' in v) {
    const o = {};
    for (const [k, val] of Object.entries(v.mapValue.fields || {})) o[k] = fromFirestore(val);
    return o;
  }
  return null;
}

async function fetchFirestoreList(project, docName) {
  const url = `${FIRESTORE_URL}/projects/${project}/databases/(default)/documents/gastos/${docName}`;
  const r = await fetch(url);
  if (r.status === 404) return [];
  if (!r.ok) fail(502, `Firebase respondió con error ${r.status} al leer "${docName}".`);
  const doc = await r.json();
  return fromFirestore(doc.fields?.list) || [];
}

async function importFromFirebase() {
  const cfg = readConfig();
  let cats, exps;
  try {
    [cats, exps] = await Promise.all([
      fetchFirestoreList(cfg.proyectoFirebaseAnterior, 'categories'),
      fetchFirestoreList(cfg.proyectoFirebaseAnterior, 'expenses'),
    ]);
  } catch (e) {
    if (e instanceof HttpError) throw e;
    fail(502, 'No se pudo conectar con Firebase. Revisa que la computadora tenga internet.');
  }
  return store.mutate((s) => {
    let nCats = 0, nExps = 0;
    for (const c of cats) {
      if (!c?.id || s.categories.some((x) => x.id === c.id)) continue;
      s.categories.push({
        id: c.id, name: String(c.name || 'Sin nombre'), threshold: Number(c.threshold) || 80,
        limits: [{ from: '2000-01', limit: money(c.limit) || 0 }], archivedFrom: null,
      });
      nCats++;
    }
    for (const e of exps) {
      if (!e?.id || s.expenses.some((x) => x.id === e.id)) continue;
      const owner = cfg.usuarios.find((u) => u.displayName.toLowerCase() === String(e.user || '').toLowerCase());
      s.expenses.push({
        id: e.id, desc: String(e.desc || ''), amount: money(e.amount) || 0, catId: e.catId, date: e.date,
        userId: owner ? owner.id : null, user: owner ? owner.displayName : String(e.user || '—'),
        ts: Number(e.ts) || Date.now(),
      });
      nExps++;
    }
    return { categorias: nCats, gastos: nExps, enFirebase: { categorias: cats.length, gastos: exps.length } };
  });
}

// ── Rutas de la API ────────────────────────────────────────────────────

async function api(req, res, url) {
  const method = req.method;
  const p = url.pathname;
  const s = store.get();

  if (method === 'GET' && p === '/api/estado') {
    const cfg = readConfig();
    const u = currentUser(req);
    const f = cfg.firebase || {};
    let problema = null;
    if (cfg.missing) problema = 'Falta crear el archivo de configuración en el servidor (paso 5 de la guía).';
    else if (cfg.invalid) problema = cfg.invalid;
    else if (!cfg.usuarios.length) problema = 'config.json no tiene correos autorizados (paso 5 de la guía).';
    else if (!firebaseReady(cfg) && !MODO_PRUEBA) problema = 'Falta completar los datos de Firebase en config.json (paso 5 de la guía).';
    return send(res, 200, {
      user: u ? publicUser(u) : null,
      problema,
      modoPrueba: MODO_PRUEBA && !firebaseReady(cfg),
      firebase: firebaseReady(cfg) ? { apiKey: f.apiKey, authDomain: f.authDomain, projectId: f.projectId, appId: f.appId } : null,
    });
  }

  if (method === 'POST' && p === '/api/entrar') {
    const body = await readBody(req);
    const cfg = readConfig();
    let email;
    if (firebaseReady(cfg)) {
      try { ({ email } = await auth.verifyFirebaseToken(body.idToken, cfg.firebase.projectId)); }
      catch (e) { console.warn('Inicio de sesión rechazado:', e.message); fail(401, 'No se pudo confirmar tu cuenta. Vuelve a intentarlo.'); }
    } else if (MODO_PRUEBA) {
      email = String(body.correo || '').trim().toLowerCase();
    } else {
      fail(503, 'Falta configurar Firebase en el servidor.');
    }
    const user = cfg.usuarios.find((u) => u.id === email);
    if (!user) fail(403, `La cuenta ${email} no tiene acceso a esta app. Pídele a quien administra el servidor que la agregue en config.json.`);
    startSession(res, user, req);
    return send(res, 200, { user: publicUser(user) });
  }

  if (method === 'POST' && p === '/api/salir') {
    const token = auth.parseCookies(req.headers.cookie)[COOKIE];
    if (token) {
      const h = auth.tokenHash(token);
      store.mutate((st) => { st.sessions = st.sessions.filter((x) => x.tokenHash !== h); });
    }
    return send(res, 200, { ok: true }, { 'Set-Cookie': `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0` });
  }

  // De aquí en adelante, todo requiere haber iniciado sesión.
  const me = currentUser(req);
  if (!me) fail(401, 'Tu sesión expiró. Vuelve a entrar.');

  if (method === 'GET' && p === '/api/datos') return send(res, 200, payload());

  // Gastos
  if (method === 'POST' && p === '/api/gastos') {
    const b = await readBody(req);
    // Un gasto guardado sin conexión puede llegar dos veces si la señal se
    // corta justo al subirlo; el identificador del celular evita duplicarlo.
    const clientId = typeof b.clientId === 'string' && /^[\w-]{8,64}$/.test(b.clientId) ? b.clientId : null;
    const dup = clientId && s.expenses.find((e) => e.clientId === clientId && e.userId === me.id);
    if (dup) return send(res, 200, { ...payload(), created: dup });
    const exp = {
      id: auth.newId(), desc: cleanText(b.desc, 'la descripción'), amount: positiveAmount(b.amount, 'El monto'),
      catId: b.catId, chargeCatId: chargeCategory(s, b), date: b.date, userId: me.id, user: me.displayName, ts: Date.now(),
      ...(clientId ? { clientId } : {}),
    };
    if (!s.categories.some((c) => c.id === exp.catId)) fail(400, 'La categoría no existe.');
    if (!isDate(exp.date)) fail(400, 'La fecha no es válida.');

    // Compra en cuotas: se crea una cuota por período, desde la fecha de compra.
    const n = b.cuotas == null || b.cuotas === '' ? 1 : Number(b.cuotas);
    if (!Number.isInteger(n) || n < 1 || n > 48) fail(400, 'El número de cuotas debe estar entre 2 y 48.');
    if (n === 1) {
      store.mutate((st) => { st.expenses.push(exp); });
      return send(res, 200, { ...payload(), created: exp });
    }
    const amounts = splitCuotas(exp.amount, n);
    if (amounts[0] <= 0) fail(400, 'El monto es muy bajo para tantas cuotas.');
    const planId = auth.newId();
    const list = amounts.map((amount, k) => ({
      ...exp, id: k === 0 ? exp.id : auth.newId(), amount, date: addMonths(exp.date, k), ts: exp.ts + k,
      planId, cuota: k + 1, cuotas: n, planTotal: exp.amount,
      ...(k === 0 && clientId ? { clientId } : { clientId: undefined }),
    }));
    for (const e of list) if (e.clientId === undefined) delete e.clientId;
    store.mutate((st) => { st.expenses.push(...list); });
    return send(res, 200, { ...payload(), created: list[0] });
  }

  let m = p.match(/^\/api\/gastos\/([\w-]+)$/);
  if (m && (method === 'PUT' || method === 'DELETE')) {
    const exp = s.expenses.find((e) => e.id === m[1]);
    if (!exp) fail(404, 'Ese gasto ya no existe. Recarga la página.');
    if (exp.userId !== me.id) fail(403, 'Solo quien registró el gasto puede cambiarlo.');
    if (method === 'DELETE') {
      // En una compra en cuotas se borran todas sus cuotas.
      store.mutate((st) => {
        st.expenses = st.expenses.filter((e) => (exp.planId ? e.planId !== exp.planId : e.id !== exp.id));
      });
      return send(res, 200, payload());
    }
    const b = await readBody(req);
    const changes = {
      desc: cleanText(b.desc, 'la descripción'), amount: positiveAmount(b.amount, 'El monto'),
      catId: b.catId, chargeCatId: chargeCategory(s, b), date: b.date, editedAt: Date.now(),
    };
    if (!s.categories.some((c) => c.id === changes.catId)) fail(400, 'La categoría no existe.');
    if (!isDate(changes.date)) fail(400, 'La fecha no es válida.');
    store.mutate((st) => {
      Object.assign(exp, changes);
      // En cuotas: descripción y categorías cambian en todas; monto y fecha, solo en esta.
      if (exp.planId) {
        for (const e of st.expenses) {
          if (e.planId === exp.planId && e !== exp) Object.assign(e, { desc: changes.desc, catId: changes.catId, chargeCatId: changes.chargeCatId });
        }
      }
    });
    return send(res, 200, payload());
  }

  // Categorías
  if (method === 'POST' && p === '/api/categorias') {
    const b = await readBody(req);
    if (!isPeriodKey(b.from)) fail(400, 'Período no válido.');
    const name = cleanText(b.name, 'el nombre', 40);
    if (s.categories.some((c) => !c.archivedFrom && c.name.toLowerCase() === name.toLowerCase())) fail(400, 'Ya existe una categoría con ese nombre.');
    const cat = { id: auth.newId(), name, threshold: threshold(b.threshold), limits: [{ from: b.from, limit: positiveAmount(b.limit, 'El límite') }], archivedFrom: null };
    store.mutate((st) => { st.categories.push(cat); });
    return send(res, 200, payload());
  }

  m = p.match(/^\/api\/categorias\/([\w-]+)$/);
  if (m && (method === 'PUT' || method === 'DELETE')) {
    const cat = s.categories.find((c) => c.id === m[1]);
    if (!cat) fail(404, 'Esa categoría ya no existe. Recarga la página.');
    const b = await readBody(req);
    if (!isPeriodKey(b.from)) fail(400, 'Período no válido.');
    if (method === 'DELETE') {
      // Si nunca tuvo gastos se borra; si tuvo, se oculta desde este período
      // y los meses anteriores la siguen mostrando con sus gastos.
      const used = s.expenses.some((e) => e.catId === cat.id || e.chargeCatId === cat.id);
      store.mutate((st) => {
        if (used) cat.archivedFrom = b.from;
        else st.categories = st.categories.filter((c) => c.id !== cat.id);
      });
      return send(res, 200, payload());
    }
    const name = cleanText(b.name, 'el nombre', 40);
    const limit = positiveAmount(b.limit, 'El límite');
    const thr = threshold(b.threshold);
    store.mutate(() => {
      cat.name = name;
      cat.threshold = thr;
      setLimitFrom(cat, b.from, limit);
    });
    return send(res, 200, payload());
  }

  // Respaldo descargable
  if (method === 'GET' && p === '/api/respaldo') {
    const d = new Date().toISOString().slice(0, 10);
    return send(res, 200, JSON.stringify(store.exportable(), null, 2), {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="respaldo-gastos-${d}.json"`,
    });
  }

  // Traer los datos de la versión anterior (Firebase). No duplica nada.
  if (method === 'POST' && p === '/api/importar-firebase') {
    const result = await importFromFirebase();
    return send(res, 200, { ...payload(), resultado: result });
  }

  fail(404, 'Ruta no encontrada.');
}

// ── Archivos de la app ─────────────────────────────────────────────────

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};

function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/') rel = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    return send(res, 404, 'No encontrado');
  }
  const ext = path.extname(file).toLowerCase();
  res.writeHead(200, {
    'Content-Type': TYPES[ext] || 'application/octet-stream',
    'Cache-Control': ext === '.png' ? 'public, max-age=86400' : 'no-cache',
    'X-Content-Type-Options': 'nosniff',
  });
  fs.createReadStream(file).pipe(res);
}

// ── Servidor ───────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname.startsWith('/api/')) await api(req, res, url);
    else if (req.method === 'GET' || req.method === 'HEAD') serveStatic(req, res, url);
    else send(res, 405, 'Método no permitido');
  } catch (e) {
    if (e instanceof HttpError) send(res, e.status, { error: e.message });
    else { console.error(e); send(res, 500, { error: 'Error interno del servidor.' }); }
  }
});

server.listen(PORT, HOST, () => {
  console.log(`\n  Gastos familiares está funcionando.`);
  console.log(`  En esta computadora:  http://localhost:${PORT}`);
  console.log(`  Datos en:             ${store.DATA_FILE}`);
  console.log(`  Configuración:        ${CONFIG_FILE}`);
  if (MODO_PRUEBA) console.log('  ATENCIÓN: modo de prueba activo (GASTOS_MODO_PRUEBA=1). No lo usen con datos reales.');
  console.log(`  Respaldos en:         ${store.BACKUP_DIR}\n`);
  console.log('  No cierres esta ventana mientras quieran usar la app.\n');
});
