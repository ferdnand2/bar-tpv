// Frontend del sistema del bar. Vanilla JS, sin dependencias.
'use strict';

const $ = sel => document.querySelector(sel);
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
const fmt = n => n.toLocaleString('es-ES', { style: 'currency', currency: 'EUR' });
const fmtDT = iso => new Date(iso).toLocaleString('es-ES', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

let state = {
  config: {}, locales: [], areas: [], tables: [], priceLists: [],
  products: [], orders: [], pendingSales: [], lastClose: null,
};
let currentOrderId = null;
let currentCategory = null;
let currentLocalId = null;
let currentPriceListId = null;

// ---------- API ----------

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
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
    if (pl && pl.prices[product.id] != null) return pl.prices[product.id];
  }
  return product.price;
}

// Impresión de documentos (informes, cartas): rellena #printArea y lanza el diálogo.
function printDoc(html) {
  $('#printArea').innerHTML = html;
  document.body.dataset.print = 'doc';
  window.print();
  delete document.body.dataset.print;
}

// ---------- Navegación ----------

document.querySelectorAll('nav .tab').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('nav .tab').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    document.querySelectorAll('.view').forEach(v => v.classList.add('hidden'));
    $('#view-' + btn.dataset.view).classList.remove('hidden');
    if (btn.dataset.view === 'caja') renderCaja();
  });
});

// ---------- Render general ----------

function render() {
  $('#barName').textContent = state.config.nombreBar || 'Mi Bar';
  renderTables();
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
  const low = state.products.filter(p => p.active && p.stock <= p.minStock).length;
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
  const areas = state.areas.filter(a => a.localId === currentLocalId);
  if (!areas.length) {
    container.innerHTML = '<p class="hint">Este local no tiene áreas. Créalas en Ajustes.</p>';
    return;
  }
  for (const area of areas) {
    const pl = area.priceListId != null && findPriceList(area.priceListId);
    const h = document.createElement('h3');
    h.className = 'area-title';
    h.innerHTML = esc(area.name) + (pl ? ` <span class="muted">(tarifa: ${esc(pl.name)})</span>` : '');
    container.appendChild(h);

    const grid = document.createElement('div');
    grid.className = 'tables-grid';
    const tables = state.tables.filter(t => t.areaId === area.id);
    if (!tables.length) grid.innerHTML = '<p class="hint">Sin mesas en esta área.</p>';
    for (const t of tables) {
      const order = state.orders.find(o => o.tableId === t.id);
      const btn = document.createElement('button');
      btn.className = 'table-btn' + (order ? ' occupied' : '');
      const total = order ? order.items.reduce((s, it) => s + it.price * it.qty, 0) : 0;
      btn.innerHTML = `<span>${t.seats === 1 ? '🪑' : '🍽'} ${esc(t.name)}</span>` +
        `<span class="seats">${t.seats} ${t.seats === 1 ? 'puesto' : 'puestos'}</span>` +
        (order ? `<span class="amount">${fmt(total)}</span>` : '<span class="amount">&nbsp;</span>');
      btn.addEventListener('click', () => openTable(t.id));
      grid.appendChild(btn);
    }
    container.appendChild(grid);
  }
}

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

  // Selector de tarifa de la comanda
  const sel = $('#orderPriceList');
  sel.innerHTML = '<option value="">Precios base</option>' +
    state.priceLists.map(l => `<option value="${l.id}" ${l.id === order.priceListId ? 'selected' : ''}>${esc(l.name)}</option>`).join('');
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
    b.innerHTML = `${esc(p.name)}<span class="price">${fmt(priceFor(order, p))}</span>` +
      (p.stock <= p.minStock ? `<span class="stock-low">quedan ${p.stock}</span>` : '');
    b.disabled = p.stock <= 0;
    b.addEventListener('click', async () => {
      try {
        await api('POST', `/api/orders/${order.id}/items`, { productId: p.id });
        await refresh();
      } catch (err) { handle(err); }
    });
    box.appendChild(b);
  }

  // Líneas de la comanda
  const list = $('#itemsList');
  list.innerHTML = '';
  let total = 0;
  for (const it of order.items) {
    total += it.price * it.qty;
    const li = document.createElement('li');
    li.innerHTML = `<button class="qty-btn" data-act="minus">−</button>` +
      `<span>${it.qty}</span>` +
      `<button class="qty-btn" data-act="plus">+</button>` +
      `<span class="name">${esc(it.name)}</span>` +
      `<span>${fmt(it.price * it.qty)}</span>`;
    li.querySelector('[data-act="minus"]').addEventListener('click', async () => {
      try {
        await api('DELETE', `/api/orders/${order.id}/items/${it.productId}`, { qty: 1 });
        await refresh();
      } catch (err) { handle(err); }
    });
    li.querySelector('[data-act="plus"]').addEventListener('click', async () => {
      try {
        await api('POST', `/api/orders/${order.id}/items`, { productId: it.productId });
        await refresh();
      } catch (err) { handle(err); }
    });
    list.appendChild(li);
  }
  $('#orderTotal').textContent = fmt(total);
}

