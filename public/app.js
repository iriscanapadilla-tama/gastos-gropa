// Gastos familiares — lógica de la app en el navegador.
// Los datos viven en el servidor de la casa (API en /api). Firebase solo
// se usa para confirmar el correo y la contraseña al iniciar sesión.

const CUT_DAY = 22; // El período va del 22 de un mes al 21 del siguiente.
const FIREBASE_SDK = 'https://www.gstatic.com/firebasejs/10.12.0';
const MF = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
const MS = ['ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic'];

let me = null;
let users = [];
let categories = [];
let expenses = [];        // los del servidor + los pendientes de este celular
let serverExpenses = [];
const LS_COPIA = 'gastos.copia';
const LS_PENDIENTES = 'gastos.pendientes';
const OFFLINE_MSG = 'Sin conexión: los gastos nuevos se guardan en el celular';
let pending = [];
let periodOffset = 0;
let editingExpId = null;
let editingCatId = null;
let estado = null;

const $ = (id) => document.getElementById(id);

// ── Utilidades ─────────────────────────────────────────────────────────

function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function fmt(n) { return 'Q' + Number(n).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
function fmtShort(n) { return n >= 10000 ? 'Q' + (n / 1000).toFixed(1).replace('.0', '') + 'k' : 'Q' + Math.round(n).toLocaleString('en-US'); }
const pad = (n) => String(n).padStart(2, '0');
function todayLocal() { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function fmtDate(ds) { const [y, m, d] = ds.split('-').map(Number); return `${d} ${MS[m - 1]} ${y}`; }
function norm(s) { return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, ''); }

async function api(path, { method = 'GET', body } = {}) {
  let r;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);
  try {
    r = await fetch(path, {
      method, credentials: 'same-origin', signal: ctrl.signal,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    const err = new Error('No hay conexión con el servidor. Revisa que Tailscale esté activo.');
    err.offline = true;
    throw err;
  } finally { clearTimeout(timer); }
  let data = {};
  try { data = await r.json(); } catch {}
  if (r.status === 401 && path !== '/api/entrar') { me = null; showLogin(); }
  if (!r.ok) { const err = new Error(data.error || `Error ${r.status}`); err.status = r.status; throw err; }
  return data;
}

// ── Sin conexión ───────────────────────────────────────────────────────
// La última copia de los datos y los gastos pendientes se guardan en este
// celular. Los pendientes se suben solos cuando vuelve la conexión.

function lsGet(key, fallback) {
  try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch { return fallback; }
}
function lsSet(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
}
function newClientId() {
  try { return crypto.randomUUID(); } catch { return Date.now().toString(36) + Math.random().toString(36).slice(2, 10); }
}
const myPending = () => (me ? pending.filter((p) => p.userId === me.id) : []);
function savePending() { lsSet(LS_PENDIENTES, pending); }
function mergePending() {
  const rows = [];
  for (const p of myPending()) {
    const base = { ...p.body, clientId: p.clientId, userId: me.id, user: me.displayName, ts: p.createdAt, pending: true, error: p.error || null };
    const n = Number(p.body.cuotas) || 1;
    if (n === 1) { rows.push({ ...base, id: 'pendiente-' + p.clientId }); continue; }
    splitCuotas(p.body.amount, n).forEach((amount, k) => rows.push({
      ...base, id: `pendiente-${p.clientId}-${k}`, amount, date: cuotaDate(p.body.date, k),
      planId: 'pendiente-' + p.clientId, cuota: k + 1, cuotas: n, planTotal: p.body.amount,
    }));
  }
  expenses = serverExpenses.concat(rows);
}
function pendingNote() {
  const n = myPending().length;
  return n ? ` · ${n} ${n === 1 ? 'pendiente' : 'pendientes'} de subir` : '';
}

let syncing = false;
async function syncPending() {
  if (syncing || !me) return;
  const queue = myPending().filter((p) => !p.error);
  if (!queue.length) return;
  syncing = true;
  let uploaded = 0;
  try {
    for (const p of queue) {
      try {
        const d = await api('/api/gastos', { method: 'POST', body: { ...p.body, clientId: p.clientId } });
        pending = pending.filter((x) => x.clientId !== p.clientId);
        savePending();
        applyData(d);
        uploaded++;
      } catch (e) {
        if (e.offline || e.status === 401) break;
        p.error = e.message;
        savePending(); mergePending(); renderAll();
      }
    }
  } finally { syncing = false; }
  if (uploaded) { setSyncStatus('ok'); toast(`Se ${uploaded === 1 ? 'subió 1 gasto pendiente' : `subieron ${uploaded} gastos pendientes`}`); }
}

function removePending(clientId) {
  const p = pending.find((x) => x.clientId === clientId); if (!p) return;
  const what = Number(p.body.cuotas) > 1 ? `la compra en ${p.body.cuotas} cuotas "${p.body.desc}" (total ${fmt(p.body.amount)})` : `"${p.body.desc}" por ${fmt(p.body.amount)}`;
  if (!confirm(`¿Quitar ${what}? Todavía no se subió al servidor.`)) return;
  pending = pending.filter((x) => x.clientId !== clientId);
  savePending(); mergePending(); renderAll();
}

function setSyncStatus(state, detail) {
  const c = { ok: 'sync-ok', loading: 'sync-loading', error: 'sync-error' };
  const l = { ok: 'Sincronizado' + pendingNote(), loading: 'Sincronizando...', error: (detail === OFFLINE_MSG ? 'Sin conexión' : detail || 'Sin conexión con el servidor') + pendingNote() };
  $('sync-status').innerHTML = `<span class="sync-dot ${c[state]}"></span>${esc(l[state])}`;
  if (state === 'ok') { lastSyncAt = Date.now(); syncFailed = false; }
  if (state === 'error') syncFailed = true;
  if (state === 'ok') showOfflineBanner(false);
  if (state === 'error' && detail === OFFLINE_MSG) showOfflineBanner(true);
  if (me) renderSyncCard();
}

// Franja que avisa que se está viendo la última copia guardada en el celular.
function showOfflineBanner(on) {
  const b = $('offline-banner');
  if (!on) { b.classList.add('hidden'); return; }
  const copia = lsGet(LS_COPIA, null);
  let when = '';
  if (copia?.savedAt) {
    const d = new Date(copia.savedAt);
    when = ` del ${d.getDate()} ${MS[d.getMonth()]}, ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  b.innerHTML = `<b>Sin conexión.</b> Estás viendo la última copia guardada${esc(when)}; puede no estar al día. Los gastos nuevos se guardan en este celular y se suben solos al volver la conexión.`;
  b.classList.remove('hidden');
}

function applyData(d) {
  if (d && d.categories) {
    categories = d.categories; serverExpenses = d.expenses; users = d.users || [];
    if (me) lsSet(LS_COPIA, { user: me, data: { categories, expenses: serverExpenses, users }, savedAt: Date.now() });
  }
  if (me) mergePending();
  renderAll();
}

async function loadData() {
  setSyncStatus('loading');
  try { applyData(await api('/api/datos')); setSyncStatus('ok'); syncPending(); }
  catch (e) { setSyncStatus('error', e.offline ? OFFLINE_MSG : e.message); }
}

async function mutate(path, opts) {
  setSyncStatus('loading');
  try {
    const d = await api(path, opts);
    applyData(d);
    setSyncStatus('ok');
    return d;
  } catch (e) {
    setSyncStatus('error', e.offline ? OFFLINE_MSG : e.message);
    alert(e.offline ? 'No hay conexión. Para editar, borrar o cambiar categorías necesitas estar conectado. Los gastos nuevos sí se guardan en el celular.' : e.message);
    throw e;
  }
}

// ── Períodos ───────────────────────────────────────────────────────────

function periodFromStart(sy, sm) {
  while (sm > 11) { sm -= 12; sy++; }
  while (sm < 0) { sm += 12; sy--; }
  let em = sm + 1, ey = sy;
  if (em > 11) { em = 0; ey++; }
  return { startYear: sy, startMonth: sm, endYear: ey, endMonth: em, key: `${sy}-${pad(sm + 1)}` };
}
function periodOfDate(ds) {
  const [y, m, d] = ds.split('-').map(Number);
  return periodFromStart(y, (m - 1) - (d < CUT_DAY ? 1 : 0));
}
// Mismo cálculo que el servidor para las compras en cuotas: la primera cuota
// cae el día de la compra; las siguientes, el 22 de cada corte.
function cuotaDate(first, k) {
  if (k === 0) return first;
  const [y, m, d] = first.split('-').map(Number);
  const t = (m - 1) - (d < CUT_DAY ? 1 : 0) + k;
  const ny = y + Math.floor(t / 12), nm = ((t % 12) + 12) % 12;
  return `${ny}-${pad(nm + 1)}-${pad(CUT_DAY)}`;
}
function splitCuotas(total, n) {
  const per = Math.floor((total / n) * 100) / 100;
  return Array.from({ length: n }, (_, k) => (k < n - 1 ? per : Math.round((total - per * (n - 1)) * 100) / 100));
}

function getPeriod(offset) {
  const base = periodOfDate(todayLocal());
  return periodFromStart(base.startYear, base.startMonth + offset);
}
const periodLabel = (p) => `${MF[p.startMonth]} ${p.startYear}`;
const periodDates = (p) => `${CUT_DAY} ${MS[p.startMonth]} ${p.startYear} → ${CUT_DAY - 1} ${MS[p.endMonth]} ${p.endYear}`;
const expensesIn = (p) => expenses.filter((e) => periodOfDate(e.date).key === p.key);

// Límite que tenía la categoría en ese período.
function limitFor(cat, key) {
  let lim = null;
  for (const l of cat.limits || []) if (l.from <= key) lim = l.limit;
  if (lim === null && cat.limits?.length) lim = cat.limits[0].limit;
  return lim || 0;
}
function catsFor(p, exps = expensesIn(p)) {
  return categories.filter((c) => {
    const started = (c.limits || []).some((l) => l.from <= p.key);
    const active = started && (!c.archivedFrom || p.key < c.archivedFrom);
    return active || exps.some((e) => e.catId === c.id || e.chargeCatId === c.id);
  });
}
const activeCats = () => categories.filter((c) => !c.archivedFrom);
// Categoría de la que se descuenta el gasto (normalmente la suya).
const chargeOf = (e) => e.chargeCatId || e.catId;
// Lo que se descuenta del presupuesto de una categoría.
const spentIn = (exps, catId) => exps.filter((e) => chargeOf(e) === catId).reduce((s, e) => s + e.amount, 0);
// Lo que realmente se gastó en ese tipo de gasto (para estadísticas).
const spentReal = (exps, catId) => exps.filter((e) => e.catId === catId).reduce((s, e) => s + e.amount, 0);
const userName = (e) => users.find((u) => u.id === e.userId)?.displayName || e.user || '—';
const catName = (id) => categories.find((c) => c.id === id)?.name || '—';
function catLabel(e) {
  return e.chargeCatId ? `${esc(catName(e.catId))} <span class="charge-tag">de ${esc(catName(e.chargeCatId))}</span>` : esc(catName(e.catId));
}

function changePeriod(dir) { periodOffset += dir; renderAll(); }

// ── Íconos (SVG en línea) ──────────────────────────────────────────────

const ICONS = {
  iris: '<path d="M12 3c-2 3-2 6 0 8 2-2 2-5 0-8z"/><path d="M12 11c-3-1-6 0-7 3 3 1 5 0 7-3z"/><path d="M12 11c3-1 6 0 7 3-3 1-5 0-7-3z"/><path d="M12 11v10"/><path d="M12 17c2-1 4-1 5-3"/>',
  escarabajo: '<ellipse cx="12" cy="14" rx="5" ry="6"/><circle cx="12" cy="6.5" r="2"/><path d="M12 9v11M7 12l-3-1M7 15H4M7 18l-3 1M17 12l3-1M17 15h3M17 18l3 1M11 5L9 3M13 5l2-2"/>',
  huella: '<circle cx="8" cy="6.5" r="1.7"/><circle cx="16" cy="6.5" r="1.7"/><circle cx="4.8" cy="11.5" r="1.7"/><circle cx="19.2" cy="11.5" r="1.7"/><path d="M12 11.5c-3 0-5 3-5 5.2 0 1.8 2 2.6 5 1.8 3 .8 5 0 5-1.8 0-2.2-2-5.2-5-5.2z"/>',
  gota: '<path d="M12 3c3 4 6 7 6 11a6 6 0 0 1-12 0c0-4 3-7 6-11z"/>',
  canasta: '<path d="M3 10h18l-2 9H5z"/><path d="M8 10l3-6M16 10l-3-6"/>',
  inicio: '<path d="M4 11l8-7 8 7v9a1 1 0 0 1-1 1h-5v-6h-4v6H5a1 1 0 0 1-1-1z"/>',
  movimientos: '<path d="M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01"/>',
  estadisticas: '<path d="M5 20V11M11 20V5M17 20v-7M3 20h18"/>',
  mas: '<circle cx="5" cy="12" r="1.2" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.2" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1.2" fill="currentColor" stroke="none"/>',
  agregar: '<path d="M12 5v14M5 12h14"/>',
  chevron_izq: '<path d="M15 6l-6 6 6 6"/>',
  chevron_der: '<path d="M9 6l6 6-6 6"/>',
  buscar: '<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/>',
  calendario: '<rect x="3.5" y="5" width="17" height="15" rx="2.5"/><path d="M3.5 10h17M8 3v4M16 3v4"/>',
  exportar: '<path d="M12 4v11M7.5 10.5L12 15l4.5-4.5M5 19h14"/>',
  importar: '<path d="M12 15V4M7.5 8.5L12 4l4.5 4.5M5 19h14"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  salir: '<path d="M14 4h4a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-4M10 16l-4-4 4-4M6 12h10"/>',
};

function svg(name, size = 24, sw = 1.7) {
  return `<svg class="ic" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${ICONS[name] || ''}</svg>`;
}
// Pone el ícono en cada elemento con data-icon="nombre".
function hydrateIcons(root = document) {
  root.querySelectorAll('[data-icon]:not([data-done])').forEach((el) => {
    el.innerHTML = svg(el.dataset.icon, Number(el.dataset.size) || 24, Number(el.dataset.sw) || 1.7);
    el.dataset.done = '1';
  });
}

// ── Colores e íconos por categoría ─────────────────────────────────────
// Cada categoría conserva su color en todas las pantallas. Las que no están
// en esta lista toman el siguiente color de NEW_CAT_PALETTE, en orden de creación.

const CAT_THEMES = {
  ocio: { icono: 'iris', color: '#6E5BA8', hero: '#9C8BD6', tint: '#ECE8F5', ink: '#5B4B8A' },
  perro: { icono: 'huella', color: '#C46B7E', hero: '#E39AAB', tint: '#F6E6EA', ink: '#A44A62' },
  combustible: { icono: 'gota', color: '#2F6B5E', hero: '#6FB8A4', tint: '#E3EFEA', ink: '#2F6B5E' },
  super: { icono: 'canasta', color: '#D9A033', hero: '#F0C35A', tint: '#F7EDD6', ink: '#8A5A00' },
};
const NEW_CAT_PALETTE = [
  { color: '#4E7FA8', hero: '#8DB6D9', tint: '#E2ECF5', ink: '#355F82' },
  { color: '#8A6E3B', hero: '#C9AE7A', tint: '#F1EADC', ink: '#6B5228' },
  { color: '#A0577E', hero: '#D395B7', tint: '#F4E4EE', ink: '#7E3E60' },
];
function themeKey(cat) {
  const n = norm(cat.name);
  if (n.includes('ocio')) return 'ocio';
  if (n.includes('perr') || n.includes('mascot')) return 'perro';
  if (n.includes('combust') || n.includes('gasolin')) return 'combustible';
  if (n.includes('super') || n.includes('almuerz')) return 'super';
  return null;
}
function catTheme(cat) {
  if (!cat) return { ...NEW_CAT_PALETTE[0], icono: null };
  const k = themeKey(cat);
  if (k) return CAT_THEMES[k];
  const others = categories.filter((c) => !themeKey(c));
  const i = Math.max(0, others.indexOf(cat));
  return { ...NEW_CAT_PALETTE[i % NEW_CAT_PALETTE.length], icono: null };
}
const catById = (id) => categories.find((c) => c.id === id);
function catIcon(cat, cls = '') {
  const t = catTheme(cat);
  const inner = t.icono ? svg(t.icono, cls === 'xs' ? 18 : 22) : esc((cat?.name || '?').trim()[0]?.toUpperCase() || '?');
  return `<span class="cat-icon ${cls}" style="background:${t.tint};color:${t.ink}" aria-hidden="true">${inner}</span>`;
}
// Estado de una categoría: se comunica con la etiqueta y el color del saldo, no con la barra.
function catState(spent, lim, thr) {
  if (lim <= 0) return spent > 0 ? 'over' : 'normal';
  const pct = (spent / lim) * 100;
  if (pct >= 100) return 'over';
  if (pct >= (thr || 80)) return 'care';
  return 'normal';
}

// ── Ayudas de presentación ─────────────────────────────────────────────

const DIAS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
function fmtK(n) { return Math.abs(n) >= 1000 ? `Q${(n / 1000).toFixed(1).replace('.0', '')}k` : `Q${Math.round(n)}`; }
function fmtKpi(n) { return Math.abs(n) >= 100000 ? fmtK(n) : 'Q' + Math.round(n).toLocaleString('en-US'); }
function ymd(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function periodStart(p) { return new Date(p.startYear, p.startMonth, CUT_DAY); }
function periodEnd(p) { return new Date(p.endYear, p.endMonth, CUT_DAY - 1); }
function periodDays(p) { return Math.round((periodEnd(p) - periodStart(p)) / 864e5) + 1; }
// Día del período en que estamos hoy (0 si el período no ha empezado; el total si ya cerró).
function dayOfPeriod(p) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const s = periodStart(p), e = periodEnd(p);
  if (today < s) return 0;
  if (today > e) return periodDays(p);
  return Math.round((today - s) / 864e5) + 1;
}
const isCurrentPeriod = (p) => p.key === getPeriod(0).key;
const periodRange = (p) => `${CUT_DAY} ${MS[p.startMonth]} – ${CUT_DAY - 1} ${MS[p.endMonth]}`;
const periodShort = (p) => `${cap(MS[p.startMonth])} ${p.startYear}`;
function ago(ts) {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return 'hace un momento';
  const m = Math.round(s / 60);
  if (m < 60) return `hace ${m} min`;
  const h = Math.round(m / 60);
  return `hace ${h} ${h === 1 ? 'hora' : 'horas'}`;
}

function toast(text, action) {
  const zone = $('toast-zone');
  zone.innerHTML = '';
  const t = document.createElement('div');
  t.className = 'toast';
  t.innerHTML = `<span>${esc(text)}</span>`;
  if (action) {
    const b = document.createElement('button');
    b.type = 'button'; b.textContent = action.label;
    b.addEventListener('click', () => { t.remove(); action.run(); });
    t.appendChild(b);
  }
  zone.appendChild(t);
  setTimeout(() => t.remove(), action ? 5000 : 3000);
}

// ── Navegación ─────────────────────────────────────────────────────────

let currentView = 'inicio';
let masSegment = 'categorias';
let filterCat = '';
let filterUser = '';
let filterAll = false;
let lastSyncAt = null;
let syncFailed = false;

function showView(name) {
  currentView = name;
  for (const v of ['inicio', 'movimientos', 'estadisticas', 'mas']) $('view-' + v).classList.toggle('hidden', v !== name);
  document.querySelectorAll('[data-nav]').forEach((b) => {
    const on = b.dataset.nav === name;
    b.classList.toggle('active', on);
    if (on) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
  });
  if (name === 'mas') showSegment(masSegment);
  window.scrollTo(0, 0);
  renderAll();
}
function showSegment(seg) {
  masSegment = seg;
  document.querySelectorAll('[data-seg]').forEach((b) => {
    const on = b.dataset.seg === seg;
    b.classList.toggle('active', on); b.setAttribute('aria-selected', String(on));
  });
  $('panel-categorias').classList.toggle('hidden', seg !== 'categorias');
  $('panel-datos').classList.toggle('hidden', seg !== 'datos');
}
function goMas(seg) { masSegment = seg; showView('mas'); }

// Hojas que suben desde abajo (registrar, editar, categoría).
let lastFocus = null;
function openSheet(id) {
  lastFocus = document.activeElement;
  const s = $(id);
  s.classList.add('open'); s.setAttribute('aria-hidden', 'false');
  document.body.style.overflow = 'hidden';
}
function closeOverlays() {
  document.querySelectorAll('.sheet-backdrop.open').forEach((s) => { s.classList.remove('open'); s.setAttribute('aria-hidden', 'true'); });
  document.body.style.overflow = '';
  if (lastFocus && document.contains(lastFocus)) lastFocus.focus({ preventScroll: true });
}
const sheetOpen = (id) => $(id).classList.contains('open');

// ── Pantallas ──────────────────────────────────────────────────────────

function renderAll() {
  if (!me) return;
  const p = getPeriod(periodOffset);
  const cur = isCurrentPeriod(p);
  $('period-label').textContent = periodLabel(p);
  $('period-dates').textContent = periodRange(p) + (cur ? ` · día ${dayOfPeriod(p)} de ${periodDays(p)}` : '');
  $('btn-hoy').classList.toggle('hidden', periodOffset === 0);
  document.querySelectorAll('[data-period-short]').forEach((el) => { el.textContent = periodShort(p) + (cur ? ` · día ${dayOfPeriod(p)}` : ''); });
  $('export-period-label').textContent = `Período de ${periodLabel(p)}`;
  renderInicio(p);
  renderMovimientos(p);
  renderStats(p);
  renderCatConfig(p);
  renderSyncCard();
  if (sheetOpen('register-sheet')) renderRegChips();
}

// Inicio
function renderInicio(p) {
  const exps = expensesIn(p);
  const cats = catsFor(p, exps);
  let budget = 0, spent = 0;
  const rows = cats.map((c) => {
    const lim = limitFor(c, p.key), sp = spentIn(exps, c.id);
    budget += lim; spent += sp;
    return { c, lim, sp };
  });

  // Tarjeta principal
  const avail = budget - spent;
  $('hero-avail').textContent = avail < 0 ? '−' + fmt(-avail) : fmt(avail);
  $('hero-avail').classList.toggle('negative', avail < 0);
  $('hero-spent').innerHTML = `Gastado <b>${fmt(spent)}</b> de ${fmt(budget)}`;
  let room = 100;
  $('hero-segs').innerHTML = rows.map(({ c, sp }) => {
    const w = budget > 0 ? Math.min(room, (sp / budget) * 100) : 0;
    room -= w;
    return w > 0 ? `<span style="width:${w.toFixed(2)}%;background:${catTheme(c).hero}"></span>` : '';
  }).join('');
  const pct = budget > 0 ? (spent / budget) * 100 : (spent > 0 ? 100 : 0);
  const days = periodDays(p), day = dayOfPeriod(p);
  const ideal = (day / days) * 100;
  $('hero-beetle').style.left = `calc(${Math.min(pct, 100).toFixed(2)}% - 11px)`; // centrado sobre el punto del gasto
  $('hero-pct').textContent = `${Math.round(pct)}% usado`;
  $('hero-ideal-txt').textContent = `ritmo ideal ${Math.round(ideal)}%`;
  const left = days - day + 1; // días que quedan, contando hoy
  const m1l = $('mini1-label'), m1v = $('mini1-value'), m2l = $('mini2-label'), m2v = $('mini2-value');
  m1v.classList.toggle('negative', avail < 0);
  if (avail < 0) {
    m1l.textContent = 'Excedido del total'; m1v.textContent = fmt(-avail);
  } else if (day === 0) {
    m1l.textContent = 'Para cerrar en presupuesto'; m1v.textContent = `${fmt(avail / days)}/día`;
  } else if (day >= days && !isCurrentPeriod(p)) {
    m1l.textContent = 'Sin gastar al cierre'; m1v.textContent = fmt(avail);
  } else {
    m1l.textContent = 'Para cerrar en presupuesto'; m1v.textContent = `${fmt(avail / Math.max(left, 1))}/día`;
  }
  if (day === 0) { m2l.textContent = 'Días del período'; m2v.textContent = String(days); }
  else if (day >= days && !isCurrentPeriod(p)) { m2l.textContent = 'Días restantes'; m2v.textContent = 'Cerrado'; }
  else { m2l.textContent = 'Días restantes'; m2v.textContent = String(left); }

  // Categorías
  $('no-cats').classList.toggle('hidden', cats.length > 0);
  $('cat-list').innerHTML = rows.map(({ c, lim, sp }) => {
    const t = catTheme(c);
    const st = catState(sp, lim, c.threshold);
    const rem = lim - sp;
    const tag = st === 'care' ? '<span class="tag tag-care">Cuidado</span>' : st === 'over' ? '<span class="tag tag-over">Excedido</span>' : '';
    const w = lim > 0 ? Math.min((sp / lim) * 100, 100) : (sp > 0 ? 100 : 0);
    const borrowed = exps.filter((e) => e.chargeCatId === c.id && e.catId !== c.id);
    const lent = exps.filter((e) => e.catId === c.id && e.chargeCatId && e.chargeCatId !== c.id);
    const notes = [];
    if (borrowed.length) notes.push(`Incluye ${fmt(borrowed.reduce((s, e) => s + e.amount, 0))} de otras categorías (${[...new Set(borrowed.map((e) => catName(e.catId)))].map(esc).join(', ')})`);
    if (lent.length) notes.push(`Además, ${fmt(lent.reduce((s, e) => s + e.amount, 0))} de ${esc(c.name)} se descontó de ${[...new Set(lent.map((e) => catName(e.chargeCatId)))].map(esc).join(', ')}`);
    return `<article class="cat-card">
      <div class="cat-top">
        ${catIcon(c)}
        <div class="cat-mid">
          <div class="cat-name-row"><span class="cat-name">${esc(c.name)}</span>${tag}</div>
          <div class="cat-sub">${fmt(sp)} de ${fmt(lim)}</div>
        </div>
        <div class="cat-right">
          <div class="cat-rem state-${st}">${rem < 0 ? '−' + fmt(-rem) : fmt(rem)}</div>
          <div class="cat-rem-label">${rem < 0 ? 'sobre' : 'quedan'}</div>
        </div>
      </div>
      <div class="progress" role="progressbar" aria-label="${esc(c.name)}: ${Math.round(lim > 0 ? (sp / lim) * 100 : 0)}% usado" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(w)}"><span style="width:${w.toFixed(2)}%;background:${t.color}"></span></div>
      ${notes.map((n) => `<div class="cat-note">${n}</div>`).join('')}
    </article>`;
  }).join('');

  renderPlans(p);

  // Período sin gastos
  const empty = cats.length > 0 && exps.length === 0;
  $('empty-period').classList.toggle('hidden', !empty);
  $('hero-watermark').classList.toggle('hidden', empty); // un solo motivo decorativo por pantalla
  if (empty) $('empty-text').textContent = `Tienes ${fmt(budget)} disponibles hasta el ${CUT_DAY - 1} de ${MF[p.endMonth].toLowerCase()}. Registra el primer gasto cuando ocurra.`;
}

// Compras en cuotas que tienen una cuota en este período. Cuando pasa la
// última cuota, la compra deja de aparecer.
function renderPlans(p) {
  const groups = new Map();
  for (const e of expenses) if (e.planId) (groups.get(e.planId) || groups.set(e.planId, []).get(e.planId)).push(e);
  const rows = [];
  for (const list of groups.values()) {
    list.sort((x, y) => x.cuota - y.cuota);
    const now = list.find((e) => periodOfDate(e.date).key === p.key);
    if (!now) continue;
    const after = list.filter((e) => periodOfDate(e.date).key > p.key);
    const left = after.reduce((s, e) => s + e.amount, 0);
    const last = list[list.length - 1];
    rows.push(`<div class="plan-row">
      ${catIcon(catById(chargeOf(now)), 'sm')}
      <div class="exp-mid">
        <div class="plan-name">${esc(now.desc)}${now.pending ? ' <span class="tag tag-pending">Pendiente de subir</span>' : ''}</div>
        <div class="plan-sub">Cuota ${now.cuota} de ${now.cuotas} · total ${fmt(now.planTotal || 0)}</div>
        <div class="plan-sub">${after.length ? `${after.length === 1 ? 'Falta 1 cuota' : `Faltan ${after.length} cuotas`} (${fmt(left)}) · termina en ${esc(periodLabel(periodOfDate(last.date)))}` : 'Es la última cuota'}</div>
      </div>
      <div class="plan-amount">${fmt(now.amount)}</div>
    </div>`);
  }
  $('plans-card').classList.toggle('hidden', rows.length === 0);
  $('plans-list').innerHTML = rows.join('');
}

// Movimientos
function renderMovimientos(p) {
  $('f-cats').innerHTML = [`<button class="chip-filter${!filterCat ? ' active' : ''}" type="button" data-fcat="" aria-pressed="${!filterCat}">Todas</button>`]
    .concat(categories.map((c) => `<button class="chip-filter${filterCat === c.id ? ' active' : ''}" type="button" data-fcat="${esc(c.id)}" aria-pressed="${filterCat === c.id}"><span class="chip-dot" style="background:${catTheme(c).color}"></span>${esc(c.name)}${c.archivedFrom ? ' (quitada)' : ''}</button>`))
    .join('');
  $('f-users').innerHTML = [`<button class="chip-filter${!filterUser ? ' active' : ''}" type="button" data-fuser="" aria-pressed="${!filterUser}">Todos</button>`]
    .concat(users.map((u) => `<button class="chip-filter${filterUser === u.id ? ' active' : ''}" type="button" data-fuser="${esc(u.id)}" aria-pressed="${filterUser === u.id}">${esc(u.displayName)}</button>`))
    .concat(`<button class="chip-filter${filterAll ? ' active' : ''}" type="button" data-fall aria-pressed="${filterAll}">Todos los períodos</button>`)
    .join('');

  const raw = $('f-text').value.trim();
  const q = norm(raw);
  const qNum = /^[\d.,\sQq]+$/.test(raw) ? raw.replace(/[Qq,\s]/g, '') : '';
  let exps = filterAll ? expenses.slice() : expensesIn(p);
  if (q) exps = exps.filter((e) => norm(e.desc).includes(q) || (qNum && (e.amount.toFixed(2).includes(qNum) || String(e.amount).includes(qNum))));
  if (filterCat) exps = exps.filter((e) => e.catId === filterCat || e.chargeCatId === filterCat);
  if (filterUser) exps = exps.filter((e) => e.userId === filterUser);
  exps.sort((a, b) => b.date.localeCompare(a.date) || (b.ts || 0) - (a.ts || 0));

  const total = exps.reduce((s, e) => s + e.amount, 0);
  const filtered = q || filterCat || filterUser;
  $('list-total').textContent = exps.length ? `${exps.length} ${exps.length === 1 ? 'gasto' : 'gastos'} · ${fmt(total)}${filterAll ? ' · todos los períodos' : ''}` : '';
  $('empty-gastos').classList.toggle('hidden', exps.length > 0);
  $('empty-gastos').innerHTML = `<p>${filtered ? 'No hay gastos que coincidan.' : 'Sin gastos en este período.'}</p>`;

  const shown = exps.slice(0, 300);
  const today = todayLocal();
  const yest = ymd(new Date(Date.now() - 864e5));
  const groups = [];
  for (const e of shown) {
    let g = groups[groups.length - 1];
    if (!g || g.date !== e.date) { g = { date: e.date, items: [] }; groups.push(g); }
    g.items.push(e);
  }
  $('expense-groups').innerHTML = groups.map((g) => {
    const [y, m, d] = g.date.split('-').map(Number);
    const label = g.date === today ? 'Hoy' : g.date === yest ? 'Ayer' : cap(DIAS[new Date(y, m - 1, d).getDay()]);
    const dayTotal = g.items.reduce((s, e) => s + e.amount, 0);
    return `<div class="day-group">
      <div class="day-head"><span class="overline">${label} · ${d} ${MS[m - 1]}${y !== new Date().getFullYear() ? ' ' + y : ''}</span><span class="day-total">${fmt(dayTotal)}</span></div>
      <div class="rows-card">${g.items.map(expenseRow).join('')}</div>
    </div>`;
  }).join('') + (exps.length > shown.length ? '<div class="more-note">Se muestran los 300 más recientes. Usa la búsqueda o los filtros para encontrar otros.</div>' : '');
}

function expenseRow(e) {
  const cat = catById(e.catId);
  const from = e.chargeCatId ? catById(e.chargeCatId) : null;
  const tags = [];
  if (e.cuotas) tags.push(`<span class="tag tag-cuota">Cuota ${e.cuota}/${e.cuotas}</span>`);
  if (e.pending) tags.push(e.error ? `<span class="tag tag-error">No se pudo subir: ${esc(e.error)}</span>` : '<span class="tag tag-pending">Pendiente de subir</span>');
  const meta = `${esc(catName(e.catId))}${from ? ` <span class="from-chip" style="background:${catTheme(from).tint}">desde ${esc(from.name)}</span>` : ''} · ${esc(userName(e))}${e.editedAt ? ' · editado' : ''}`;
  const inner = `${catIcon(cat, 'sm')}
    <div class="exp-mid">
      <div class="exp-desc">${esc(e.desc)}</div>
      <div class="exp-meta">${meta}${tags.length ? ' ' + tags.join(' ') : ''}</div>
    </div>
    <div class="exp-amount">${fmt(e.amount)}</div>`;
  if (e.pending) return `<button class="exp-row" type="button" data-del-pend="${esc(e.clientId)}" aria-label="${esc(e.desc)}, ${fmt(e.amount)}. Pendiente de subir: tocar para quitar">${inner}</button>`;
  if (e.userId === me.id) return `<button class="exp-row" type="button" data-edit-exp="${esc(e.id)}" aria-label="${esc(e.desc)}, ${fmt(e.amount)}. Tocar para editar o eliminar">${inner}</button>`;
  return `<div class="exp-row">${inner}</div>`;
}

// Estadísticas
function pctChange(now, before) {
  if (!before) return null;
  return Math.round(((now - before) / before) * 100);
}
function deltaHtml(d) {
  if (d === null) return '—';
  if (d === 0) return 'igual';
  return `<span class="${d > 0 ? 'delta-up' : 'delta-down'}">${d > 0 ? '▲' : '▼'} ${Math.abs(d)}%</span>`;
}

function renderStats(p) {
  const prev = periodFromStart(p.startYear, p.startMonth - 1);
  const exps = expensesIn(p);
  // Siempre se compara contra el período anterior completo.
  const prevExps = expensesIn(prev);
  const total = exps.reduce((s, e) => s + e.amount, 0);
  const prevTotal = prevExps.reduce((s, e) => s + e.amount, 0);
  const prevName = MF[prev.startMonth].toLowerCase();

  $('st-total').textContent = fmtKpi(total);
  const d = pctChange(total, prevTotal);
  $('st-total-note').innerHTML = d === null ? `sin datos de ${prevName}` : `${deltaHtml(d)} vs. ${prevName}`;
  $('st-count').textContent = exps.length;
  $('st-count-note').textContent = `${prevExps.length} en ${prevName}`;
  $('st-avg').textContent = fmtKpi(exps.length ? total / exps.length : 0);
  $('st-note').textContent = 'Comparado contra el período anterior completo.';

  // Dona: en qué se fue el dinero (por tipo real de gasto)
  const parts = categories.map((c) => ({ c, v: spentReal(exps, c.id) })).filter((x) => x.v > 0).sort((a, b) => b.v - a.v);
  if (!total) {
    $('st-donut').innerHTML = '<p class="hint">Sin gastos en este período.</p>';
  } else {
    const R = 42, C = 2 * Math.PI * R;
    let acc = 0;
    const arcs = parts.map(({ c, v }) => {
      const len = (v / total) * C;
      const s = `<circle cx="60" cy="60" r="${R}" fill="none" stroke="${catTheme(c).color}" stroke-width="12" stroke-dasharray="${len.toFixed(2)} ${(C - len).toFixed(2)}" stroke-dashoffset="${(-acc).toFixed(2)}" transform="rotate(-90 60 60)"/>`;
      acc += len;
      return s;
    }).join('');
    $('st-donut').innerHTML = `<div class="donut">
        <svg width="120" height="120" viewBox="0 0 120 120" role="img" aria-label="Distribución del gasto por categoría"><circle cx="60" cy="60" r="${R}" fill="none" stroke="var(--track)" stroke-width="12"/>${arcs}</svg>
        <div class="donut-center"><b>${fmtK(total)}</b><small>total</small></div>
      </div>
      <div class="donut-legend">${parts.map(({ c, v }) => `<div class="dl-row"><span class="dl-dot" style="background:${catTheme(c).color}"></span><span class="dl-name">${esc(c.name)}</span><span class="dl-val">${fmtK(v)}</span><span class="dl-pct">${Math.round((v / total) * 100)}%</span></div>`).join('')}</div>`;
  }

  // Últimos 6 períodos
  const series = [];
  for (let i = 5; i >= 0; i--) {
    const q = periodFromStart(p.startYear, p.startMonth - i);
    series.push({ q, spent: expensesIn(q).reduce((s, e) => s + e.amount, 0), current: i === 0 });
  }
  const budget = catsFor(p, exps).reduce((s, c) => s + limitFor(c, p.key), 0);
  const max = Math.max(1, budget, ...series.map((x) => x.spent));
  const closed = series.filter((x) => !x.current && x.spent > 0);
  $('st-avg6').textContent = closed.length ? `Promedio ${fmtK(closed.reduce((s, x) => s + x.spent, 0) / closed.length)}` : '';
  $('st-cols').innerHTML = (budget ? `<div class="budget-line" style="bottom:calc(${(budget / max).toFixed(4)} * (100% - 18px))"><span>Presupuesto ${fmtK(budget)}</span></div>` : '')
    + series.map((x) => `<div class="bar-col">
        <span class="bar-val">${x.spent ? fmtK(x.spent) : ''}</span>
        <div class="bar${x.current ? ' current' : ''}" style="height:${((x.spent / max) * 100).toFixed(2)}%" title="${esc(periodLabel(x.q))}: ${fmt(x.spent)}"></div>
      </div>`).join('');
  $('st-col-labels').innerHTML = series.map((x) => `<span class="${x.current ? 'current' : ''}">${cap(MS[x.q.startMonth])}</span>`).join('');

  // Comparado con el período anterior
  const both = categories.filter((c) => spentReal(exps, c.id) > 0 || spentReal(prevExps, c.id) > 0 || catsFor(p, exps).includes(c));
  $('st-compare').innerHTML = both.length
    ? `<table class="cmp-table">
        <thead><tr><th>Categoría</th><th>${esc(cap(MS[prev.startMonth]))}</th><th>${esc(cap(MS[p.startMonth]))}</th><th>Cambio</th></tr></thead>
        <tbody>${both.map((c) => {
          const a = spentReal(prevExps, c.id), b = spentReal(exps, c.id);
          return `<tr><td>${esc(c.name)}</td><td>${fmtK(a)}</td><td>${fmtK(b)}</td><td>${deltaHtml(pctChange(b, a))}</td></tr>`;
        }).join('')}
        <tr class="total"><td>Total</td><td>${fmtK(prevTotal)}</td><td>${fmtK(total)}</td><td>${deltaHtml(pctChange(total, prevTotal))}</td></tr></tbody>
      </table>`
    : '<p class="hint">Sin datos para comparar.</p>';

  // Quién registró más
  const people = users.map((u, i) => {
    const mine = exps.filter((e) => e.userId === u.id);
    return { name: u.displayName, i, total: mine.reduce((s, e) => s + e.amount, 0), count: mine.length };
  });
  const others = exps.filter((e) => !users.some((u) => u.id === e.userId));
  if (others.length) people.push({ name: 'Otros', i: 2, total: others.reduce((s, e) => s + e.amount, 0), count: others.length });
  const userColor = (i) => ['#5B4B8A', '#C46B7E', '#2F6B5E'][i % 3];
  $('st-people').innerHTML = people.map((x) => `<div class="person">
      <span class="avatar-lg${x.i % 2 ? ' alt' : ''}">${esc(x.name[0] || '?')}</span>
      <div class="person-amount">${fmt(x.total)}</div>
      <div class="person-sub">${esc(x.name)} · ${x.count} ${x.count === 1 ? 'gasto' : 'gastos'}${total ? ' · ' + Math.round((x.total / total) * 100) + '%' : ''}</div>
    </div>`).join('');
  $('st-split').innerHTML = total ? people.map((x) => `<span style="width:${(x.total / total) * 100}%;background:${userColor(x.i)}"></span>`).join('') : '';

  // Los 5 gastos más grandes
  const top = exps.slice().sort((a, b) => b.amount - a.amount).slice(0, 5);
  $('st-top').innerHTML = top.length
    ? top.map((e, i) => `<div class="top-row"><span><span class="top-rank">${i + 1}</span><span class="top-desc">${esc(e.desc)}</span>${e.cuotas ? ` <span class="tag tag-cuota">Cuota ${e.cuota}/${e.cuotas}</span>` : ''}<br><span class="exp-meta">${esc(catName(e.catId))} · ${fmtDate(e.date)} · ${esc(userName(e))}</span></span><b>${fmt(e.amount)}</b></div>`).join('')
    : '<p class="hint">Sin gastos en este período.</p>';
}

// Más › Categorías
function renderCatConfig(p) {
  const list = $('cat-config-list');
  if (list.contains(document.activeElement)) return; // no interrumpir mientras escriben un presupuesto
  const exps = expensesIn(p);
  const cats = catsFor(p, exps);
  const active = cats.filter((c) => !(c.archivedFrom && p.key >= c.archivedFrom));
  $('budget-total').textContent = fmt(active.reduce((s, c) => s + limitFor(c, p.key), 0));
  $('budget-meta').textContent = `${active.length} ${active.length === 1 ? 'categoría' : 'categorías'} · ${periodLabel(p)}`;
  list.innerHTML = cats.length ? cats.map((c) => {
    const removed = c.archivedFrom && p.key >= c.archivedFrom;
    return `<div class="cfg-row">
      ${catIcon(c)}
      ${removed
        ? `<div class="cfg-name"><b>${esc(c.name)} <span class="tag tag-muted">Quitada</span></b><small>Presupuesto ${fmt(limitFor(c, p.key))}</small></div>`
        : `<button class="cfg-name" type="button" data-edit-cat="${esc(c.id)}" aria-label="Editar ${esc(c.name)}"><b>${esc(c.name)}</b><small>Aviso al ${c.threshold}% · Editar</small></button>
           <label class="money-input"><span>Q</span><input type="number" min="0" step="0.01" inputmode="decimal" value="${limitFor(c, p.key)}" data-limit-cat="${esc(c.id)}" aria-label="Presupuesto de ${esc(c.name)}"></label>`}
    </div>`;
  }).join('') : '<p class="hint" style="padding:16px">Sin categorías en este período.</p>';
  $('cat-note').textContent = `Los cambios de presupuesto aplican desde ${periodLabel(p)} en adelante; los períodos anteriores conservan el suyo.`;
}

// Más › Datos
function renderSyncCard() {
  const n = myPending().length;
  const offline = !$('offline-banner').classList.contains('hidden');
  const warn = offline || n > 0 || syncFailed;
  $('sync-card').classList.toggle('warn', warn);
  $('sync-title').textContent = offline ? 'Sin conexión' : n ? `${n} ${n === 1 ? 'gasto pendiente' : 'gastos pendientes'} de subir` : syncFailed ? 'No se pudo sincronizar' : 'Todo sincronizado';
  $('sync-sub').textContent = lastSyncAt ? `Última sincronización: ${ago(lastSyncAt)}` : 'Todavía no se sincroniza en esta sesión';
  const icon = $('sync-icon');
  const want = warn ? 'importar' : 'check';
  if (icon.dataset.icon !== want) { icon.dataset.icon = want; icon.removeAttribute('data-done'); hydrateIcons(icon.parentElement); }
}

// ── Registrar (hoja) ───────────────────────────────────────────────────

let regCat = '';
let regCharge = '';

function openRegister() {
  if (!activeCats().some((c) => c.id === regCat)) regCat = activeCats()[0]?.id || '';
  setRegDate('hoy');
  openSheet('register-sheet');
  renderRegChips(); updateRegButton();
  setTimeout(() => $('exp-amount').focus(), 120);
}

function setRegDate(mode, value) {
  const d = mode === 'hoy' ? todayLocal() : mode === 'ayer' ? ymd(new Date(Date.now() - 864e5)) : (value || $('exp-date').value || todayLocal());
  $('exp-date').value = d;
  document.querySelectorAll('[data-date]').forEach((b) => b.classList.toggle('active', b.dataset.date === mode));
  $('exp-date').classList.toggle('hidden', mode !== 'otra');
  $('date-other-label').textContent = mode === 'otra' ? fmtDate(d) : 'Otra fecha';
}

function regChip(c, selected, charged, exps, p, amount, attr) {
  const lim = limitFor(c, p.key), sp = spentIn(exps, c.id), rem = lim - sp;
  let st = catState(sp, lim, c.threshold);
  let bal = rem >= 0 ? `Quedan ${fmt(rem)}` : `Excedido ${fmt(-rem)}`;
  if (charged && amount > 0) {
    const after = rem - amount;
    st = catState(sp + amount, lim, c.threshold);
    bal = `${rem >= 0 ? fmt(rem) : '−' + fmt(-rem)} → ${after >= 0 ? fmt(after) : '−' + fmt(-after)}`;
  }
  return `<button type="button" class="cat-chip" role="radio" aria-checked="${selected}" ${attr}="${esc(c.id)}">
    ${catIcon(c, 'xs')}
    <span class="cat-chip-text"><span class="cat-chip-name">${esc(c.name)}</span><span class="cat-chip-bal state-${st}">${bal}</span></span>
  </button>`;
}

function renderRegChips() {
  const p = periodOfDate($('exp-date').value || todayLocal());
  const exps = expensesIn(p);
  const amount = parseFloat($('exp-amount').value) || 0;
  const n = $('exp-inst').checked ? Number($('exp-cuotas').value) : 1;
  const thisAmount = n > 1 && Number.isInteger(n) && n <= 48 ? splitCuotas(amount, n)[0] : amount;
  const cats = activeCats();
  if (regCharge === regCat || !cats.some((c) => c.id === regCharge)) regCharge = cats.find((c) => c.id !== regCat)?.id || '';
  const useCharge = $('exp-other').checked && regCharge;
  const charged = useCharge ? regCharge : regCat;
  $('cat-chips').innerHTML = cats.length
    ? cats.map((c) => regChip(c, c.id === regCat, c.id === charged, exps, p, thisAmount, 'data-reg-cat')).join('')
    : '<p class="hint">Todavía no hay categorías. Créenlas en Más › Categorías.</p>';
  $('charge-chips').innerHTML = cats.filter((c) => c.id !== regCat)
    .map((c) => regChip(c, c.id === regCharge, c.id === charged, exps, p, thisAmount, 'data-reg-charge')).join('');
  $('exp-cat').value = regCat;
  $('exp-charge').value = regCharge;
  $('charge-box').classList.toggle('hidden', !$('exp-other').checked);
}

function updateRegButton() {
  const amount = parseFloat($('exp-amount').value) || 0;
  // El campo del monto crece con lo que escriben, para que la "Q" quede pegada.
  $('exp-amount').style.width = `${Math.max(2, ($('exp-amount').value || '0').length + 0.6)}ch`;
  const n = Number($('exp-cuotas').value);
  const inst = $('exp-inst').checked && Number.isInteger(n) && n >= 2;
  $('exp-submit').disabled = !(amount > 0);
  $('exp-submit').textContent = `Registrar ${fmt(amount)}${inst ? ` en ${n} cuotas` : ''}`;
}

// Muestra u oculta las opciones de cuotas y explica cómo quedarían.
function updateInstallments() {
  const on = $('exp-inst').checked;
  $('exp-inst-box').classList.toggle('hidden', !on);
  $('exp-amount-label').textContent = on ? 'Monto total' : 'Monto';
  if (on) {
    const n = Number($('exp-cuotas').value), total = parseFloat($('exp-amount').value), ds = $('exp-date').value;
    if (!Number.isInteger(n) || n < 2 || n > 48) $('exp-inst-hint').textContent = 'Elige entre 2 y 48 cuotas.';
    else if (!(total > 0) || !ds) $('exp-inst-hint').textContent = 'Escribe el monto total para ver las cuotas.';
    else {
      const parts = splitCuotas(total, n);
      const first = periodLabel(periodOfDate(ds)), last = periodLabel(periodOfDate(cuotaDate(ds, n - 1)));
      const diff = parts[n - 1] !== parts[0] ? ` (la última de ${fmt(parts[n - 1])})` : '';
      $('exp-inst-hint').textContent = `${n} cuotas de ${fmt(parts[0])}${diff}, de ${first} a ${last}. La primera se descuenta en la fecha de compra y las siguientes el ${CUT_DAY} de cada corte.`;
    }
  }
  renderRegChips(); updateRegButton();
}

// ── Acciones ───────────────────────────────────────────────────────────

async function addExpense(ev) {
  ev.preventDefault();
  const body = {
    desc: $('exp-desc').value.trim(), amount: parseFloat($('exp-amount').value),
    catId: $('exp-cat').value, date: $('exp-date').value,
    chargeCatId: $('exp-other').checked ? $('exp-charge').value : null,
  };
  if ($('exp-other').checked && !body.chargeCatId) { alert('Elige de qué categoría se descuenta.'); return; }
  if ($('exp-inst').checked) {
    const n = Number($('exp-cuotas').value);
    if (!Number.isInteger(n) || n < 2 || n > 48) { alert('El número de cuotas debe estar entre 2 y 48.'); return; }
    body.cuotas = n;
  }
  if (!body.catId) { alert('Elige una categoría.'); return; }
  if (!body.desc) { alert('Escribe una descripción.'); $('exp-desc').focus(); return; }
  if (!(body.amount > 0) || !body.date) { alert('Completa monto, categoría, descripción y fecha.'); return; }
  body.clientId = newClientId();
  $('exp-submit').disabled = true;
  const clearForm = () => {
    $('exp-desc').value = ''; $('exp-amount').value = '';
    $('exp-other').checked = false;
    $('exp-inst').checked = false; $('exp-cuotas').value = '3';
    updateInstallments();
  };
  try {
    setSyncStatus('loading');
    const d = await api('/api/gastos', { method: 'POST', body });
    applyData(d); setSyncStatus('ok');
    clearForm(); closeOverlays();
    const created = d.created;
    toast(created.cuotas ? `Compra en ${created.cuotas} cuotas registrada` : 'Gasto registrado', {
      label: 'Deshacer',
      run: async () => {
        try { applyData(await api(`/api/gastos/${encodeURIComponent(created.id)}`, { method: 'DELETE' })); toast(created.cuotas ? 'Compra eliminada' : 'Gasto eliminado'); }
        catch (e) { alert(e.offline ? 'No hay conexión para deshacer. Puedes eliminarlo luego desde Movimientos.' : e.message); }
      },
    });
    syncPending();
  } catch (e) {
    if (e.offline || e.status === 401) {
      // Sin conexión (o sesión vencida): se guarda en el celular y se sube después.
      const { clientId, ...rest } = body;
      pending.push({ clientId, body: rest, userId: (me || estado?.user || {}).id, createdAt: Date.now() });
      savePending();
      if (me) {
        mergePending(); renderAll();
        setSyncStatus('error', OFFLINE_MSG);
        clearForm(); closeOverlays();
        toast('Guardado en el celular · se sube al volver la conexión', {
          label: 'Deshacer',
          run: () => { pending = pending.filter((x) => x.clientId !== clientId); savePending(); mergePending(); renderAll(); renderSyncCard(); },
        });
      }
    } else {
      setSyncStatus('error', e.message); alert(e.message);
    }
  } finally { updateRegButton(); }
}

function catOptions(selected) {
  const list = activeCats();
  if (selected && !list.some((c) => c.id === selected)) {
    const c = categories.find((x) => x.id === selected); if (c) list.push(c);
  }
  return list.map((c) => `<option value="${esc(c.id)}"${c.id === selected ? ' selected' : ''}>${esc(c.name)}</option>`).join('');
}

// Opciones de "descontar de": todas las categorías activas menos la del gasto.
function fillCharge(selectEl, catId, selected) {
  const list = activeCats().filter((c) => c.id !== catId);
  if (selected && selected !== catId && !list.some((c) => c.id === selected)) {
    const c = categories.find((x) => x.id === selected); if (c) list.push(c);
  }
  selectEl.innerHTML = list.map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('');
  if (selected && list.some((c) => c.id === selected)) selectEl.value = selected;
}

function openEditExpense(id) {
  const e = expenses.find((x) => x.id === id); if (!e) return;
  editingExpId = id;
  $('ee-desc').value = e.desc; $('ee-amount').value = e.amount;
  $('ee-cat').innerHTML = catOptions(e.catId); $('ee-date').value = e.date;
  $('ee-other').checked = !!e.chargeCatId;
  fillCharge($('ee-charge'), e.catId, e.chargeCatId);
  $('ee-charge').classList.toggle('hidden', !e.chargeCatId);
  $('ee-hint').textContent = e.cuotas ? `Es la cuota ${e.cuota} de ${e.cuotas}. La descripción y la categoría cambian en todas las cuotas; el monto y la fecha, solo en esta.` : '';
  $('ee-hint').classList.toggle('hidden', !e.cuotas);
  $('ee-delete').textContent = e.cuotas ? 'Eliminar la compra completa' : 'Eliminar gasto';
  openSheet('edit-exp-sheet');
}

async function saveEditExpense(ev) {
  ev.preventDefault();
  const body = {
    desc: $('ee-desc').value.trim(), amount: parseFloat($('ee-amount').value), catId: $('ee-cat').value, date: $('ee-date').value,
    chargeCatId: $('ee-other').checked ? $('ee-charge').value : null,
  };
  if ($('ee-other').checked && !body.chargeCatId) { alert('Elige de qué categoría se descuenta.'); return; }
  try {
    await mutate(`/api/gastos/${encodeURIComponent(editingExpId)}`, { method: 'PUT', body });
    closeOverlays();
    const moved = periodOfDate(body.date).key !== getPeriod(periodOffset).key;
    toast(moved ? `Gasto guardado en ${periodLabel(periodOfDate(body.date))}` : 'Cambios guardados');
  } catch {}
}

async function deleteExpense(id) {
  const e = expenses.find((x) => x.id === id); if (!e) return;
  const text = e.cuotas
    ? `"${e.desc}" es una compra en ${e.cuotas} cuotas (total ${fmt(e.planTotal || 0)}).\n\n¿Eliminar la compra completa? Se borran todas sus cuotas.`
    : `¿Eliminar "${e.desc}" por ${fmt(e.amount)}?`;
  if (!confirm(text)) return;
  try { await mutate(`/api/gastos/${encodeURIComponent(id)}`, { method: 'DELETE' }); closeOverlays(); toast(e.cuotas ? 'Compra eliminada' : 'Gasto eliminado'); } catch {}
}

function openNewCategory() {
  editingCatId = null;
  $('cat-sheet-title').textContent = 'Nueva categoría';
  $('cat-name').value = ''; $('cat-limit').value = ''; $('cat-threshold').value = '80';
  $('cat-hint').textContent = `Empieza a contar desde ${periodLabel(getPeriod(periodOffset))}.`;
  $('cat-delete').classList.add('hidden');
  openSheet('cat-sheet');
  setTimeout(() => $('cat-name').focus(), 120);
}

async function addCategory() {
  const body = { name: $('cat-name').value.trim(), limit: parseFloat($('cat-limit').value), threshold: parseInt($('cat-threshold').value, 10) || 80, from: getPeriod(periodOffset).key };
  try {
    await mutate('/api/categorias', { method: 'POST', body });
    closeOverlays();
    toast('Categoría guardada');
  } catch {}
}

function openEditCategory(id) {
  const c = categories.find((x) => x.id === id); if (!c) return;
  const p = getPeriod(periodOffset);
  editingCatId = id;
  $('cat-sheet-title').textContent = 'Editar categoría';
  $('cat-name').value = c.name; $('cat-limit').value = limitFor(c, p.key); $('cat-threshold').value = c.threshold;
  $('cat-hint').textContent = `El límite nuevo aplica desde ${periodLabel(p)} en adelante. Los períodos anteriores conservan el suyo. El nombre y el aviso cambian en todos.`;
  $('cat-delete').classList.remove('hidden');
  openSheet('cat-sheet');
}

async function saveEditCategory() {
  const body = { name: $('cat-name').value.trim(), limit: parseFloat($('cat-limit').value), threshold: parseInt($('cat-threshold').value, 10), from: getPeriod(periodOffset).key };
  try { await mutate(`/api/categorias/${encodeURIComponent(editingCatId)}`, { method: 'PUT', body }); closeOverlays(); toast('Cambios guardados'); } catch {}
}

// Presupuesto editado directo en la lista (mismo cambio que en "Editar categoría").
async function saveInlineLimit(input) {
  const c = categories.find((x) => x.id === input.dataset.limitCat); if (!c) return;
  const p = getPeriod(periodOffset);
  const limit = parseFloat(input.value);
  if (!(limit > 0)) { alert('El presupuesto debe ser mayor a cero.'); input.value = limitFor(c, p.key); return; }
  if (limit === limitFor(c, p.key)) return;
  input.blur();
  try {
    await mutate(`/api/categorias/${encodeURIComponent(c.id)}`, { method: 'PUT', body: { name: c.name, limit, threshold: c.threshold, from: p.key } });
    toast(`Presupuesto de ${c.name} actualizado desde ${periodLabel(p)}`);
  } catch { input.value = limitFor(c, p.key); }
}

async function deleteCategory(id) {
  const c = categories.find((x) => x.id === id); if (!c) return;
  const p = getPeriod(periodOffset);
  const used = expenses.some((e) => e.catId === id || e.chargeCatId === id);
  const text = used
    ? `¿Quitar "${c.name}" desde ${periodLabel(p)}?\n\nLos períodos anteriores la siguen mostrando con sus gastos.`
    : `¿Eliminar "${c.name}"? No tiene gastos registrados.`;
  if (!confirm(text)) return;
  try { await mutate(`/api/categorias/${encodeURIComponent(id)}`, { method: 'DELETE', body: { from: p.key } }); closeOverlays(); } catch {}
}

// ── Exportar a Excel ───────────────────────────────────────────────────

function sheetName(n) { return n.slice(0, 31).replace(/[\\/*?[\]:]/g, ''); }

function exportGlobal() {
  if (!window.XLSX) { alert('El exportador no cargó. Revisa la conexión a internet y recarga.'); return; }
  const p = getPeriod(periodOffset), exps = expensesIn(p).sort((a, b) => a.date.localeCompare(b.date));
  const wb = XLSX.utils.book_new();
  const rs = [['Categoría', 'Límite (Q)', 'Gastado (Q)', 'Disponible (Q)', '% Usado', 'Aviso al %']];
  let tl = 0, ts = 0;
  for (const c of catsFor(p, exps)) {
    const lim = limitFor(c, p.key), sp = spentIn(exps, c.id); tl += lim; ts += sp;
    rs.push([c.name, lim, +sp.toFixed(2), +(lim - sp).toFixed(2), lim ? +(sp / lim * 100).toFixed(1) + '%' : '—', c.threshold + '%']);
  }
  rs.push(['TOTAL', tl, +ts.toFixed(2), +(tl - ts).toFixed(2), tl ? +(ts / tl * 100).toFixed(1) + '%' : '—', '']);
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rs), 'Resumen');
  const dt = [['Fecha', 'Descripción', 'Categoría', 'Descontado de', 'Monto (Q)', 'Registrado por']];
  exps.forEach((e) => dt.push([e.date, e.desc, catName(e.catId), catName(chargeOf(e)), e.amount, userName(e)]));
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(dt), 'Detalle gastos');
  XLSX.writeFile(wb, `Gastos_${periodLabel(p).replace(' ', '_')}_Global.xlsx`);
}

function exportPorCategoria() {
  if (!window.XLSX) { alert('El exportador no cargó. Revisa la conexión a internet y recarga.'); return; }
  const p = getPeriod(periodOffset), exps = expensesIn(p);
  const cats = catsFor(p, exps);
  const wb = XLSX.utils.book_new();
  const rs = [['Categoría', 'Límite (Q)', 'Gastado (Q)', 'Disponible (Q)', '% Usado']];
  for (const c of cats) {
    const lim = limitFor(c, p.key), sp = spentIn(exps, c.id);
    rs.push([c.name, lim, +sp.toFixed(2), +(lim - sp).toFixed(2), lim ? +(sp / lim * 100).toFixed(1) + '%' : '—']);
  }
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rs), 'Resumen');
  for (const c of cats) {
    const ce = exps.filter((e) => chargeOf(e) === c.id).sort((a, b) => a.date.localeCompare(b.date));
    const lim = limitFor(c, p.key), sp = spentIn(exps, c.id);
    const data = [[`Categoría: ${c.name}`, `Período: ${periodDates(p)}`], [`Límite: Q${lim}`, `Gastado: Q${sp.toFixed(2)}`, `Disponible: Q${(lim - sp).toFixed(2)}`], [], ['Fecha', 'Descripción', 'Monto (Q)', 'Registrado por', 'Nota']];
    ce.forEach((e) => data.push([e.date, e.desc, e.amount, userName(e), e.catId !== c.id ? `Gasto de ${catName(e.catId)} descontado aquí` : '']));
    data.push([], ['', 'TOTAL', +sp.toFixed(2), '', '']);
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(data), sheetName(c.name));
  }
  XLSX.writeFile(wb, `Gastos_${periodLabel(p).replace(' ', '_')}_PorCategoria.xlsx`);
}

// ── Inicio de sesión ───────────────────────────────────────────────────

const AUTH_ERRORS = {
  'auth/invalid-credential': 'El correo o la contraseña no coinciden.',
  'auth/wrong-password': 'El correo o la contraseña no coinciden.',
  'auth/user-not-found': 'El correo o la contraseña no coinciden.',
  'auth/invalid-email': 'El correo no tiene un formato válido.',
  'auth/missing-password': 'Escribe tu contraseña.',
  'auth/too-many-requests': 'Demasiados intentos. Espera unos minutos y vuelve a intentarlo.',
  'auth/network-request-failed': 'No hay conexión a internet para confirmar tu cuenta.',
  'auth/unauthorized-domain': 'Esta dirección no está autorizada en Firebase (paso 7 de la guía).',
  'auth/operation-not-allowed': 'El inicio de sesión con correo no está activado en Firebase.',
};

let firebaseAuth = null;
async function getFirebaseAuth() {
  if (firebaseAuth) return firebaseAuth;
  const [{ initializeApp }, authMod] = await Promise.all([
    import(`${FIREBASE_SDK}/firebase-app.js`),
    import(`${FIREBASE_SDK}/firebase-auth.js`),
  ]);
  const app = initializeApp(estado.firebase, 'gastos');
  firebaseAuth = { auth: authMod.getAuth(app), mod: authMod };
  return firebaseAuth;
}

function loginMessage(text, kind = 'error') { const m = $('login-msg'); m.className = `msg ${kind}`; m.textContent = text; }

function showLogin() {
  $('main-app').classList.add('hidden');
  $('login-screen').classList.remove('hidden');
  const prueba = estado?.modoPrueba;
  $('login-prueba').classList.toggle('hidden', !prueba);
  $('login-pass-group').classList.toggle('hidden', !!prueba);
  $('login-reset').classList.toggle('hidden', !!prueba);
  const blocked = estado?.problema;
  $('login-form').classList.toggle('hidden', !!blocked);
  if (blocked) { $('login-reset').classList.add('hidden'); loginMessage(blocked); }
}

function showApp(offlineCopy) {
  $('login-screen').classList.add('hidden');
  $('main-app').classList.remove('hidden');
  const initial = (me.displayName || '?').trim()[0].toUpperCase();
  $('avatar-initial').textContent = initial;
  $('account-initial').textContent = initial;
  $('account-name').textContent = me.displayName;
  showView('inicio');
  $('exp-date').value = todayLocal();
  if (offlineCopy) {
    applyData(offlineCopy.data);
    setSyncStatus('error', OFFLINE_MSG);
  } else {
    loadData();
  }
}

async function doLogin(ev) {
  ev.preventDefault();
  const email = $('login-email').value.trim();
  const pass = $('login-pass').value;
  if (!email) { loginMessage('Escribe tu correo.'); return; }
  $('login-btn').disabled = true; loginMessage('Entrando…', 'info');
  try {
    let body;
    if (estado.modoPrueba) {
      body = { correo: email };
    } else {
      if (!pass) { loginMessage('Escribe tu contraseña.'); return; }
      const { auth, mod } = await getFirebaseAuth();
      const cred = await mod.signInWithEmailAndPassword(auth, email, pass);
      body = { idToken: await cred.user.getIdToken() };
      mod.signOut(auth).catch(() => {});
    }
    const d = await api('/api/entrar', { method: 'POST', body });
    me = d.user; $('login-pass').value = ''; loginMessage('');
    showApp();
  } catch (e) {
    loginMessage(AUTH_ERRORS[e.code] || e.message || 'No se pudo entrar.');
  } finally { $('login-btn').disabled = false; }
}

async function resetPassword() {
  const email = $('login-email').value.trim();
  if (!email) { loginMessage('Escribe tu correo arriba y vuelve a tocar “¿Olvidaste tu contraseña?”.'); return; }
  try {
    const { auth, mod } = await getFirebaseAuth();
    await mod.sendPasswordResetEmail(auth, email);
    loginMessage(`Si el correo ${email} tiene cuenta, te llegará un enlace para crear una contraseña nueva.`, 'info');
  } catch (e) { loginMessage(AUTH_ERRORS[e.code] || e.message); }
}

async function doLogout() {
  const n = myPending().length;
  const text = n
    ? `Hay ${n} ${n === 1 ? 'gasto que todavía no se ha subido' : 'gastos que todavía no se han subido'} desde este celular. Si cierras sesión, se borran.\n\n¿Cerrar sesión de todas formas?`
    : '¿Cerrar sesión en este dispositivo?';
  if (!confirm(text)) return;
  try { await api('/api/salir', { method: 'POST' }); } catch {}
  pending = pending.filter((p) => p.userId !== me.id);
  savePending();
  try { localStorage.removeItem(LS_COPIA); } catch {}
  me = null; showLogin();
}

// ── Arranque ───────────────────────────────────────────────────────────

function bindEvents() {
  hydrateIcons();
  $('login-form').addEventListener('submit', doLogin);
  $('login-reset').addEventListener('click', resetPassword);

  // Navegación
  document.querySelectorAll('[data-nav]').forEach((b) => b.addEventListener('click', () => showView(b.dataset.nav)));
  document.querySelectorAll('[data-seg]').forEach((b) => b.addEventListener('click', () => showSegment(b.dataset.seg)));
  $('avatar-btn').addEventListener('click', () => goMas('datos'));
  $('go-edit-cats').addEventListener('click', () => goMas('categorias'));
  document.querySelectorAll('[data-go-cats]').forEach((b) => b.addEventListener('click', () => goMas('categorias')));
  document.querySelectorAll('[data-period]').forEach((b) => b.addEventListener('click', () => changePeriod(Number(b.dataset.period))));
  $('btn-hoy').addEventListener('click', () => { periodOffset = 0; renderAll(); });

  // Registrar
  $('fab').addEventListener('click', openRegister);
  document.querySelectorAll('[data-open-register]').forEach((b) => b.addEventListener('click', openRegister));
  $('exp-form').addEventListener('submit', addExpense);
  $('exp-amount').addEventListener('input', updateInstallments);
  ['exp-inst', 'exp-cuotas'].forEach((id) => $(id).addEventListener('input', updateInstallments));
  $('exp-inst').addEventListener('change', updateInstallments);
  $('exp-other').addEventListener('change', renderRegChips);
  $('cat-chips').addEventListener('click', (e) => { const b = e.target.closest('[data-reg-cat]'); if (b) { regCat = b.dataset.regCat; renderRegChips(); } });
  $('charge-chips').addEventListener('click', (e) => { const b = e.target.closest('[data-reg-charge]'); if (b) { regCharge = b.dataset.regCharge; renderRegChips(); } });
  document.querySelectorAll('[data-date]').forEach((b) => b.addEventListener('click', () => {
    setRegDate(b.dataset.date);
    if (b.dataset.date === 'otra') { try { $('exp-date').showPicker(); } catch { $('exp-date').focus(); } }
    updateInstallments();
  }));
  $('exp-date').addEventListener('change', () => { setRegDate('otra', $('exp-date').value); updateInstallments(); });

  // Editar gasto
  $('edit-exp-form').addEventListener('submit', saveEditExpense);
  $('ee-delete').addEventListener('click', () => deleteExpense(editingExpId));
  $('ee-other').addEventListener('change', () => { fillCharge($('ee-charge'), $('ee-cat').value, $('ee-charge').value); $('ee-charge').classList.toggle('hidden', !$('ee-other').checked); });
  $('ee-cat').addEventListener('change', () => fillCharge($('ee-charge'), $('ee-cat').value, $('ee-charge').value));

  // Categorías
  $('btn-new-cat').addEventListener('click', openNewCategory);
  $('cat-form').addEventListener('submit', (e) => { e.preventDefault(); if (editingCatId) saveEditCategory(); else addCategory(); });
  $('cat-delete').addEventListener('click', () => deleteCategory(editingCatId));
  $('cat-config-list').addEventListener('click', (e) => { const ed = e.target.closest('[data-edit-cat]'); if (ed) openEditCategory(ed.dataset.editCat); });
  $('cat-config-list').addEventListener('change', (e) => { if (e.target.matches('[data-limit-cat]')) saveInlineLimit(e.target); });
  $('cat-config-list').addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.matches('[data-limit-cat]')) e.target.blur(); });

  // Hojas
  document.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', closeOverlays));
  document.querySelectorAll('.sheet-backdrop').forEach((o) => o.addEventListener('click', (e) => { if (e.target === o) closeOverlays(); }));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeOverlays(); });

  // Movimientos
  $('expense-groups').addEventListener('click', (e) => {
    const ed = e.target.closest('[data-edit-exp]'); if (ed) return openEditExpense(ed.dataset.editExp);
    const dp = e.target.closest('[data-del-pend]'); if (dp) return removePending(dp.dataset.delPend);
  });
  $('f-text').addEventListener('input', () => renderMovimientos(getPeriod(periodOffset)));
  $('f-cats').addEventListener('click', (e) => { const b = e.target.closest('[data-fcat]'); if (b) { filterCat = b.dataset.fcat; renderMovimientos(getPeriod(periodOffset)); } });
  $('f-users').addEventListener('click', (e) => {
    const b = e.target.closest('[data-fuser]'); if (b) { filterUser = b.dataset.fuser; renderMovimientos(getPeriod(periodOffset)); return; }
    if (e.target.closest('[data-fall]')) { filterAll = !filterAll; renderMovimientos(getPeriod(periodOffset)); }
  });

  // Datos
  $('btn-sync').addEventListener('click', loadData);
  $('btn-export-global').addEventListener('click', exportGlobal);
  $('btn-export-cat').addEventListener('click', exportPorCategoria);
  $('btn-logout').addEventListener('click', doLogout);

  // Mantener los datos al día entre los dos.
  setInterval(() => { if (me && document.visibilityState === 'visible') loadData(); }, 30000);
  window.addEventListener('online', () => { if (me) loadData(); });
  document.addEventListener('visibilitychange', () => { if (me && document.visibilityState === 'visible') loadData(); });
}

async function start() {
  bindEvents();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
  pending = lsGet(LS_PENDIENTES, []);
  try {
    estado = await api('/api/estado');
  } catch (e) {
    // Sin conexión: si este celular ya tenía la sesión abierta, se abre con la última copia.
    const copia = lsGet(LS_COPIA, null);
    if (e.offline && copia?.user) {
      estado = { user: copia.user };
      me = copia.user; showApp(copia); return;
    }
    estado = { problema: e.message };
  }
  if (estado.user) { me = estado.user; showApp(); }
  else showLogin();
}

start();
