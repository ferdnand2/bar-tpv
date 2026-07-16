// Frontend del sistema del bar. Vanilla JS, sin dependencias.
'use strict';

const $ = sel => document.querySelector(sel);
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
const fmt = n => n.toLocaleString('es-ES', { style: 'currency', currency: 'EUR' });
const fmtDT = iso => new Date(iso).toLocaleString('es-ES', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
const fmtTime = iso => new Date(iso).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });

let state = {
  config: {}, locales: [], areas: [], tables: [], priceLists: [],
  products: [], orders: [], pendingSales: [], lastClose: null,
};
let currentOrderId = null;
let currentCategory = null;
let currentLocalId = null;
let currentPriceListId = null;
let currentStationId = null;
let supervisorPin = null; // clave validada en esta sesión
let invSort = { key: 'category', dir: 1 };
let plSort = { key: 'category', dir: 1 };
let layoutEdit = false; // modo «dibujar distribución»: arrastrar mesas en el plano
let draggingTable = false; // no re-renderizar mientras se arrastra una mesa

// ?carta=base | ?carta=<idLista>: modo carta pública (solo lectura, para clientes vía QR)
const cartaParam = new URLSearchParams(location.search).get('carta');

// Estados de una línea de comanda, en orden. 'borrador' = sin enviar aún a preparación.
const LINE_STATUSES = ['borrador', 'pedido', 'procesando', 'listo', 'entregado'];
const STATUS_INFO = {
  borrador:   { icon: '📝', label: 'Sin enviar' },
  pedido:     { icon: '🕓', label: 'Pedido' },
  procesando: { icon: '👨‍🍳', label: 'Procesando' },
  listo:      { icon: '🛎️', label: 'Listo para llevar' },
  entregado:  { icon: '✔', label: 'Entregado' },
};

// ---------- API ----------

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 403) supervisorPin = null; // clave incorrecta o cambiada
    throw new Error(data.error || `Error ${res.status}`);
  }
  return data;
}

async function refresh() {
  state = await api('GET', '/api/state');
  render();
}

// ---------- Utilidades ----------

let toastTimer;
function toast(msg, isError = false) {
  const el = $('#toast');
  el.textContent = msg;
  el.className = 'toast' + (isError ? ' error' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 3000);
}

function handle(err) { toast(err.message, true); }

function findTable(id) { return state.tables.find(t => t.id === id); }
function findArea(id) { return state.areas.find(a => a.id === id); }
function findLocal(id) { return state.locales.find(l => l.id === id); }
function findPriceList(id) { return state.priceLists.find(l => l.id === id); }

function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function plVigente(pl) {
  const today = todayISO();
  return (!pl.validFrom || today >= pl.validFrom) && (!pl.validUntil || today <= pl.validUntil);
}

function tableLabel(tableId) {
  const t = findTable(tableId);
  if (!t) return '¿?';
  const a = findArea(t.areaId);
  const parts = [a && a.name, t.name].filter(Boolean);
  if (state.locales.length > 1 && a) {
    const l = findLocal(a.localId);
    if (l) parts.unshift(l.name);
  }
  return parts.join(' · ');
}

function priceFor(order, product) {
  if (order && order.priceListId != null) {
    const pl = findPriceList(order.priceListId);
    if (pl && plVigente(pl) && pl.prices[product.id] != null) return pl.prices[product.id];
  }
  return product.price;
}

// Mesero activo: se elige en la cabecera y se recuerda en este dispositivo.
function currentWaiter() {
  const w = localStorage.getItem('bar-tpv-waiter') || '';
  return (state.config.waiters || []).includes(w) ? w : '';
}

function renderWaiterSel() {
  const waiters = state.config.waiters || [];
  $('#waiterWrap').classList.toggle('hidden', !waiters.length || cartaParam != null);
  $('#waiterSel').innerHTML = '<option value="">— Mesero —</option>' +
    waiters.map(w => `<option ${w === currentWaiter() ? 'selected' : ''}>${esc(w)}</option>`).join('');
}

$('#waiterSel').addEventListener('change', e => localStorage.setItem('bar-tpv-waiter', e.target.value));

// Clave de supervisor: se pide una vez y se recuerda mientras dure la sesión.
async function askSupervisor() {
  if (supervisorPin !== null) return supervisorPin;
  const pin = prompt('Clave de supervisor:');
  if (pin === null) return null;
  try {
    await api('POST', '/api/supervisor/check', { pin });
    supervisorPin = pin;
    return pin;
  } catch (err) { handle(err); return null; }
}

// Impresión de documentos (informes, cartas, QR): rellena #printArea y lanza el diálogo.
function printDoc(html) {
  $('#printArea').innerHTML = html;
  document.body.dataset.print = 'doc';
  window.print();
  delete document.body.dataset.print;
}

// Ordenación genérica por columna para las tablas de productos.
function sortRows(rows, sort) {
  return rows.slice().sort((a, b) => {
    const va = a[sort.key], vb = b[sort.key];
    let c = typeof va === 'string' ? va.localeCompare(vb) : va - vb;
    if (!c) c = a.name.localeCompare(b.name);
    return c * sort.dir;
  });
}

function markSortedHeaders(tableSel, sort) {
  document.querySelectorAll(`${tableSel} th[data-sort]`).forEach(th => {
    th.classList.toggle('sorted-asc', sort.key === th.dataset.sort && sort.dir === 1);
    th.classList.toggle('sorted-desc', sort.key === th.dataset.sort && sort.dir === -1);
  });
}

// ---------- Navegación ----------

document.querySelectorAll('nav .tab').forEach(btn => {
  btn.addEventListener('click', async () => {
    if (btn.dataset.view === 'ajustes') {
      const pin = await askSupervisor(); // Ajustes solo con clave de supervisor
      if (pin === null) return;
    }
    document.querySelectorAll('nav .tab').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    document.querySelectorAll('.view').forEach(v => v.classList.add('hidden'));
    $('#view-' + btn.dataset.view).classList.remove('hidden');
    if (btn.dataset.view === 'caja') renderCaja();
    if (btn.dataset.view === 'preparacion') renderPrep();
  });
});

// ---------- Render general ----------

function render() {
  if (draggingTable) return; // no tocar el DOM en mitad de un arrastre
  $('#barName').textContent = state.config.nombreBar || 'Mi Bar';
  if (cartaParam != null) { renderCarta(); return; } // modo carta pública: nada más que renderizar
  renderWaiterSel();
  renderTables();
  renderPrep();
  renderInventory();
  renderPriceLists();
  renderAjustes();
  renderLowStockBadge();
  if (currentOrderId !== null) {
    const order = state.orders.find(o => o.id === currentOrderId);
    if (order) renderOrderPanel(order);
    else closeOrderPanel();
  }
}

function renderLowStockBadge() {
  const low = state.products.filter(p => p.active && !p.openPrice && p.stock <= p.minStock).length;
  const badge = $('#lowStockBadge');
  badge.textContent = low;
  badge.classList.toggle('hidden', low === 0);
}

// ---------- Mesas ----------