$('#btnCancelOrder').addEventListener('click', async () => {
  const order = state.orders.find(o => o.id === currentOrderId);
  if (!order) return;
  if (order.items.length && !confirm('¿Anular la comanda? El stock se devolverá al inventario.')) return;
  try {
    await api('DELETE', `/api/orders/${order.id}`);
    currentOrderId = null;
    $('#orderPanel').classList.add('hidden');
    await refresh();
  } catch (err) { handle(err); }
});

async function pay(method) {
  const order = state.orders.find(o => o.id === currentOrderId);
  if (!order) return;
  try {
    const sale = await api('POST', `/api/orders/${order.id}/pay`, { method });
    currentOrderId = null;
    $('#orderPanel').classList.add('hidden');
    await refresh();
    toast(`Cobrado ${fmt(sale.total)} (${method})`);
    printTicket(sale);
  } catch (err) { handle(err); }
}

$('#btnPayCash').addEventListener('click', () => pay('efectivo'));
$('#btnPayCard').addEventListener('click', () => pay('tarjeta'));

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
    </table>
    <div class="sep"></div>
    <p class="center">¡Gracias por su visita!</p>`;
  if (confirm('¿Imprimir ticket?')) {
    document.body.dataset.print = 'ticket';
    window.print();
    delete document.body.dataset.print;
  }
}

// ---------- Inventario ----------

function renderInventory() {
  const tbody = $('#productsTable tbody');
  tbody.innerHTML = '';
  const products = state.products.filter(p => p.active)
    .sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
  for (const p of products) {
    const tr = document.createElement('tr');
    if (p.stock <= p.minStock) tr.className = 'low-stock';
    tr.innerHTML = `
      <td><input class="wide" value="${esc(p.name)}" data-f="name"></td>
      <td><input class="wide" value="${esc(p.category)}" data-f="category"></td>
      <td><input type="number" step="0.01" min="0" value="${p.price}" data-f="price"></td>
      <td><input type="number" min="0" value="${p.stock}" data-f="stock"></td>
      <td><input type="number" min="0" value="${p.minStock}" data-f="minStock"></td>
      <td><input type="number" min="0" value="${p.maxStock}" data-f="maxStock"></td>
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
      try { await api('DELETE', `/api/products/${p.id}`); await refresh(); }
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
    li.textContent = l.name;
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

  const usedBy = state.areas.filter(a => a.priceListId === pl.id)
    .map(a => {
      const l = findLocal(a.localId);
      return (l && state.locales.length > 1 ? l.name + ' · ' : '') + a.name;
    });

  editor.innerHTML = `
    <div class="toolbar">
      <input id="plName" class="pl-name" value="${esc(pl.name)}">
      <div class="toolbar-actions">
        <button id="plPrint" class="btn-plain">🖨 Imprimir</button>
        <button id="plDelete" class="btn-danger">Borrar lista</button>
      </div>
    </div>
    <p class="hint">${usedBy.length ? 'Asignada a: ' + esc(usedBy.join(', ')) : 'No asignada a ningún área (se puede elegir manualmente en una comanda).'}
    Deja el precio vacío para usar el precio base.</p>
    <div class="table-scroll">
      <table class="data-table">
        <thead><tr><th>Producto</th><th>Precio base</th><th>Precio en esta lista</th></tr></thead>
        <tbody id="plRows"></tbody>
      </table>
    </div>`;

  $('#plName').addEventListener('change', async e => {
    try { await api('PUT', `/api/pricelists/${pl.id}`, { name: e.target.value }); await refresh(); }
    catch (err) { handle(err); }
  });
  $('#plDelete').addEventListener('click', async () => {
    if (!confirm(`¿Borrar la lista "${pl.name}"?`)) return;
    try { await api('DELETE', `/api/pricelists/${pl.id}`); currentPriceListId = null; await refresh(); }
    catch (err) { handle(err); }
  });
  $('#plPrint').addEventListener('click', () => printPriceList(pl));

  const tbody = $('#plRows');
  const products = state.products.filter(p => p.active)
    .sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
  for (const p of products) {
    const override = pl.prices[p.id];
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${esc(p.name)} <span class="muted">(${esc(p.category)})</span></td>
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

function priceListDocHTML(title, priceOf) {
  const products = state.products.filter(p => p.active)
    .sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
  const cats = [...new Set(products.map(p => p.category))];
  return `<h1>${esc(state.config.nombreBar || 'Mi Bar')}</h1><h2>${esc(title)}</h2>` +
    cats.map(c => `<h3>${esc(c)}</h3><table class="doc-prices">` +
      products.filter(p => p.category === c)
        .map(p => `<tr><td>${esc(p.name)}</td><td>${fmt(priceOf(p))}</td></tr>`).join('') +
      '</table>').join('');
}

function printPriceList(pl) {
  printDoc(priceListDocHTML(`Lista de precios: ${pl.name}`, p => pl.prices[p.id] != null ? pl.prices[p.id] : p.price));
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

// ---------- Caja ----------

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

  $('#pendingSales').innerHTML = pending.slice().reverse().map(s =>
    `<li><span>${fmtDT(s.paidAt)} · ${esc(s.tableLabel || '')} <span class="muted">(${s.method})</span></span><strong>${fmt(s.total)}</strong></li>`
  ).join('') || '<li class="muted">Sin ventas pendientes</li>';

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
    $('#closesList').innerHTML = closes.map(c =>
      `<li><span>${fmtDT(c.closedAt)} · ${c.numSales} ventas <span class="muted">(ef. ${fmt(c.efectivo)} / tarj. ${fmt(c.tarjeta)})</span></span><strong>${fmt(c.total)}</strong></li>`
    ).join('') || '<li class="muted">Ningún cierre todavía</li>';
  } catch (err) { handle(err); }
}

