// Gastos familiares — lógica de la app en el navegador.
// Los datos viven en el servidor de la casa (API en /api). Firebase solo
// se usa para confirmar el correo y la contraseña al iniciar sesión.

const CUT_DAY = 22; // El período va del 22 de un mes al 21 del siguiente.
const FIREBASE_SDK = 'https://www.gstatic.com/firebasejs/10.12.0';
const MF = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
const MS = ['ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic'];
const CAT_COLORS = ['#2563eb','#d97706','#16a34a','#9333ea','#db2777','#0891b2','#65a30d','#dc2626','#4b5563'];
const USER_COLORS = ['#db2777','#2563eb','#16a34a','#9333ea'];

let me = null;
let users = [];
let categories = [];
let expenses = [];
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

function toast(text) {
  const t = document.createElement('div');
  t.className = 'toast'; t.textContent = text;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3500);
}

async function api(path, { method = 'GET', body } = {}) {
  let r;
  try {
    r = await fetch(path, {
      method, credentials: 'same-origin',
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new Error('No hay conexión con el servidor. Revisa que Tailscale esté activo.');
  }
  let data = {};
  try { data = await r.json(); } catch {}
  if (r.status === 401 && path !== '/api/entrar') { me = null; showLogin(); }
  if (!r.ok) throw new Error(data.error || `Error ${r.status}`);
  return data;
}

function setSyncStatus(state, detail) {
  const c = { ok: 'sync-ok', loading: 'sync-loading', error: 'sync-error' };
  const l = { ok: 'Sincronizado', loading: 'Sincronizando...', error: detail || 'Sin conexión con el servidor' };
  $('sync-status').innerHTML = `<span class="sync-dot ${c[state]}"></span>${esc(l[state])}`;
}

function applyData(d) {
  if (d && d.categories) { categories = d.categories; expenses = d.expenses; users = d.users || []; }
  renderAll();
}

async function loadData() {
  setSyncStatus('loading');
  try { applyData(await api('/api/datos')); setSyncStatus('ok'); }
  catch (e) { setSyncStatus('error', e.message); }
}

async function mutate(path, opts) {
  setSyncStatus('loading');
  try {
    const d = await api(path, opts);
    applyData(d);
    setSyncStatus('ok');
    return d;
  } catch (e) {
    setSyncStatus('error', e.message);
    alert(e.message);
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
function catColor(id) { const i = categories.findIndex((c) => c.id === id); return CAT_COLORS[(i < 0 ? 0 : i) % CAT_COLORS.length]; }
function barClass(pct, thr = 80) { return pct >= 100 ? 'bar-danger' : pct >= thr ? 'bar-warn' : 'bar-ok'; }
function textClass(pct, thr = 80) { return pct >= 100 ? 'danger' : pct >= thr ? 'warn' : 'ok'; }

function changePeriod(dir) { periodOffset += dir; renderAll(); }

// ── Pantallas ──────────────────────────────────────────────────────────

function showTab(name) {
  document.querySelectorAll('.section').forEach((s) => s.classList.toggle('active', s.id === 'tab-' + name));
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  renderAll();
  if (name === 'nuevo' && window.matchMedia('(min-width: 700px)').matches) $('exp-amount').focus();
}

function renderAll() {
  if (!me) return;
  const p = getPeriod(periodOffset);
  $('period-label').textContent = periodLabel(p);
  $('period-dates').textContent = periodDates(p);
  $('btn-hoy').classList.toggle('hidden', periodOffset === 0);
  document.querySelectorAll('.period-name').forEach((el) => { el.textContent = periodLabel(p); });
  $('export-period-label').textContent = `${periodLabel(p)} (${periodDates(p)})`;
  renderRegistrar(p); renderResumen(p); renderGastos(p); renderStats(p); renderCatConfig(p);
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

function renderRegistrar(p) {
  const sel = $('exp-cat');
  const prev = sel.value;
  sel.innerHTML = activeCats().length ? catOptions() : '<option value="">Sin categorías todavía</option>';
  if (prev && activeCats().some((c) => c.id === prev)) sel.value = prev;
  fillCharge($('exp-charge'), sel.value, $('exp-charge').value);
  if (!$('exp-date').value) $('exp-date').value = todayLocal();

  const exps = expensesIn(p);
  const rows = catsFor(p, exps).map((c) => {
    const lim = limitFor(c, p.key), spent = spentIn(exps, c.id), rem = lim - spent;
    const pct = lim > 0 ? (spent / lim) * 100 : 0;
    return `<div class="mini-row"><span>${esc(c.name)}</span><span class="${textClass(pct, c.threshold)}">${rem >= 0 ? 'Quedan <b>' + fmt(rem) + '</b>' : 'Excedido ' + fmt(-rem)}</span></div>`;
  });
  $('mini-summary').innerHTML = rows.length
    ? `<div class="mini-row" style="font-weight:600;color:#444"><span>Disponible en ${esc(periodLabel(p))}</span></div>${rows.join('')}`
    : (categories.length || expenses.length
      ? '<div class="mini-row">Primero crea una categoría en la pestaña Categorías.</div>'
      : '<div class="mini-row" style="display:block;line-height:1.5">Todavía no hay categorías. Si vienen de la versión anterior, ve a <a href="#" data-go="datos">Datos → Traer datos de Firebase</a>. Si empiezan de cero, créenlas en <a href="#" data-go="categorias">Categorías</a>.</div>');
}

function renderResumen(p) {
  const list = $('cat-list-resumen');
  const exps = expensesIn(p);
  const cats = catsFor(p, exps);
  list.innerHTML = '';
  $('empty-resumen').classList.toggle('hidden', cats.length > 0);
  let totBudget = 0, totSpent = 0;
  for (const cat of cats) {
    const spent = spentIn(exps, cat.id), lim = limitFor(cat, p.key);
    totBudget += lim; totSpent += spent;
    const rawPct = lim > 0 ? (spent / lim) * 100 : 0, pct = Math.min(Math.round(rawPct), 100);
    const rem = lim - spent, thr = cat.threshold || 80;
    const borrowed = exps.filter((e) => e.chargeCatId === cat.id && e.catId !== cat.id);
    const lent = exps.filter((e) => e.catId === cat.id && e.chargeCatId && e.chargeCatId !== cat.id);
    const notes = [];
    if (borrowed.length) notes.push(`Incluye ${fmt(borrowed.reduce((s, e) => s + e.amount, 0))} de otras categorías (${[...new Set(borrowed.map((e) => catName(e.catId)))].map(esc).join(', ')})`);
    if (lent.length) notes.push(`Además, ${fmt(lent.reduce((s, e) => s + e.amount, 0))} de ${esc(cat.name)} se descontó de ${[...new Set(lent.map((e) => catName(e.chargeCatId)))].map(esc).join(', ')}`);
    const row = document.createElement('div');
    row.className = 'cat-row';
    row.innerHTML = `
      <div class="cat-header">
        <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
          <span class="cat-name">${esc(cat.name)}</span>
          ${rawPct >= 100 ? '<span class="badge badge-danger">Límite superado</span>' : rawPct >= thr ? '<span class="badge badge-warn">Por alcanzar límite</span>' : ''}
        </div>
        <div class="cat-amounts">${fmt(spent)} de <span>${fmt(lim)}</span></div>
      </div>
      <div class="progress-track"><div class="progress-bar ${barClass(rawPct, thr)}" style="width:${pct}%"></div></div>
      <div class="cat-footer">
        <span class="cat-pct">${pct}% usado</span>
        <span class="cat-rem ${textClass(rawPct, thr)}">${rem >= 0 ? 'Disponible: ' + fmt(rem) : 'Excedido: ' + fmt(Math.abs(rem))}</span>
      </div>${notes.map((n) => `<div class="cat-note">${n}</div>`).join('')}`;
    list.appendChild(row);
  }
  const avail = totBudget - totSpent;
  $('s-budget').textContent = fmt(totBudget);
  $('s-spent').textContent = fmt(totSpent);
  $('s-avail').textContent = fmt(avail);
  $('s-avail').className = 'card-value ' + (avail < 0 ? 'danger' : avail < totBudget * 0.2 ? 'warn' : 'ok');
}

function renderGastos(p) {
  const fc = $('f-cat'), fu = $('f-user');
  const cv = fc.value, uv = fu.value;
  fc.innerHTML = '<option value="">Categorías</option>' + categories.map((c) => `<option value="${esc(c.id)}">${esc(c.name)}${c.archivedFrom ? ' (quitada)' : ''}</option>`).join('');
  fu.innerHTML = '<option value="">Personas</option>' + users.map((u) => `<option value="${esc(u.id)}">${esc(u.displayName)}</option>`).join('');
  fc.value = cv; fu.value = uv;

  const all = $('f-all').checked;
  const q = norm($('f-text').value.trim());
  let exps = all ? expenses.slice() : expensesIn(p);
  if (q) exps = exps.filter((e) => norm(e.desc).includes(q));
  if (fc.value) exps = exps.filter((e) => e.catId === fc.value || e.chargeCatId === fc.value);
  if (fu.value) exps = exps.filter((e) => e.userId === fu.value);
  exps.sort((a, b) => b.date.localeCompare(a.date) || (b.ts || 0) - (a.ts || 0));

  const total = exps.reduce((s, e) => s + e.amount, 0);
  const filtered = q || fc.value || fu.value;
  $('list-total').textContent = exps.length
    ? `${exps.length} ${exps.length === 1 ? 'gasto' : 'gastos'} · ${fmt(total)}${all ? ' · todos los períodos' : ''}${filtered ? ' · con filtros' : ''}`
    : '';
  $('empty-gastos').classList.toggle('hidden', exps.length > 0);
  $('empty-gastos').textContent = filtered ? 'No hay gastos que coincidan.' : 'Sin gastos en este período.';
  const shown = exps.slice(0, 300);
  $('expense-list').innerHTML = shown.map((e) => `
    <div class="exp-item">
      <div class="exp-left">
        <span class="exp-name">${esc(e.desc)}</span>
        <span class="exp-meta">${catLabel(e)} · ${fmtDate(e.date)} · ${esc(userName(e))}${e.editedAt ? ' · editado' : ''}</span>
      </div>
      <div class="exp-right">
        <span class="exp-amount">${fmt(e.amount)}</span>
        ${e.userId === me.id ? `<button class="btn-small" data-edit-exp="${esc(e.id)}" aria-label="Editar">✎</button><button class="btn-del" data-del-exp="${esc(e.id)}" aria-label="Eliminar">✕</button>` : ''}
      </div>
    </div>`).join('') + (exps.length > shown.length ? `<div class="empty">Se muestran los 300 más recientes. Usa los filtros para encontrar otros.</div>` : '');
}

function renderCatConfig(p) {
  const exps = expensesIn(p);
  const cats = catsFor(p, exps);
  $('empty-cats').classList.toggle('hidden', cats.length > 0);
  $('cat-config-list').innerHTML = cats.map((c) => {
    const removed = c.archivedFrom && p.key >= c.archivedFrom;
    return `
    <div class="exp-item">
      <div class="exp-left">
        <span class="exp-name">${esc(c.name)} ${removed ? '<span class="badge badge-muted">Quitada</span>' : ''}</span>
        <span class="exp-meta">Límite: ${fmt(limitFor(c, p.key))} · Aviso al ${c.threshold}%</span>
      </div>
      ${removed ? '' : `<div class="exp-right"><button class="btn-small" data-edit-cat="${esc(c.id)}">Editar</button><button class="btn-del" data-del-cat="${esc(c.id)}">Quitar</button></div>`}
    </div>`;
  }).join('');
}

// ── Estadísticas ───────────────────────────────────────────────────────

function pctChange(now, before) {
  if (!before) return null;
  return Math.round(((now - before) / before) * 100);
}
function deltaHtml(d) {
  if (d === null) return '<span class="delta same">—</span>';
  if (d === 0) return '<span class="delta same">igual</span>';
  return `<span class="delta ${d > 0 ? 'up' : 'down'}">${d > 0 ? '▲' : '▼'} ${Math.abs(d)}%</span>`;
}

function renderStats(p) {
  const prev = periodFromStart(p.startYear, p.startMonth - 1);
  const exps = expensesIn(p), prevExps = expensesIn(prev);
  const total = exps.reduce((s, e) => s + e.amount, 0);
  const prevTotal = prevExps.reduce((s, e) => s + e.amount, 0);

  $('st-total').textContent = fmt(total);
  const d = pctChange(total, prevTotal);
  $('st-total-note').innerHTML = d === null ? 'Sin datos del período anterior' : `${deltaHtml(d)} vs. ${esc(MF[prev.startMonth])}`;
  $('st-count').textContent = exps.length;
  $('st-count-note').textContent = `${prevExps.length} en ${MF[prev.startMonth]}`;
  $('st-avg').textContent = fmt(exps.length ? total / exps.length : 0);

  // En qué se fue el dinero
  const cats = catsFor(p, exps).map((c) => ({ c, spent: spentReal(exps, c.id) })).filter((x) => x.spent > 0 || catsFor(p, []).includes(x.c)).sort((a, b) => b.spent - a.spent);
  $('st-dist').innerHTML = total
    ? cats.map(({ c, spent }) => {
      const share = (spent / total) * 100;
      return `<div class="stat-bar-row"><span class="lbl">${esc(c.name)}</span>
        <div class="stat-track"><div class="stat-fill" style="width:${share.toFixed(1)}%;background:${catColor(c.id)}"></div></div>
        <span class="val">${fmtShort(spent)} · ${Math.round(share)}%</span></div>`;
    }).join('')
    : '<div class="empty">Sin gastos en este período.</div>';

  // Últimos 6 períodos
  const series = [];
  for (let i = 5; i >= 0; i--) {
    const q = periodFromStart(p.startYear, p.startMonth - i);
    const qe = expensesIn(q);
    const budget = catsFor(q, qe).reduce((s, c) => s + limitFor(c, q.key), 0);
    series.push({ q, spent: qe.reduce((s, e) => s + e.amount, 0), budget, current: i === 0 });
  }
  const max = Math.max(1, ...series.map((x) => Math.max(x.spent, x.budget)));
  $('st-cols').innerHTML = series.map((x) => `
    <div class="col">
      ${x.budget ? `<div class="col-limit" style="bottom:${(x.budget / max) * 100}%" title="Presupuesto ${fmt(x.budget)}"></div>` : ''}
      <span class="col-val">${x.spent ? fmtShort(x.spent) : ''}</span>
      <div class="col-bar ${x.current ? 'current' : ''} ${x.budget && x.spent > x.budget ? 'over' : ''}" style="height:${(x.spent / max) * 100}%" title="${esc(periodLabel(x.q))}: ${fmt(x.spent)}"></div>
    </div>`).join('');
  $('st-col-labels').innerHTML = series.map((x) => `<span>${MS[x.q.startMonth]}</span>`).join('');

  // Comparado con el período anterior
  const both = categories.filter((c) => catsFor(p, exps).includes(c) || catsFor(prev, prevExps).includes(c));
  $('st-compare').innerHTML = both.length
    ? `<div class="compare-row" style="font-size:11px;color:#888"><span>Categoría</span><span>${esc(MS[prev.startMonth])} → ${esc(MS[p.startMonth])}</span><span style="text-align:right">Cambio</span></div>`
      + both.map((c) => {
        const a = spentReal(prevExps, c.id), b = spentReal(exps, c.id);
        return `<div class="compare-row"><span>${esc(c.name)}</span><span style="color:#666">${fmtShort(a)} → <b style="color:#1a1a1a">${fmtShort(b)}</b></span>${deltaHtml(pctChange(b, a))}</div>`;
      }).join('')
    : '<div class="empty">Sin datos para comparar.</div>';

  // Quién registró más
  const people = users.map((u, i) => {
    const mine = exps.filter((e) => e.userId === u.id);
    return { u, i, total: mine.reduce((s, e) => s + e.amount, 0), count: mine.length };
  });
  const others = exps.filter((e) => !users.some((u) => u.id === e.userId));
  if (others.length) people.push({ u: { displayName: 'Otros' }, i: 2, total: others.reduce((s, e) => s + e.amount, 0), count: others.length });
  $('st-people').innerHTML = people.map((x) => `
    <div class="person">
      <div class="avatar avatar-${x.i % 3}">${esc(x.u.displayName[0] || '?')}</div>
      <div class="big">${fmt(x.total)}</div>
      <div class="small">${esc(x.u.displayName)} · ${x.count} ${x.count === 1 ? 'gasto' : 'gastos'}${total ? ' · ' + Math.round((x.total / total) * 100) + '%' : ''}</div>
    </div>`).join('');
  $('st-split').innerHTML = total ? people.map((x) => `<div style="width:${(x.total / total) * 100}%;background:${USER_COLORS[x.i % USER_COLORS.length]}"></div>`).join('') : '';

  // Los 5 gastos más grandes
  const top = exps.slice().sort((a, b) => b.amount - a.amount).slice(0, 5);
  $('st-top').innerHTML = top.length
    ? top.map((e, i) => `<div class="top-item"><span><span class="top-rank">${i + 1}</span>${esc(e.desc)}<br><span class="exp-meta" style="margin-left:18px">${catLabel(e)} · ${fmtDate(e.date)} · ${esc(userName(e))}</span></span><b>${fmt(e.amount)}</b></div>`).join('')
    : '<div class="empty">Sin gastos en este período.</div>';
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
  if (!body.desc || !(body.amount > 0) || !body.catId || !body.date) { alert('Completa monto, categoría, descripción y fecha.'); return; }
  $('exp-submit').disabled = true;
  try {
    const d = await mutate('/api/gastos', { method: 'POST', body });
    $('exp-desc').value = ''; $('exp-amount').value = '';
    $('exp-other').checked = false; $('exp-charge').classList.add('hidden');
    showConfirm(d.created);
  } catch {} finally { $('exp-submit').disabled = false; }
}

function showConfirm(exp) {
  const p = periodOfDate(exp.date);
  const exps = expensesIn(p);
  $('confirm-title').textContent = `Gasto registrado por ${me.displayName}`;
  $('confirm-sub').textContent = `${exp.desc} — ${fmt(exp.amount)} en ${catName(exp.catId)}`
    + (exp.chargeCatId ? `, descontado de ${catName(exp.chargeCatId)}` : '');
  let totalBudget = 0, totalSpent = 0;
  $('confirm-cats').innerHTML = catsFor(p, exps).map((c) => {
    const spent = spentIn(exps, c.id), lim = limitFor(c, p.key);
    totalBudget += lim; totalSpent += spent;
    const rawPct = lim > 0 ? (spent / lim) * 100 : 0, pct = Math.min(Math.round(rawPct), 100);
    const rem = lim - spent, thr = c.threshold || 80, isThis = c.id === chargeOf(exp);
    let barColor = '#639922', hl = '';
    if (rawPct >= 100) { barColor = '#E24B4A'; hl = 'background:#FEF5F5;border:0.5px solid #F7C1C1;'; }
    else if (rawPct >= thr) { barColor = '#EF9F27'; hl = 'background:#FEFAF0;border:0.5px solid #FAC775;'; }
    else if (isThis) hl = 'background:#F4FAE8;border:0.5px solid #C0DD97;';
    const status = rawPct >= 100
      ? `<span style="color:#A32D2D;font-weight:500">Excedido en ${fmt(Math.abs(rem))}</span>`
      : `<span style="color:${rawPct >= thr ? '#854F0B' : '#3B6D11'};font-weight:${rawPct >= thr ? 500 : 400}">Quedan ${fmt(rem)}</span>`;
    return `<div style="padding:8px 10px;border-radius:8px;${hl}">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">
        <span style="font-size:13px;font-weight:500">${esc(c.name)}${isThis ? ` <span style="font-size:10px;font-weight:400;color:#888">(${exp.chargeCatId ? 'se descontó aquí' : 'este gasto'})</span>` : ''}</span>
        <span style="font-size:12px;font-weight:500">${pct}% usado</span>
      </div>
      <div style="height:6px;background:#eee;border-radius:3px;overflow:hidden;margin-bottom:4px"><div style="height:100%;width:${pct}%;background:${barColor};border-radius:3px"></div></div>
      <div style="display:flex;justify-content:space-between"><span style="font-size:11px;color:#666">${fmt(spent)} de ${fmt(lim)}</span><span style="font-size:11px">${status}</span></div>
    </div>`;
  }).join('');
  $('confirm-period').textContent = periodLabel(p);
  $('confirm-total-avail').textContent = fmt(totalBudget - totalSpent);
  $('confirm-overlay').classList.add('open');
}

function openEditExpense(id) {
  const e = expenses.find((x) => x.id === id); if (!e) return;
  editingExpId = id;
  $('ee-desc').value = e.desc; $('ee-amount').value = e.amount;
  $('ee-cat').innerHTML = catOptions(e.catId); $('ee-date').value = e.date;
  $('ee-other').checked = !!e.chargeCatId;
  fillCharge($('ee-charge'), e.catId, e.chargeCatId);
  $('ee-charge').classList.toggle('hidden', !e.chargeCatId);
  $('edit-exp-overlay').classList.add('open');
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
  if (!confirm(`¿Eliminar "${e.desc}" por ${fmt(e.amount)}?`)) return;
  try { await mutate(`/api/gastos/${encodeURIComponent(id)}`, { method: 'DELETE' }); } catch {}
}

async function addCategory(ev) {
  ev.preventDefault();
  const body = { name: $('cat-name').value.trim(), limit: parseFloat($('cat-limit').value), threshold: parseInt($('cat-threshold').value, 10) || 80, from: getPeriod(periodOffset).key };
  try {
    await mutate('/api/categorias', { method: 'POST', body });
    $('cat-name').value = ''; $('cat-limit').value = ''; $('cat-threshold').value = '80';
    toast('Categoría guardada');
  } catch {}
}

function openEditCategory(id) {
  const c = categories.find((x) => x.id === id); if (!c) return;
  const p = getPeriod(periodOffset);
  editingCatId = id;
  $('ec-name').value = c.name; $('ec-limit').value = limitFor(c, p.key); $('ec-threshold').value = c.threshold;
  $('ec-hint').textContent = `El límite nuevo aplica desde ${periodLabel(p)} en adelante. Los períodos anteriores conservan el suyo. El nombre y el aviso cambian en todos.`;
  $('edit-cat-overlay').classList.add('open');
}

async function saveEditCategory(ev) {
  ev.preventDefault();
  const body = { name: $('ec-name').value.trim(), limit: parseFloat($('ec-limit').value), threshold: parseInt($('ec-threshold').value, 10), from: getPeriod(periodOffset).key };
  try { await mutate(`/api/categorias/${encodeURIComponent(editingCatId)}`, { method: 'PUT', body }); closeOverlays(); toast('Cambios guardados'); } catch {}
}

async function deleteCategory(id) {
  const c = categories.find((x) => x.id === id); if (!c) return;
  const p = getPeriod(periodOffset);
  const used = expenses.some((e) => e.catId === id || e.chargeCatId === id);
  const text = used
    ? `¿Quitar "${c.name}" desde ${periodLabel(p)}?\n\nLos períodos anteriores la siguen mostrando con sus gastos.`
    : `¿Eliminar "${c.name}"? No tiene gastos registrados.`;
  if (!confirm(text)) return;
  try { await mutate(`/api/categorias/${encodeURIComponent(id)}`, { method: 'DELETE', body: { from: p.key } }); } catch {}
}

async function importFirebase() {
  const btn = $('btn-import'), msg = $('import-msg');
  btn.disabled = true; msg.className = 'msg'; msg.textContent = 'Trayendo datos…';
  try {
    const d = await api('/api/importar-firebase', { method: 'POST' });
    applyData(d);
    const r = d.resultado;
    msg.className = 'msg info';
    msg.textContent = `Listo. En Firebase había ${r.enFirebase.gastos} gastos y ${r.enFirebase.categorias} categorías. Se agregaron ${r.gastos} gastos y ${r.categorias} categorías nuevas; lo demás ya estaba.`;
  } catch (e) {
    msg.className = 'msg error'; msg.textContent = e.message;
  } finally { btn.disabled = false; }
}

function closeOverlays() { document.querySelectorAll('.overlay').forEach((o) => o.classList.remove('open')); }

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

function showApp() {
  $('login-screen').classList.add('hidden');
  $('main-app').classList.remove('hidden');
  $('user-label').textContent = me.displayName;
  $('exp-date').value = todayLocal();
  loadData();
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
  if (!confirm('¿Cerrar sesión en este dispositivo?')) return;
  try { await api('/api/salir', { method: 'POST' }); } catch {}
  me = null; showLogin();
}

// ── Arranque ───────────────────────────────────────────────────────────

function bindEvents() {
  $('login-form').addEventListener('submit', doLogin);
  $('login-reset').addEventListener('click', resetPassword);
  $('user-pill').addEventListener('click', doLogout);
  document.querySelectorAll('[data-period]').forEach((b) => b.addEventListener('click', () => changePeriod(Number(b.dataset.period))));
  $('btn-hoy').addEventListener('click', () => { periodOffset = 0; renderAll(); });
  $('tabs').addEventListener('click', (e) => { const t = e.target.closest('[data-tab]'); if (t) showTab(t.dataset.tab); });
  $('exp-form').addEventListener('submit', addExpense);
  $('mini-summary').addEventListener('click', (e) => { const g = e.target.closest('[data-go]'); if (g) { e.preventDefault(); showTab(g.dataset.go); } });
  // "Descontar de otra categoría": mostrar u ocultar la lista y no ofrecer la misma categoría.
  for (const [chk, cat, chg] of [['exp-other', 'exp-cat', 'exp-charge'], ['ee-other', 'ee-cat', 'ee-charge']]) {
    $(chk).addEventListener('change', () => { fillCharge($(chg), $(cat).value, $(chg).value); $(chg).classList.toggle('hidden', !$(chk).checked); });
    $(cat).addEventListener('change', () => fillCharge($(chg), $(cat).value, $(chg).value));
  }
  $('cat-form').addEventListener('submit', addCategory);
  $('edit-exp-form').addEventListener('submit', saveEditExpense);
  $('edit-cat-form').addEventListener('submit', saveEditCategory);
  $('confirm-close').addEventListener('click', closeOverlays);
  document.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', closeOverlays));
  document.querySelectorAll('.overlay').forEach((o) => o.addEventListener('click', (e) => { if (e.target === o) closeOverlays(); }));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeOverlays(); });
  $('expense-list').addEventListener('click', (e) => {
    const ed = e.target.closest('[data-edit-exp]'); if (ed) return openEditExpense(ed.dataset.editExp);
    const dl = e.target.closest('[data-del-exp]'); if (dl) return deleteExpense(dl.dataset.delExp);
  });
  $('cat-config-list').addEventListener('click', (e) => {
    const ed = e.target.closest('[data-edit-cat]'); if (ed) return openEditCategory(ed.dataset.editCat);
    const dl = e.target.closest('[data-del-cat]'); if (dl) return deleteCategory(dl.dataset.delCat);
  });
  ['f-text', 'f-cat', 'f-user', 'f-all'].forEach((id) => $(id).addEventListener('input', () => renderGastos(getPeriod(periodOffset))));
  $('btn-export-global').addEventListener('click', exportGlobal);
  $('btn-export-cat').addEventListener('click', exportPorCategoria);
  $('btn-import').addEventListener('click', importFirebase);

  // Mantener los datos al día entre los dos.
  setInterval(() => { if (me && document.visibilityState === 'visible') loadData(); }, 30000);
  document.addEventListener('visibilitychange', () => { if (me && document.visibilityState === 'visible') loadData(); });
}

async function start() {
  bindEvents();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
  try {
    estado = await api('/api/estado');
  } catch (e) {
    estado = { problema: e.message };
  }
  if (estado.user) { me = estado.user; showApp(); }
  else showLogin();
}

start();