function renderTables() {
  // Pestañas de locales (solo si hay más de uno)
  if (!currentLocalId || !findLocal(currentLocalId)) currentLocalId = state.locales[0] && state.locales[0].id;
  const tabs = $('#localTabs');
  tabs.innerHTML = '';
  tabs.classList.toggle('hidden', state.locales.length <= 1);
  for (const l of state.locales) {
    const b = document.createElement('button');
    b.textContent = l.name;
    b.className = l.id === currentLocalId ? 'active' : '';
    b.addEventListener('click', () => { currentLocalId = l.id; renderTables(); });
    tabs.appendChild(b);
  }

  const container = $('#areasContainer');
  container.innerHTML = '';
  container.classList.toggle('layout-edit', layoutEdit);
  const areas = state.areas.filter(a => a.localId === currentLocalId);
  if (!areas.length) {
    container.innerHTML = '<p class="hint">Este local no tiene áreas. Créalas en Ajustes.</p>';
    return;
  }
  for (const area of areas) {
    // Las áreas sin mesas (temporales o conceptuales, como Cocina) no se muestran aquí.
    const tables = state.tables.filter(t => t.areaId === area.id);
    if (!tables.length) continue;

    const pl = area.priceListId != null && findPriceList(area.priceListId);
    const h = document.createElement('h3');
    h.className = 'area-title';
    h.innerHTML = esc(area.name) + (pl ? ` <span class="muted">(tarifa: ${esc(pl.name)}${plVigente(pl) ? '' : ' — no vigente'})</span>` : '');

    // Plano del área: si alguna mesa tiene posición (o se está editando) se dibuja la
    // distribución real; si no, la cuadrícula clásica.
    const hasLayout = tables.some(t => t.posX != null);
    const usePlan = layoutEdit || hasLayout;

    if (layoutEdit && hasLayout) {
      const rb = document.createElement('button');
      rb.className = 'btn-plain btn-mini';
      rb.textContent = '▦ Quitar plano';
      rb.title = 'Olvidar las posiciones y volver a la cuadrícula';
      rb.addEventListener('click', async () => {
        if (!confirm(`¿Quitar el plano del área "${area.name}" y volver a la cuadrícula?`)) return;
        try {
          for (const t of tables) {
            if (t.posX != null) await api('PUT', `/api/tables/${t.id}`, { posX: null, posY: null });
          }
          await api('PUT', `/api/areas/${area.id}`, { planW: null, planH: null }); // tamaño por defecto
          await refresh();
        } catch (err) { handle(err); }
      });
      h.appendChild(rb);
    }
    container.appendChild(h);

    const grid = document.createElement('div');
    grid.className = usePlan ? 'area-plan' : 'tables-grid';
    if (usePlan) {
      // Tamaño del lienzo configurable por área (ancho en %, alto en px)
      grid.style.width = (area.planW != null ? area.planW : 100) + '%';
      grid.style.height = (area.planH != null ? area.planH : 380) + 'px';
      if (layoutEdit) makeResizable(grid, area);
    }
    tables.forEach((t, i) => {
      const order = state.orders.find(o => o.tableId === t.id);
      const btn = document.createElement('button');
      // Mesa con comanda: verde si hay pedido pendiente a tiempo, amarillo si supera
      // «Alto», rojo si supera «Demasiado», azul si ya está todo atendido (entregado).
      // Sin comanda (o ya pagada): aspecto normal.
      let level = '';
      if (order) {
        const lvl = orderDelayLevel(order);
        if (lvl === 'late' || lvl === 'warn') level = ' time-' + lvl;
        else if (order.items.length && order.items.every(it => it.status === 'entregado')) level = ' time-done';
        else level = ' time-ok';
      }
      btn.className = 'table-btn' + (order ? ' occupied' + level : '');
      const total = order ? order.items.reduce((s, it) => s + it.price * it.qty, 0) : 0;
      btn.innerHTML = `<span>${t.seats === 1 ? '🪑' : '🍽'} ${esc(t.name)}</span>` +
        `<span class="seats">${t.seats} ${t.seats === 1 ? 'puesto' : 'puestos'}</span>` +
        (t.note ? `<span class="table-note">${esc(t.note)}</span>` : '') +
        (order ? `<span class="amount">${fmt(total)}</span>` : '<span class="amount">&nbsp;</span>');
      if (usePlan) {
        // Las mesas aún sin ubicar se reparten provisionalmente hasta que se arrastren.
        btn.style.left = (t.posX != null ? t.posX : 4 + (i % 5) * 19) + '%';
        btn.style.top = (t.posY != null ? t.posY : 4 + Math.floor(i / 5) * 26) + '%';
      }
      if (layoutEdit) makeDraggable(btn, t, grid);
      else btn.addEventListener('click', () => openTable(t.id));
      grid.appendChild(btn);
    });
    container.appendChild(grid);
  }
  if (!container.children.length) {
    container.innerHTML = '<p class="hint">Este local no tiene mesas. Créalas en Ajustes (las áreas sin mesas no se muestran aquí).</p>';
  }
}

// Tirador en la esquina del plano para cambiar su tamaño arrastrando (ratón o táctil).
// El ancho se guarda en % del espacio disponible y el alto en px.
function makeResizable(plan, area) {
  const grip = document.createElement('div');
  grip.className = 'plan-resize';
  grip.title = 'Arrastra para cambiar el tamaño del plano';
  grip.addEventListener('pointerdown', e => {
    e.preventDefault();
    e.stopPropagation();
    grip.setPointerCapture(e.pointerId);
    draggingTable = true;
    const parentW = plan.parentElement.getBoundingClientRect().width;
    const startRect = plan.getBoundingClientRect();
    const startX = e.clientX, startY = e.clientY;
    let w = startRect.width, h = startRect.height, moved = false;
    const onMove = ev => {
      moved = true;
      w = Math.max(parentW * 0.2, Math.min(parentW, startRect.width + ev.clientX - startX));
      h = Math.max(180, Math.min(2000, startRect.height + ev.clientY - startY));
      plan.style.width = (w / parentW * 100) + '%';
      plan.style.height = h + 'px';
    };
    const done = async ev => {
      grip.removeEventListener('pointermove', onMove);
      grip.removeEventListener('pointerup', done);
      grip.removeEventListener('pointercancel', done);
      draggingTable = false;
      if (moved && ev.type === 'pointerup') {
        try {
          await api('PUT', `/api/areas/${area.id}`, {
            planW: Math.round((w / parentW) * 1000) / 10,
            planH: Math.round(h),
          });
          await refresh();
        } catch (err) { handle(err); await refresh(); }
      }
    };
    grip.addEventListener('pointermove', onMove);
    grip.addEventListener('pointerup', done);
    grip.addEventListener('pointercancel', done);
  });
  plan.appendChild(grip);
}

// Arrastrar y soltar una mesa dentro del plano de su área (ratón o táctil).
// La posición se guarda en % del lienzo, así el plano es responsive.
function makeDraggable(btn, t, plan) {
  btn.addEventListener('pointerdown', e => {
    e.preventDefault();
    btn.setPointerCapture(e.pointerId);
    const planRect = plan.getBoundingClientRect();
    const btnRect = btn.getBoundingClientRect();
    const offX = e.clientX - btnRect.left;
    const offY = e.clientY - btnRect.top;
    let moved = false;
    draggingTable = true;
    const onMove = ev => {
      moved = true;
      let x = ((ev.clientX - offX - planRect.left) / planRect.width) * 100;
      let y = ((ev.clientY - offY - planRect.top) / planRect.height) * 100;
      x = Math.max(0, Math.min(x, 100 - (btnRect.width / planRect.width) * 100));
      y = Math.max(0, Math.min(y, 100 - (btnRect.height / planRect.height) * 100));
      btn.style.left = x + '%';
      btn.style.top = y + '%';
      btn.dataset.px = x.toFixed(1);
      btn.dataset.py = y.toFixed(1);
    };
    const done = async ev => {
      btn.removeEventListener('pointermove', onMove);
      btn.removeEventListener('pointerup', done);
      btn.removeEventListener('pointercancel', done);
      draggingTable = false;
      if (moved && ev.type === 'pointerup') {
        try {
          await api('PUT', `/api/tables/${t.id}`, { posX: btn.dataset.px, posY: btn.dataset.py });
          await refresh();
        } catch (err) { handle(err); await refresh(); }
      }
    };
    btn.addEventListener('pointermove', onMove);
    btn.addEventListener('pointerup', done);
    btn.addEventListener('pointercancel', done);
  });
}

$('#btnLayout').addEventListener('click', () => {
  layoutEdit = !layoutEdit;
  const b = $('#btnLayout');
  b.textContent = layoutEdit ? '✔ Terminar' : '✏️ Distribución';
  b.classList.toggle('btn-primary', layoutEdit);
  b.classList.toggle('btn-plain', !layoutEdit);
  $('#layoutHint').classList.toggle('hidden', !layoutEdit);
  renderTables();
});

async function openTable(tableId) {
  try {
    let order = state.orders.find(o => o.tableId === tableId);
    if (!order) {
      order = await api('POST', '/api/orders', { tableId });
      state.orders.push(order);
    }
    currentOrderId = order.id;
    currentCategory = null;
    renderOrderPanel(order);
    $('#orderPanel').classList.remove('hidden');
  } catch (err) { handle(err); }
}

function closeOrderPanel() {
  // Si la comanda quedó vacía, se elimina para liberar la mesa
  const order = state.orders.find(o => o.id === currentOrderId);
  if (order && !order.items.length) {
    api('DELETE', `/api/orders/${order.id}`).then(refresh).catch(() => {});
    state.orders = state.orders.filter(o => o.id !== order.id);
  }
  currentOrderId = null;
  $('#orderPanel').classList.add('hidden');
  render();
}

$('#closePanel').addEventListener('click', closeOrderPanel);