$('#btnCloseCash').addEventListener('click', async () => {
  if (!confirm('¿Hacer el cierre de caja? Las ventas actuales quedarán archivadas.')) return;
  try {
    const close = await api('POST', '/api/cashclose');
    await refresh();
    renderCaja();
    toast(`Cierre hecho: ${fmt(close.total)} (${close.numSales} ventas)`);
  } catch (err) { handle(err); }
});

// ---------- Ajustes: negocio, locales, áreas y mesas ----------

function bindConfigInput(sel, field) {
  $(sel).addEventListener('change', async e => {
    try { await api('PUT', '/api/config', { [field]: e.target.value }); await refresh(); toast('Guardado'); }
    catch (err) { handle(err); await refresh(); }
  });
}
bindConfigInput('#cfgNombre', 'nombreBar');
bindConfigInput('#cfgIva', 'ivaPct');

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

$('#btnNewLocal').addEventListener('click', async () => {
  const name = prompt('Nombre del nuevo local:');
  if (!name || !name.trim()) return;
  try { await api('POST', '/api/locales', { name: name.trim() }); await refresh(); }
  catch (err) { handle(err); }
});

// ---------- Arranque ----------

refresh().catch(handle);
setInterval(() => { refresh().catch(() => {}); }, 15000); // sincroniza si hay varios dispositivos