function renderOrderPanel(order) {
  $('#orderTitle').textContent = tableLabel(order.tableId);

  // Descripción de la mesa (ayuda a los meseros); toca para editar
  const table = findTable(order.tableId);
  const noteEl = $('#orderNote');
  noteEl.textContent = table && table.note ? '📝 ' + table.note : '📝 Añadir descripción de la mesa…';
  noteEl.classList.toggle('empty', !(table && table.note));
  noteEl.onclick = async () => {
    if (!table) return;
    const v = prompt('Descripción de la mesa (p. ej. «mesa de Roberto», «unida con la mesa 6»):', table.note || '');
    if (v === null) return;
    try { await api('PUT', `/api/tables/${table.id}`, { note: v }); await refresh(); }
    catch (err) { handle(err); }
  };

  // Selector de tarifa de la comanda
  const sel = $('#orderPriceList');
  sel.innerHTML = '<option value="">Precios base</option>' +
    state.priceLists.map(l => `<option value="${l.id}" ${l.id === order.priceListId ? 'selected' : ''}>${esc(l.name)}${plVigente(l) ? '' : ' (no vigente)'}</option>`).join('');
  sel.onchange = async () => {
    try {
      const updated = await api('PUT', `/api/orders/${order.id}/pricelist`, { priceListId: sel.value || null });
      Object.assign(order, updated);
      await refresh();
    } catch (err) { handle(err); }
  };

  // Categorías
  const cats = [...new Set(state.products.filter(p => p.active).map(p => p.category))];
  if (!currentCategory || !cats.includes(currentCategory)) currentCategory = cats[0] || null;
  const tabs = $('#categoryTabs');
  tabs.innerHTML = '';
  for (const c of cats) {
    const b = document.createElement('button');
    b.textContent = c;
    b.className = c === currentCategory ? 'active' : '';
    b.addEventListener('click', () => { currentCategory = c; renderOrderPanel(order); });
    tabs.appendChild(b);
  }

  // Productos de la categoría, con el precio de la tarifa activa
  const box = $('#productButtons');
  box.innerHTML = '';
  for (const p of state.products.filter(p => p.active && p.category === currentCategory)) {
    const b = document.createElement('button');
    if (p.openPrice) {
      b.innerHTML = `${esc(p.name)}<span class="price">precio libre</span>`;
      b.addEventListener('click', () => openPriceAsk(p));
    } else {
      b.innerHTML = `${esc(p.name)}<span class="price">${fmt(priceFor(order, p))}</span>` +
        (p.stock <= p.minStock ? `<span class="stock-low">quedan ${p.stock}</span>` : '');
      b.disabled = p.stock <= 0;
      b.addEventListener('click', async () => {
        try {
          await api('POST', `/api/orders/${order.id}/items`, { productId: p.id, waiter: currentWaiter() });
          await refresh();
        } catch (err) { handle(err); }
      });
    }
    box.appendChild(b);
  }

  // Líneas de la comanda, con su estado visible (transparencia para el cliente).
  // Desde la mesa NO se avanzan estados (eso se hace en Preparación): tocar el chip
  // de una línea significa anularla, con confirmación; quitar unidades de una línea
  // ya en preparación exige clave de supervisor (lo comprueba también el servidor).
  const list = $('#itemsList');
  list.innerHTML = '';
  let total = 0;
  let drafts = 0;
  for (const it of order.items) {
    total += it.price * it.qty;
    if (it.status === 'borrador') drafts++;
    const st = STATUS_INFO[it.status] || STATUS_INFO.borrador;
    const who = it.status === 'entregado' && it.deliveredBy ? ` por ${it.deliveredBy}`
      : it.orderedBy ? ` · pedido por ${it.orderedBy}` : '';
    const li = document.createElement('li');
    li.innerHTML = `<button class="qty-btn" data-act="minus">−</button>` +
      `<span>${it.qty}</span>` +
      `<button class="qty-btn" data-act="plus">+</button>` +
      `<span class="name">${esc(it.name)}</span>` +
      `<button class="status-chip st-${esc(it.status)}" title="${esc(`${st.label}${who} — toca para anular`)}">${st.icon} ${st.label}</button>` +
      `<span>${fmt(it.price * it.qty)}</span>`;
    li.querySelector('[data-act="minus"]').addEventListener('click', () => cancelLine(order, it, 1));
    li.querySelector('[data-act="plus"]').addEventListener('click', async () => {
      try {
        // Si la línea ya se envió, el servidor crea una línea nueva en borrador.
        await api('PUT', `/api/orders/${order.id}/items/${it.lineId}`, { qtyDelta: 1, waiter: currentWaiter() });
        await refresh();
      } catch (err) { handle(err); }
    });
    li.querySelector('.status-chip').addEventListener('click', () => cancelLine(order, it));
    list.appendChild(li);
  }
  $('#orderTotal').textContent = fmt(total);

  // Enviar pedido: confirma las líneas en borrador y las manda a preparación
  const sendBtn = $('#btnSendOrder');
  sendBtn.classList.toggle('hidden', drafts === 0);
  sendBtn.textContent = `📤 Enviar pedido (${drafts})`;
}

// Anular unidades de una línea desde la comanda. Sin `units` (chip de estado):
// pregunta cuántas si hay varias, o pide confirmación si es una. Con `units` (botón −):
// en borrador es edición rápida sin confirmar; en líneas ya enviadas confirma.
// Anular algo ya en preparación (procesando o después) exige clave de supervisor.
async function cancelLine(order, it, units) {
  let n = units;
  if (n == null) {
    if (it.qty > 1) {
      const v = prompt(`¿Cuántas unidades de «${it.name}» quieres anular? (1-${it.qty})`, String(it.qty));
      if (v === null) return;
      n = parseInt(v, 10);
      if (!Number.isInteger(n) || n < 1 || n > it.qty) { toast('Cantidad inválida', true); return; }
    } else {
      if (!confirm(`¿Anular «${it.name}»?`)) return;
      n = 1;
    }
  } else if (it.status !== 'borrador') {
    if (!confirm(`¿Anular 1 × «${it.name}»?`)) return;
  }
  const body = { qtyDelta: -n };
  if (it.status !== 'borrador' && it.status !== 'pedido') {
    const pin = await askSupervisor(); // ya en preparación: anular exige clave
    if (pin === null) return;
    body.pin = pin;
  }
  try {
    await api('PUT', `/api/orders/${order.id}/items/${it.lineId}`, body);
    await refresh();
    if (it.status !== 'borrador') toast(`Anulado: ${n} × ${it.name}`);
  } catch (err) { handle(err); }
}

$('#btnSendOrder').addEventListener('click', async () => {
  const order = state.orders.find(o => o.id === currentOrderId);
  if (!order) return;
  try {
    const r = await api('POST', `/api/orders/${order.id}/send`, { waiter: currentWaiter() });
    await refresh();
    toast(`Pedido enviado (${r.sent} línea${r.sent === 1 ? '' : 's'})`);
  } catch (err) { handle(err); }
});

// QR de esta mesa, imprimible desde la propia comanda
$('#btnTableQR').addEventListener('click', () => {
  const order = state.orders.find(o => o.id === currentOrderId);
  const table = order && findTable(order.tableId);
  if (!table) return;
  printDoc(`<h1>${esc(state.config.nombreBar || 'Mi Bar')} — Código QR de mesa</h1>
    <p>Coloca este código en la mesa: al escanearlo se abre su comanda.</p>
    <div class="qr-grid">${tableQRBlock(table)}</div>`);
});

// Producto de precio libre: pide descripción y precio al añadirlo
let openPriceProductId = null;
function openPriceAsk(product) {
  openPriceProductId = product.id;
  const f = $('#openPriceForm');
  f.reset();
  $('#openPriceTitle').textContent = product.name;
  f.elements.name.placeholder = product.name;
  f.elements.price.value = product.price > 0 ? product.price : '';
  $('#openPriceDialog').showModal();
}

$('#openPriceForm').addEventListener('submit', async e => {
  e.preventDefault();
  const f = e.target;
  $('#openPriceDialog').close();
  const order = state.orders.find(o => o.id === currentOrderId);
  if (!order || openPriceProductId == null) return;
  try {
    await api('POST', `/api/orders/${order.id}/items`, {
      productId: openPriceProductId,
      qty: 1,
      price: f.elements.price.value,
      name: f.elements.name.value,
      waiter: currentWaiter(),
    });
    await refresh();
  } catch (err) { handle(err); }
});
$('#openPriceCancel').addEventListener('click', () => $('#openPriceDialog').close());

$('#btnCancelOrder').addEventListener('click', async () => {
  const order = state.orders.find(o => o.id === currentOrderId);
  if (!order) return;
  if (order.items.length && !confirm('¿Anular la comanda? El stock se devolverá al inventario.')) return;
  const body = {};
  if (order.items.some(it => it.status !== 'borrador' && it.status !== 'pedido')) {
    const pin = await askSupervisor(); // hay líneas en preparación: anular exige clave
    if (pin === null) return;
    body.pin = pin;
  }
  try {
    await api('DELETE', `/api/orders/${order.id}`, body);
    currentOrderId = null;
    $('#orderPanel').classList.add('hidden');
    await refresh();
  } catch (err) { handle(err); }
});

async function doPay(method, card) {
  const order = state.orders.find(o => o.id === currentOrderId);
  if (!order) return;
  try {
    const sale = await api('POST', `/api/orders/${order.id}/pay`, { method, card });
    currentOrderId = null;
    $('#orderPanel').classList.add('hidden');
    await refresh();
    toast(`Cobrado ${fmt(sale.total)} (${method})`);
    printTicket(sale);
  } catch (err) { handle(err); }
}

$('#btnPayCash').addEventListener('click', () => doPay('efectivo', null));

// Pago con tarjeta: se registra el POS, el código de transacción y una referencia opcional
$('#btnPayCard').addEventListener('click', () => {
  const order = state.orders.find(o => o.id === currentOrderId);
  if (!order || !order.items.length) { toast('La comanda está vacía', true); return; }
  const f = $('#cardForm');
  f.reset();
  const terminals = state.config.posTerminals || [];
  $('#posDatalist').innerHTML = terminals.map(t => `<option value="${esc(t)}">`).join('');
  f.elements.pos.value = terminals[0] || '';
  $('#cardDialog').showModal();
});

$('#cardForm').addEventListener('submit', e => {
  e.preventDefault();
  const fd = Object.fromEntries(new FormData(e.target));
  $('#cardDialog').close();
  doPay('tarjeta', fd);
});
$('#cardCancel').addEventListener('click', () => $('#cardDialog').close());

// ---------- Ticket ----------

function printTicket(sale) {
  const iva = state.config.ivaPct || 0;
  const base = sale.total / (1 + iva / 100);
  const el = $('#ticket');
  el.innerHTML = `
    <h2>${esc(state.config.nombreBar || 'Mi Bar')}</h2>
    <p class="center">${new Date(sale.paidAt).toLocaleString('es-ES')}</p>
    <p class="center">${esc(sale.tableLabel)}</p>
    ${sale.priceListName ? `<p class="center">Tarifa: ${esc(sale.priceListName)}</p>` : ''}
    <div class="sep"></div>
    <table>
      ${sale.items.map(it => `<tr><td>${it.qty} x ${esc(it.name)}</td><td>${fmt(it.price * it.qty)}</td></tr>`).join('')}
    </table>
    <div class="sep"></div>
    <table>
      <tr><td>Base imponible</td><td>${fmt(base)}</td></tr>
      <tr><td>IVA (${iva}%)</td><td>${fmt(sale.total - base)}</td></tr>
      <tr class="big"><td>TOTAL</td><td>${fmt(sale.total)}</td></tr>
      <tr><td>Pago</td><td>${sale.method}</td></tr>
      ${sale.card ? `<tr><td>POS</td><td>${esc(sale.card.pos)}</td></tr>
      <tr><td>Transacción</td><td>${esc(sale.card.code)}</td></tr>
      ${sale.card.ref ? `<tr><td>Referencia</td><td>${esc(sale.card.ref)}</td></tr>` : ''}` : ''}
    </table>
    <div class="sep"></div>
    <p class="center">¡Gracias por su visita!</p>`;
  if (confirm('¿Imprimir ticket?')) {
    document.body.dataset.print = 'ticket';
    window.print();
    delete document.body.dataset.print;
  }
}

// ---------- Preparación (cocina / bar) ----------

// Líneas de comandas abiertas en curso (enviadas y aún no entregadas), enrutadas
// por categoría -> área. Las líneas en borrador no aparecen: aún no se han enviado.
function stationPending() {
  const cs = state.config.categoryStations || {};
  const out = [];
  for (const o of state.orders) {
    for (const it of o.items) {
      const areaId = cs[it.category];
      if (areaId != null && ['pedido', 'procesando', 'listo'].includes(it.status) && it.qty > 0) {
        out.push({ order: o, item: it, areaId });
      }
    }
  }
  return out;
}

// Nivel de retraso de una línea en curso según los tiempos de su categoría:
// 'late' (rojo) si supera «Demasiado», 'warn' (amarillo) si supera «Alto»,
// 'ok' (verde) si va a tiempo; null si la línea no está en curso.
function lineDelayLevel(it) {
  if (!['pedido', 'procesando', 'listo'].includes(it.status)) return null;
  const t = (state.config.categoryTimes || {})[it.category];
  if (!t) return 'ok';
  const mins = (Date.now() - new Date(it.sentAt || it.addedAt).getTime()) / 60000;
  if (t.demasiado != null && mins >= t.demasiado) return 'late';
  if (t.alto != null && mins >= t.alto) return 'warn';
  return 'ok';
}

// Peor nivel de retraso de una comanda (null si no tiene líneas en curso).
function orderDelayLevel(order) {
  let level = null;
  for (const it of order.items) {
    const l = lineDelayLevel(it);
    if (l === 'late') return 'late';
    if (l === 'warn') level = 'warn';
    else if (l === 'ok' && level === null) level = 'ok';
  }
  return level;
}

// Acción siguiente de cada estado en la pantalla de preparación.
const PREP_NEXT = {
  pedido:     { status: 'procesando', label: '👨‍🍳 Preparar' },
  procesando: { status: 'listo', label: '✔ Listo' },
  listo:      { status: 'entregado', label: '🛎 Llevado al cliente' },
};

function renderPrep() {
  const pending = stationPending();
  const badge = $('#prepBadge');
  badge.textContent = pending.length;
  badge.classList.toggle('hidden', pending.length === 0);

  const cs = state.config.categoryStations || {};
  const areas = [...new Set(Object.values(cs))].map(findArea).filter(Boolean);
  const tabs = $('#prepTabs');
  const container = $('#prepContainer');
  if (!areas.length) {
    tabs.innerHTML = '';
    container.innerHTML = '<p class="hint">No hay áreas de preparación configuradas. En Ajustes → «Envío de comandas por categoría», asigna cada categoría a un área (p. ej. las comidas a Cocina y las bebidas a Barra).</p>';
    return;
  }
  if (!currentStationId || !areas.some(a => a.id === currentStationId)) currentStationId = areas[0].id;
  tabs.innerHTML = '';
  for (const a of areas) {
    const count = pending.filter(x => x.areaId === a.id).length;
    const b = document.createElement('button');
    b.textContent = a.name + (count ? ` (${count})` : '');
    b.className = a.id === currentStationId ? 'active' : '';
    b.addEventListener('click', () => { currentStationId = a.id; renderPrep(); });
    tabs.appendChild(b);
  }

  const lines = pending.filter(x => x.areaId === currentStationId)
    .sort((a, b) => String(a.item.addedAt).localeCompare(String(b.item.addedAt)));
  container.innerHTML = '';
  if (!lines.length) {
    container.innerHTML = '<p class="hint">Nada pendiente. 👍</p>';
    return;
  }
  const ul = document.createElement('ul');
  ul.className = 'prep-list';
  for (const { order, item } of lines) {
    const t = findTable(order.tableId);
    const st = STATUS_INFO[item.status];
    const next = PREP_NEXT[item.status];
    const li = document.createElement('li');
    li.className = `st-${item.status} time-${lineDelayLevel(item) || 'ok'}`;
    li.innerHTML = `<span class="prep-time">${fmtTime(item.addedAt)}</span>` +
      `<span class="prep-what"><strong>${item.qty} ×</strong> ${esc(item.name)}</span>` +
      `<span class="prep-table">${esc(tableLabel(order.tableId))}${t && t.note ? ` <span class="muted">— ${esc(t.note)}</span>` : ''}</span>` +
      `<span class="prep-status">${st.icon} ${st.label}${item.orderedBy ? ` <span class="muted">· pedido por ${esc(item.orderedBy)}</span>` : ''}</span>` +
      `<button class="btn-primary">${next.label}</button>`;
    li.querySelector('button').addEventListener('click', async () => {
      try {
        // Al marcar 'entregado' queda registrado el mesero que lo llevó a la mesa.
        await api('PUT', `/api/orders/${order.id}/items/${item.lineId}`, { status: next.status, waiter: currentWaiter() });
        await refresh();
      } catch (err) { handle(err); }
    });
    ul.appendChild(li);
  }
  container.appendChild(ul);
}

// ---------- Inventario ----------

document.querySelectorAll('#productsTable th[data-sort]').forEach(th => {
  th.addEventListener('click', () => {
    const key = th.dataset.sort;
    if (invSort.key === key) invSort.dir = -invSort.dir;
    else invSort = { key, dir: 1 };
    renderInventory();
  });
});

function renderInventory() {
  markSortedHeaders('#productsTable', invSort);
  const tbody = $('#productsTable tbody');
  tbody.innerHTML = '';
  const products = sortRows(state.products.filter(p => p.active), invSort);
  for (const p of products) {
    const tr = document.createElement('tr');
    if (!p.openPrice && p.stock <= p.minStock) tr.className = 'low-stock';
    const stockCells = p.openPrice
      ? '<td class="muted" title="Precio libre: sin control de stock">—</td><td class="muted">—</td><td class="muted">—</td>'
      : `<td><input type="number" min="0" value="${p.stock}" data-f="stock"></td>
         <td><input type="number" min="0" value="${p.minStock}" data-f="minStock"></td>
         <td><input type="number" min="0" value="${p.maxStock}" data-f="maxStock"></td>`;
    tr.innerHTML = `
      <td><input class="wide" value="${esc(p.name)}" data-f="name">${p.openPrice ? ' <span class="muted">(precio libre)</span>' : ''}</td>
      <td><input class="wide" value="${esc(p.category)}" data-f="category"></td>
      <td><input type="number" step="0.01" min="0" value="${p.price}" data-f="price"></td>
      ${stockCells}
      <td class="row-actions"><button class="btn-danger" data-act="del">Borrar</button></td>`;
    tr.querySelectorAll('input').forEach(input => {
      input.addEventListener('change', async () => {
        try {
          await api('PUT', `/api/products/${p.id}`, { [input.dataset.f]: input.value });
          await refresh();
          toast('Producto actualizado');
        } catch (err) { handle(err); await refresh(); }
      });
    });
    tr.querySelector('[data-act="del"]').addEventListener('click', async () => {
      if (!confirm(`¿Borrar "${p.name}"?`)) return;
      const pin = await askSupervisor(); // borrar productos requiere clave de supervisor
      if (pin === null) return;
      try { await api('DELETE', `/api/products/${p.id}`, { pin }); await refresh(); toast('Producto borrado'); }
      catch (err) { handle(err); }
    });
    tbody.appendChild(tr);
  }

  const dl = $('#categoriesList');
  dl.innerHTML = [...new Set(state.products.map(p => p.category))]
    .map(c => `<option value="${esc(c)}">`).join('');
}

$('#btnNewProduct').addEventListener('click', () => {
  $('#productForm').reset();
  $('#productDialog').showModal();
});
$('#productCancel').addEventListener('click', () => $('#productDialog').close());

$('#productForm').addEventListener('submit', async e => {
  e.preventDefault();
  const fd = new FormData(e.target);
  try {
    await api('POST', '/api/products', Object.fromEntries(fd));
    $('#productDialog').close();
    await refresh();
    toast('Producto creado');
  } catch (err) { handle(err); }
});

// ---------- Informe de reposición ----------

function restockTableHTML(items) {
  if (!items.length) return '<p>No hay productos que reponer. 👍</p>';
  return `<table class="data-table">
    <thead><tr><th>Producto</th><th>Categoría</th><th>Stock</th><th>Máximo</th><th>%</th><th>Pedir</th></tr></thead>
    <tbody>${items.map(i => `
      <tr class="${i.stock === 0 ? 'low-stock' : ''}">
        <td>${esc(i.name)}</td><td>${esc(i.category)}</td>
        <td>${i.stock === 0 ? '<strong>AGOTADO</strong>' : i.stock}</td>
        <td>${i.maxStock}</td><td>${i.pct}%</td><td><strong>${i.suggested}</strong></td>
      </tr>`).join('')}
    </tbody></table>`;
}

$('#btnRestock').addEventListener('click', async () => {
  try {
    const report = await api('GET', '/api/reports/restock');
    $('#restockContent').innerHTML = restockTableHTML(report.items);
    const dlg = $('#restockDialog');
    dlg.showModal();
    $('#restockPrint').onclick = () => {
      dlg.close();
      printDoc(`<h1>Informe de reposición — ${esc(state.config.nombreBar || 'Mi Bar')}</h1>
        <p>${new Date(report.generatedAt).toLocaleString('es-ES')} · Agotados o por debajo del 20% del stock máximo</p>
        ${restockTableHTML(report.items)}`);
    };
  } catch (err) { handle(err); }
});
$('#restockClose').addEventListener('click', () => $('#restockDialog').close());

// ---------- Listas de precios ----------

function renderPriceLists() {
  if (currentPriceListId && !findPriceList(currentPriceListId)) currentPriceListId = null;
  if (!currentPriceListId && state.priceLists.length) currentPriceListId = state.priceLists[0].id;

  const ul = $('#priceListsUl');
  ul.innerHTML = '';
  for (const l of state.priceLists) {
    const li = document.createElement('li');
    li.innerHTML = esc(l.name) + (plVigente(l) ? '' : ' <span class="muted">(no vigente)</span>');
    li.className = l.id === currentPriceListId ? 'active' : '';
    li.addEventListener('click', () => { currentPriceListId = l.id; renderPriceLists(); });
    ul.appendChild(li);
  }
  if (!state.priceLists.length) ul.innerHTML = '<li class="muted">Sin listas. Los precios base se usan siempre que no haya tarifa.</li>';

  const editor = $('#plEditor');
  const pl = findPriceList(currentPriceListId);
  if (!pl) {
    editor.innerHTML = '<p class="hint">Crea una lista de precios para definir tarifas distintas (terraza, clientes especiales, happy hour…). Después asígnala a un área en Ajustes o elígela en una comanda.</p>';
    return;
  }
  // No re-renderizar el editor mientras se está escribiendo en él
  if (document.activeElement && editor.contains(document.activeElement)
      && document.activeElement.tagName === 'INPUT') {
    return;
  }

  const usedBy = state.areas.filter(a => a.priceListId === pl.id)
    .map(a => {
      const l = findLocal(a.localId);
      return (l && state.locales.length > 1 ? l.name + ' · ' : '') + a.name;
    });
  const vig = plVigente(pl);

  editor.innerHTML = `
    <div class="toolbar">
      <input id="plName" class="pl-name" value="${esc(pl.name)}">
      <div class="toolbar-actions">
        <button id="plAdjustBtn" class="btn-plain">± Ajuste masivo</button>
        <button id="plPrint" class="btn-plain">🖨 Imprimir</button>
        <button id="plQR" class="btn-plain" title="Código QR que abre la carta con estos precios, sin mostrar el nombre de la lista">📱 QR de la carta</button>
        <button id="plDelete" class="btn-danger">Borrar lista</button>
      </div>
    </div>
    <div class="pl-meta">
      <label>Vigente desde <input type="date" id="plFrom" value="${pl.validFrom || ''}"></label>
      <label>hasta <input type="date" id="plTo" value="${pl.validUntil || ''}"></label>
      <span class="pl-estado ${vig ? 'ok' : 'off'}">${vig ? '● Vigente' : '● No vigente'}</span>
    </div>
    <p class="hint">${usedBy.length ? 'Asignada a: ' + esc(usedBy.join(', ')) + '.' : 'No asignada a ningún área (se puede elegir manualmente en una comanda).'}
    Fechas vacías = sin límite. Fuera de vigencia se cobran los precios base. Deja el precio vacío para usar el base.</p>
    <div class="table-scroll">
      <table class="data-table" id="plTable">
        <thead><tr>
          <th data-sort="name">Producto</th>
          <th data-sort="category">Categoría</th>
          <th data-sort="price">Precio base</th>
          <th data-sort="final">Precio en esta lista</th>
        </tr></thead>
        <tbody id="plRows"></tbody>
      </table>
    </div>`;

  $('#plName').addEventListener('change', async e => {
    try { await api('PUT', `/api/pricelists/${pl.id}`, { name: e.target.value }); await refresh(); }
    catch (err) { handle(err); }
  });
  $('#plFrom').addEventListener('change', async e => {
    try { await api('PUT', `/api/pricelists/${pl.id}`, { validFrom: e.target.value || null }); await refresh(); toast('Vigencia actualizada'); }
    catch (err) { handle(err); await refresh(); }
  });
  $('#plTo').addEventListener('change', async e => {
    try { await api('PUT', `/api/pricelists/${pl.id}`, { validUntil: e.target.value || null }); await refresh(); toast('Vigencia actualizada'); }
    catch (err) { handle(err); await refresh(); }
  });
  $('#plDelete').addEventListener('click', async () => {
    if (!confirm(`¿Borrar la lista "${pl.name}"?`)) return;
    const pin = await askSupervisor(); // borrar listas requiere clave de supervisor
    if (pin === null) return;
    try { await api('DELETE', `/api/pricelists/${pl.id}`, { pin }); currentPriceListId = null; await refresh(); toast('Lista borrada'); }
    catch (err) { handle(err); }
  });
  $('#plPrint').addEventListener('click', () => printPriceList(pl));
  $('#plQR').addEventListener('click', () => printCartaQR(pl.id));
  $('#plAdjustBtn').addEventListener('click', () => openAdjustDialog());

  document.querySelectorAll('#plTable th[data-sort]').forEach(th => {
    th.addEventListener('click', () => {
      const key = th.dataset.sort;
      if (plSort.key === key) plSort.dir = -plSort.dir;
      else plSort = { key, dir: 1 };
      renderPriceLists();
    });
  });
  markSortedHeaders('#plTable', plSort);

  const tbody = $('#plRows');
  const rows = state.products.filter(p => p.active && !p.openPrice)
    .map(p => ({ ...p, final: pl.prices[p.id] != null ? pl.prices[p.id] : p.price }));
  for (const p of sortRows(rows, plSort)) {
    const override = pl.prices[p.id];
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${esc(p.name)}</td>
      <td>${esc(p.category)}</td>
      <td>${fmt(p.price)}</td>
      <td><input type="number" step="0.01" min="0" placeholder="${p.price}" value="${override != null ? override : ''}"></td>`;
    tr.querySelector('input').addEventListener('change', async e => {
      try {
        await api('PUT', `/api/pricelists/${pl.id}`, { prices: { [p.id]: e.target.value === '' ? null : e.target.value } });
        await refresh();
        toast('Precio actualizado');
      } catch (err) { handle(err); await refresh(); }
    });
    tbody.appendChild(tr);
  }
}

// Ajuste masivo de la lista actual (sobre el precio base, por producto/categoría/todos)
function openAdjustDialog() {
  const pl = findPriceList(currentPriceListId);
  if (!pl) return;
  const f = $('#plAdjustForm');
  f.reset();
  const products = state.products.filter(p => p.active && !p.openPrice);
  const cats = [...new Set(products.map(p => p.category))].sort((a, b) => a.localeCompare(b));
  $('#adjCategory').innerHTML = cats.map(c => `<option value="${esc(c)}">${esc(c)}</option>`).join('');
  $('#adjProduct').innerHTML = products
    .slice().sort((a, b) => a.name.localeCompare(b.name))
    .map(p => `<option value="${p.id}">${esc(p.name)} (${esc(p.category)})</option>`).join('');
  syncAdjustScope();
  $('#plAdjustDialog').showModal();
}

function syncAdjustScope() {
  const scope = $('#adjScope').value;
  $('#adjCatLabel').classList.toggle('hidden', scope !== 'category');
  $('#adjProdLabel').classList.toggle('hidden', scope !== 'product');
}
$('#adjScope').addEventListener('change', syncAdjustScope);
$('#adjCancel').addEventListener('click', () => $('#plAdjustDialog').close());

$('#plAdjustForm').addEventListener('submit', async e => {
  e.preventDefault();
  const pl = findPriceList(currentPriceListId);
  const fd = Object.fromEntries(new FormData(e.target));
  $('#plAdjustDialog').close();
  if (!pl) return;
  try {
    const r = await api('POST', `/api/pricelists/${pl.id}/adjust`, fd);
    await refresh();
    toast(`${r.updated} precio${r.updated === 1 ? '' : 's'} actualizado${r.updated === 1 ? '' : 's'}`);
  } catch (err) { handle(err); }
});

function priceListDocHTML(title, priceOf) {
  const products = state.products.filter(p => p.active && !p.openPrice)
    .sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
  const cats = [...new Set(products.map(p => p.category))];
  return `<h1>${esc(state.config.nombreBar || 'Mi Bar')}</h1><h2>${esc(title)}</h2>` +
    cats.map(c => `<h3>${esc(c)}</h3><table class="doc-prices">` +
      products.filter(p => p.category === c)
        .map(p => `<tr><td>${esc(p.name)}</td><td>${fmt(priceOf(p))}</td></tr>`).join('') +
      '</table>').join('');
}

function printPriceList(pl) {
  const vigencia = pl.validFrom || pl.validUntil
    ? ` (${pl.validFrom ? 'desde ' + pl.validFrom : ''}${pl.validFrom && pl.validUntil ? ' ' : ''}${pl.validUntil ? 'hasta ' + pl.validUntil : ''})`
    : '';
  printDoc(priceListDocHTML(`Lista de precios: ${pl.name}${vigencia}`, p => pl.prices[p.id] != null ? pl.prices[p.id] : p.price));
}

$('#btnPrintBase').addEventListener('click', () => {
  printDoc(priceListDocHTML('Lista de precios', p => p.price));
});

$('#btnNewList').addEventListener('click', async () => {
  const name = prompt('Nombre de la nueva lista de precios:');
  if (!name || !name.trim()) return;
  try {
    const pl = await api('POST', '/api/pricelists', { name: name.trim() });
    currentPriceListId = pl.id;
    await refresh();
    toast('Lista creada');
  } catch (err) { handle(err); }
});

// ---------- Exportar / importar ----------
// Los ficheros van referenciados por nombre (no por id), así se pueden llevar
// a otra instalación. Importar crea o actualiza por nombre; nunca borra nada.

function downloadJSON(data, filename) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

function fileSlug(s) {
  return String(s || '').trim().toLowerCase().replace(/[^a-z0-9ñ]+/gi, '-').replace(/^-+|-+$/g, '') || 'bar';
}

async function exportData(kind) {
  try {
    const data = await api('GET', `/api/export/${kind}`);
    downloadJSON(data, `${kind}-${fileSlug(state.config.nombreBar)}-${todayISO()}.json`);
    toast('Exportación descargada');
  } catch (err) { handle(err); }
}

// Abre el selector de fichero, confirma e importa (la clave de supervisor protege
// la importación: modifica datos en masa).
function importData(kind, confirmMsg, summaryOf) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json,application/json';
  input.addEventListener('change', async () => {
    const file = input.files && input.files[0];
    if (!file) return;
    let data;
    try { data = JSON.parse(await file.text()); }
    catch { toast('El fichero no es un JSON válido', true); return; }
    if (!confirm(confirmMsg)) return;
    const pin = await askSupervisor();
    if (pin === null) return;
    try {
      const r = await api('POST', `/api/import/${kind}`, { pin, data });
      await refresh();
      alert(summaryOf(r));
    } catch (err) { handle(err); }
  });
  input.click();
}

$('#btnExportPrecios').addEventListener('click', () => exportData('precios'));
$('#btnImportPrecios').addEventListener('click', () => importData('precios',
  'Se crearán o actualizarán (por nombre) los productos y las listas de precios del fichero. No se borra nada y el stock actual no se toca. ¿Continuar?',
  r => `Importación completada.\n\n· Productos: ${r.productsCreated} nuevos, ${r.productsUpdated} actualizados` +
    `\n· Listas de precios: ${r.listsCreated} nuevas, ${r.listsUpdated} actualizadas` +
    (r.pricesOmitted ? `\n· ${r.pricesOmitted} precio(s) omitido(s) (producto desconocido o de precio libre)` : '')));

$('#btnExportSalas').addEventListener('click', () => exportData('salas'));
$('#btnImportSalas').addEventListener('click', () => importData('salas',
  'Se crearán o actualizarán (por nombre) los locales, áreas y mesas del fichero, incluido el plano. No se borra nada. ¿Continuar?',
  r => `Importación completada.\n\n· Locales: ${r.localesCreated} nuevos` +
    `\n· Áreas: ${r.areasCreated} nuevas, ${r.areasUpdated} actualizadas` +
    `\n· Mesas: ${r.tablesCreated} nuevas, ${r.tablesUpdated} actualizadas`));

// ---------- Caja ----------

function closeReportHTML(c) {
  return `<h1>Cierre de caja — ${esc(state.config.nombreBar || 'Mi Bar')}</h1>
    <p>${new Date(c.closedAt).toLocaleString('es-ES')}${c.since ? ' · periodo desde ' + new Date(c.since).toLocaleString('es-ES') : ' · desde el inicio'}</p>
    <table class="data-table">
      <tr><td>Ventas</td><td>${c.numSales}</td></tr>
      <tr><td>Efectivo</td><td>${fmt(c.efectivo)}</td></tr>
      <tr><td>Tarjeta</td><td>${fmt(c.tarjeta)}</td></tr>
      <tr><td><strong>TOTAL</strong></td><td><strong>${fmt(c.total)}</strong></td></tr>
    </table>
    ${c.byProduct && c.byProduct.length ? `<h3>Productos vendidos</h3>
    <table class="data-table">
      <thead><tr><th>Producto</th><th>Uds.</th><th>Importe</th></tr></thead>
      <tbody>${c.byProduct.map(p => `<tr><td>${esc(p.name)}</td><td>${p.qty}</td><td>${fmt(p.total)}</td></tr>`).join('')}</tbody>
    </table>` : ''}
    ${c.salesDetail && c.salesDetail.length ? `<h3>Detalle de ventas</h3>
    <table class="data-table">
      <thead><tr><th>Hora</th><th>Mesa</th><th>Método</th><th>POS / transacción</th><th>Total</th></tr></thead>
      <tbody>${c.salesDetail.map(s => `<tr>
        <td>${fmtDT(s.paidAt)}</td><td>${esc(s.tableLabel || '')}</td><td>${s.method}</td>
        <td>${s.card ? esc(s.card.pos + ' · ' + s.card.code) : '—'}</td><td>${fmt(s.total)}</td>
      </tr>`).join('')}</tbody>
    </table>` : ''}`;
}

async function renderCaja() {
  const pending = state.pendingSales;
  const efectivo = pending.filter(s => s.method === 'efectivo').reduce((a, s) => a + s.total, 0);
  const tarjeta = pending.filter(s => s.method === 'tarjeta').reduce((a, s) => a + s.total, 0);

  $('#cajaResumen').innerHTML = `
    <div class="stat-row"><span>Desde</span><strong>${state.lastClose ? fmtDT(state.lastClose) : 'inicio'}</strong></div>
    <div class="stat-row"><span>Ventas</span><strong>${pending.length}</strong></div>
    <div class="stat-row"><span>Efectivo</span><strong>${fmt(efectivo)}</strong></div>
    <div class="stat-row"><span>Tarjeta</span><strong>${fmt(tarjeta)}</strong></div>
    <div class="stat-row total"><span>Total en caja</span><strong>${fmt(efectivo + tarjeta)}</strong></div>`;

  // Ventas de la caja actual: cada una puede anularse (la comanda vuelve a su mesa).
  const pendingUl = $('#pendingSales');
  pendingUl.innerHTML = '';
  for (const s of pending.slice().reverse()) {
    const li = document.createElement('li');
    li.innerHTML = `<span>${fmtDT(s.paidAt)} · ${esc(s.tableLabel || '')} <span class="muted">(${s.method}${s.card ? ' · ' + esc(s.card.pos) : ''})</span></span>` +
      `<span class="closes-right"><strong>${fmt(s.total)}</strong>` +
      `<button class="btn-plain" title="Anular el pago: la venta deja de contar y la comanda vuelve a abrirse en la mesa">↩ Anular</button></span>`;
    li.querySelector('button').addEventListener('click', async () => {
      if (!confirm(`¿Anular el pago de ${fmt(s.total)} (${s.tableLabel})? La comanda volverá a abrirse en su mesa.`)) return;
      const pin = await askSupervisor(); // anular pagos exige clave de supervisor
      if (pin === null) return;
      try {
        await api('POST', `/api/sales/${s.id}/void`, { pin });
        await refresh();
        renderCaja();
        toast('Pago anulado; la comanda ha vuelto a la mesa');
      } catch (err) { handle(err); }
    });
    pendingUl.appendChild(li);
  }
  if (!pending.length) pendingUl.innerHTML = '<li class="muted">Sin ventas pendientes</li>';

  try {
    const [report, closes] = await Promise.all([
      api('GET', '/api/reports?days=30'),
      api('GET', '/api/cashcloses'),
    ]);
    $('#reportSummary').innerHTML = `
      <div class="stat-row"><span>Ventas (30 días)</span><strong>${report.numSales}</strong></div>
      <div class="stat-row total"><span>Facturación</span><strong>${fmt(report.total)}</strong></div>`;
    $('#topProductsTable tbody').innerHTML = report.topProducts.map(p =>
      `<tr><td>${esc(p.name)}</td><td>${p.qty}</td><td>${fmt(p.total)}</td></tr>`
    ).join('') || '<tr><td colspan="3">Sin datos todavía</td></tr>';

    const closesUl = $('#closesList');
    closesUl.innerHTML = '';
    for (const c of closes) {
      const li = document.createElement('li');
      li.innerHTML = `<span>${fmtDT(c.closedAt)} · ${c.numSales} ventas <span class="muted">(ef. ${fmt(c.efectivo)} / tarj. ${fmt(c.tarjeta)})</span></span>` +
        `<span class="closes-right"><strong>${fmt(c.total)}</strong> <button class="btn-plain" title="Imprimir informe del cierre">🖨</button></span>`;
      li.querySelector('button').addEventListener('click', () => printDoc(closeReportHTML(c)));
      closesUl.appendChild(li);
    }
    if (!closes.length) closesUl.innerHTML = '<li class="muted">Ningún cierre todavía</li>';
  } catch (err) { handle(err); }
}

$('#btnCloseCash').addEventListener('click', async () => {
  if (!confirm('¿Hacer el cierre de caja? Las ventas actuales quedarán archivadas.')) return;
  try {
    const close = await api('POST', '/api/cashclose');
    await refresh();
    renderCaja();
    toast(`Cierre hecho: ${fmt(close.total)} (${close.numSales} ventas)`);
    if (confirm('¿Imprimir el informe del cierre?')) printDoc(closeReportHTML(close));
  } catch (err) { handle(err); }
});

// ---------- Ajustes: negocio, POS, envío de comandas, locales/áreas/mesas ----------

function bindConfigInput(sel, field) {
  $(sel).addEventListener('change', async e => {
    try { await api('PUT', '/api/config', { [field]: e.target.value }); await refresh(); toast('Guardado'); }
    catch (err) { handle(err); await refresh(); }
  });
}
bindConfigInput('#cfgNombre', 'nombreBar');
bindConfigInput('#cfgIva', 'ivaPct');

// Cambiar la clave de supervisor exige la clave actual (validada al entrar en Ajustes)
$('#cfgPin').addEventListener('change', async e => {
  const v = e.target.value.trim();
  if (!v) return;
  try {
    await api('PUT', '/api/config', { supervisorPin: v, pin: supervisorPin });
    supervisorPin = v;
    e.target.value = '';
    toast('Clave de supervisor actualizada');
  } catch (err) { handle(err); e.target.value = ''; }
});

function plOptions(selectedId) {
  return '<option value="">Precios base</option>' +
    state.priceLists.map(l => `<option value="${l.id}" ${l.id === selectedId ? 'selected' : ''}>${esc(l.name)}</option>`).join('');
}

function renderAjustes() {
  if (document.activeElement && $('#view-ajustes').contains(document.activeElement)
      && document.activeElement.tagName === 'INPUT') {
    return; // no re-renderizar mientras se edita un campo (lo hará el change → refresh)
  }
  $('#cfgNombre').value = state.config.nombreBar || '';
  $('#cfgIva').value = state.config.ivaPct != null ? state.config.ivaPct : '';

  renderPosTerminals();
  renderWaiters();
  renderStations();

  const container = $('#localesContainer');
  container.innerHTML = '';

  for (const local of state.locales) {
    const card = document.createElement('div');
    card.className = 'card local-card';

    const areasHtml = state.areas.filter(a => a.localId === local.id).map(area => {
      const tablesHtml = state.tables.filter(t => t.areaId === area.id).map(t => `
        <div class="mesa-row" data-table="${t.id}">
          <input class="mesa-name" value="${esc(t.name)}" data-f="name">
          <input class="mesa-seats" type="number" min="1" max="50" value="${t.seats}" data-f="seats" title="Puestos">
          <input class="mesa-note" value="${esc(t.note || '')}" placeholder="Descripción (p. ej. mesa de Roberto)" data-f="note">
          <button class="btn-plain" data-act="del-table">✕</button>
        </div>`).join('');
      return `
        <div class="area-block" data-area="${area.id}">
          <div class="area-head">
            <input class="area-name" value="${esc(area.name)}" data-f="name">
            <select class="area-pl">${plOptions(area.priceListId)}</select>
            <button class="btn-plain" data-act="add-table">+ Mesa</button>
            <button class="btn-plain" data-act="add-chair">+ Silla</button>
            <button class="btn-danger" data-act="del-area">Borrar área</button>
          </div>
          <div class="mesas-wrap">${tablesHtml || '<span class="muted">Sin mesas</span>'}</div>
        </div>`;
    }).join('');

    card.innerHTML = `
      <div class="toolbar">
        <input class="local-name" value="${esc(local.name)}">
        <div class="toolbar-actions">
          <button class="btn-plain" data-act="add-area">+ Área</button>
          <button class="btn-danger" data-act="del-local">Borrar local</button>
        </div>
      </div>
      ${areasHtml || '<p class="hint">Sin áreas.</p>'}`;

    // --- eventos del local ---
    card.querySelector('.local-name').addEventListener('change', async e => {
      try { await api('PUT', `/api/locales/${local.id}`, { name: e.target.value }); await refresh(); }
      catch (err) { handle(err); await refresh(); }
    });
    card.querySelector('[data-act="add-area"]').addEventListener('click', async () => {
      const name = prompt('Nombre del área (p. ej. Terraza):');
      if (!name || !name.trim()) return;
      try { await api('POST', '/api/areas', { localId: local.id, name: name.trim() }); await refresh(); }
      catch (err) { handle(err); }
    });
    card.querySelector('[data-act="del-local"]').addEventListener('click', async () => {
      if (!confirm(`¿Borrar el local "${local.name}"?`)) return;
      try { await api('DELETE', `/api/locales/${local.id}`); await refresh(); }
      catch (err) { handle(err); }
    });

    // --- eventos de áreas y mesas ---
    card.querySelectorAll('.area-block').forEach(block => {
      const areaId = parseInt(block.dataset.area, 10);
      block.querySelector('.area-name').addEventListener('change', async e => {
        try { await api('PUT', `/api/areas/${areaId}`, { name: e.target.value }); await refresh(); }
        catch (err) { handle(err); await refresh(); }
      });
      block.querySelector('.area-pl').addEventListener('change', async e => {
        try { await api('PUT', `/api/areas/${areaId}`, { priceListId: e.target.value || null }); await refresh(); toast('Tarifa del área actualizada'); }
        catch (err) { handle(err); await refresh(); }
      });
      block.querySelector('[data-act="add-table"]').addEventListener('click', async () => {
        const n = state.tables.filter(t => t.areaId === areaId).length + 1;
        try { await api('POST', '/api/tables', { areaId, name: 'Mesa ' + n, seats: 4 }); await refresh(); }
        catch (err) { handle(err); }
      });
      block.querySelector('[data-act="add-chair"]').addEventListener('click', async () => {
        const n = state.tables.filter(t => t.areaId === areaId).length + 1;
        try { await api('POST', '/api/tables', { areaId, name: 'Silla ' + n, seats: 1 }); await refresh(); }
        catch (err) { handle(err); }
      });
      block.querySelector('[data-act="del-area"]').addEventListener('click', async () => {
        if (!confirm('¿Borrar el área? Las mesas deben eliminarse antes.')) return;
        try { await api('DELETE', `/api/areas/${areaId}`); await refresh(); }
        catch (err) { handle(err); }
      });
      block.querySelectorAll('.mesa-row').forEach(row => {
        const tableId = parseInt(row.dataset.table, 10);
        row.querySelectorAll('input').forEach(input => {
          input.addEventListener('change', async () => {
            try { await api('PUT', `/api/tables/${tableId}`, { [input.dataset.f]: input.value }); await refresh(); }
            catch (err) { handle(err); await refresh(); }
          });
        });
        row.querySelector('[data-act="del-table"]').addEventListener('click', async () => {
          try { await api('DELETE', `/api/tables/${tableId}`); await refresh(); }
          catch (err) { handle(err); }
        });
      });
    });

    container.appendChild(card);
  }
}

// --- Terminales POS (datáfonos) ---

function renderPosTerminals() {
  const ul = $('#posList');
  const terminals = state.config.posTerminals || [];
  ul.innerHTML = '';
  terminals.forEach((t, i) => {
    const li = document.createElement('li');
    li.innerHTML = `<span>${esc(t)}</span><button class="btn-plain" title="Quitar">✕</button>`;
    li.querySelector('button').addEventListener('click', async () => {
      if (!confirm(`¿Quitar el POS "${t}"?`)) return;
      try { await api('PUT', '/api/config', { posTerminals: terminals.filter((_, j) => j !== i) }); await refresh(); }
      catch (err) { handle(err); }
    });
    ul.appendChild(li);
  });
  if (!terminals.length) ul.innerHTML = '<li class="muted">Sin terminales: al cobrar con tarjeta el nombre del POS se escribe a mano.</li>';
}

$('#btnAddPos').addEventListener('click', async () => {
  const name = prompt('Nombre del terminal POS (p. ej. «POS barra»):');
  if (!name || !name.trim()) return;
  try {
    await api('PUT', '/api/config', { posTerminals: [...(state.config.posTerminals || []), name.trim()] });
    await refresh();
    toast('POS añadido');
  } catch (err) { handle(err); }
});

// --- Meseros (responsables de comandar y llevar los pedidos) ---

function renderWaiters() {
  const ul = $('#waitersList');
  const waiters = state.config.waiters || [];
  ul.innerHTML = '';
  waiters.forEach((w, i) => {
    const li = document.createElement('li');
    li.innerHTML = `<span>${esc(w)}</span><button class="btn-plain" title="Quitar">✕</button>`;
    li.querySelector('button').addEventListener('click', async () => {
      if (!confirm(`¿Quitar al mesero "${w}"?`)) return;
      try { await api('PUT', '/api/config', { waiters: waiters.filter((_, j) => j !== i) }); await refresh(); }
      catch (err) { handle(err); }
    });
    ul.appendChild(li);
  });
  if (!waiters.length) ul.innerHTML = '<li class="muted">Sin meseros: los pedidos no registran responsable.</li>';
}

$('#btnAddWaiter').addEventListener('click', async () => {
  const name = prompt('Nombre del mesero:');
  if (!name || !name.trim()) return;
  try {
    await api('PUT', '/api/config', { waiters: [...(state.config.waiters || []), name.trim()] });
    await refresh();
    toast('Mesero añadido');
  } catch (err) { handle(err); }
});

// --- Categorías: área de preparación y tiempos de aviso (alto/demasiado) ---

function renderStations() {
  const sc = $('#stationsContainer');
  sc.innerHTML = '';
  const cats = [...new Set(state.products.filter(p => p.active).map(p => p.category))]
    .sort((a, b) => a.localeCompare(b));
  const cs = state.config.categoryStations || {};
  const ct = state.config.categoryTimes || {};
  if (!cats.length) { sc.innerHTML = '<p class="hint">Sin categorías de producto todavía.</p>'; return; }
  for (const cat of cats) {
    const row = document.createElement('div');
    row.className = 'station-row';
    const opts = ['<option value="">— No enviar —</option>'];
    for (const a of state.areas) {
      const l = findLocal(a.localId);
      const label = state.locales.length > 1 && l ? `${l.name} · ${a.name}` : a.name;
      opts.push(`<option value="${a.id}" ${cs[cat] === a.id ? 'selected' : ''}>${esc(label)}</option>`);
    }
    const t = ct[cat] || {};
    row.innerHTML = `<span class="station-cat">${esc(cat)}</span><select>${opts.join('')}</select>` +
      `<label class="time-label" title="Minutos hasta el aviso amarillo">🟡 Alto <input type="number" min="1" step="1" data-t="alto" value="${t.alto != null ? t.alto : ''}"> min</label>` +
      `<label class="time-label" title="Minutos hasta el aviso rojo">🔴 Demasiado <input type="number" min="1" step="1" data-t="demasiado" value="${t.demasiado != null ? t.demasiado : ''}"> min</label>`;
    row.querySelector('select').addEventListener('change', async e => {
      const next = { ...cs };
      if (e.target.value) next[cat] = parseInt(e.target.value, 10);
      else delete next[cat];
      try { await api('PUT', '/api/config', { categoryStations: next }); await refresh(); toast('Guardado'); }
      catch (err) { handle(err); await refresh(); }
    });
    row.querySelectorAll('input[data-t]').forEach(input => {
      input.addEventListener('change', async () => {
        const next = { ...ct, [cat]: { alto: null, demasiado: null, ...(ct[cat] || {}) } };
        next[cat] = { ...next[cat], [input.dataset.t]: input.value === '' ? null : input.value };
        try { await api('PUT', '/api/config', { categoryTimes: next }); await refresh(); toast('Guardado'); }
        catch (err) { handle(err); await refresh(); }
      });
    });
    sc.appendChild(row);
  }
}

$('#btnNewLocal').addEventListener('click', async () => {
  const name = prompt('Nombre del nuevo local:');
  if (!name || !name.trim()) return;
  try { await api('POST', '/api/locales', { name: name.trim() }); await refresh(); }
  catch (err) { handle(err); }
});

// --- Códigos QR de mesas: al escanearlos se abre la comanda de esa mesa ---

function tableQRBlock(t) {
  const url = location.origin + location.pathname + '?mesa=' + t.id;
  return `<div class="qr-item">${qrSvg(url, 150)}<div class="qr-label">${esc(tableLabel(t.id))}</div><div class="qr-url">${esc(url)}</div></div>`;
}

$('#btnPrintQR').addEventListener('click', () => {
  if (!state.tables.length) { toast('No hay mesas', true); return; }
  printDoc(`<h1>${esc(state.config.nombreBar || 'Mi Bar')} — Códigos QR de mesas</h1>
    <p>Imprime y coloca cada código en su mesa: al escanearlo se abre la comanda de esa mesa.</p>
    <div class="qr-grid">${state.tables.map(tableQRBlock).join('')}</div>`);
});

// --- Carta pública por QR: precios base o una lista concreta (sin mostrar su nombre) ---

function printCartaQR(plId) {
  const url = location.origin + location.pathname + '?carta=' + (plId != null ? plId : 'base');
  printDoc(`<h1>${esc(state.config.nombreBar || 'Mi Bar')} — Carta</h1>
    <p>Imprime y coloca este código: al escanearlo se abre la carta con los precios ${plId != null ? 'de esta tarifa (sin mostrar su nombre)' : 'base'}.</p>
    <div class="qr-grid"><div class="qr-item">${qrSvg(url, 150)}<div class="qr-label">Carta</div><div class="qr-url">${esc(url)}</div></div></div>`);
}

$('#btnQRBase').addEventListener('click', () => printCartaQR(null));

// Vista de solo lectura para clientes. Si la lista no existe o no está vigente,
// se muestran los precios base (que es lo que se cobraría).
function renderCarta() {
  if (cartaParam == null) return;
  const pl = cartaParam !== 'base' ? findPriceList(parseInt(cartaParam, 10)) : null;
  const priceOf = p => (pl && plVigente(pl) && pl.prices[p.id] != null) ? pl.prices[p.id] : p.price;
  $('#view-carta').innerHTML = `<div class="carta-doc">${priceListDocHTML('Carta', priceOf)}</div>`;
}

// ---------- Arranque ----------

refresh().then(() => {
  if (cartaParam != null) {
    // Modo carta pública (QR): solo la carta, sin navegación ni TPV
    document.body.classList.add('carta-mode');
    document.querySelectorAll('.view').forEach(v => v.classList.add('hidden'));
    $('#view-carta').classList.remove('hidden');
    renderCarta();
    return;
  }
  // ?mesa=ID (códigos QR): abre directamente la comanda de esa mesa
  const mesaId = parseInt(new URLSearchParams(location.search).get('mesa'), 10);
  if (mesaId && findTable(mesaId)) {
    history.replaceState(null, '', location.pathname);
    openTable(mesaId);
  }
}).catch(handle);
setInterval(() => { refresh().catch(() => {}); }, 15000); // sincroniza si hay varios dispositivos
