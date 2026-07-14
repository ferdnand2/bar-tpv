// Sistema de gestión para bar — TPV/comandas, inventario, caja, locales/áreas/mesas y listas de precios.
// Sin dependencias: Node >= 18. Arrancar con:  node server.js
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const PUBLIC_DIR = path.join(__dirname, 'public');

// ---------- Persistencia ----------

const SEED_PRODUCTS = [
  // [nombre, categoría, precio, stock, mínimo] — stock máximo = stock inicial
  ['Caña', 'Cerveza', 1.8, 100, 20],
  ['Doble', 'Cerveza', 2.5, 100, 20],
  ['Botellín', 'Cerveza', 1.5, 48, 12],
  ['Cerveza sin alcohol', 'Cerveza', 1.8, 24, 6],
  ['Vino tinto (copa)', 'Vino', 2.2, 40, 10],
  ['Vino blanco (copa)', 'Vino', 2.2, 30, 10],
  ['Refresco', 'Refrescos', 2.0, 60, 15],
  ['Agua', 'Refrescos', 1.2, 60, 15],
  ['Zumo', 'Refrescos', 2.0, 24, 6],
  ['Café solo', 'Cafés', 1.3, 500, 100],
  ['Café con leche', 'Cafés', 1.5, 500, 100],
  ['Cortado', 'Cafés', 1.4, 500, 100],
  ['Copa (combinado)', 'Copas', 6.0, 30, 8],
  ['Chupito', 'Copas', 2.0, 40, 10],
  ['Tapa del día', 'Cocina', 3.5, 30, 5],
  ['Ración de bravas', 'Cocina', 5.5, 25, 5],
  ['Bocadillo', 'Cocina', 4.5, 20, 5],
  ['Tostada', 'Cocina', 2.5, 30, 5],
];

let db;

function newId() { return db.nextId++; }

function seedDb() {
  db = {
    version: 2,
    config: { nombreBar: 'Mi Bar', ivaPct: 10 },
    nextId: 1,
    locales: [],
    areas: [],
    tables: [],
    priceLists: [],
    products: [],
    orders: [],
    sales: [],
    cashCloses: [],
  };
  for (const [name, category, price, stock, minStock] of SEED_PRODUCTS) {
    db.products.push({ id: newId(), name, category, price, stock, minStock, maxStock: stock, active: true });
  }
  const local = { id: newId(), name: 'Local principal' };
  db.locales.push(local);
  const barra = { id: newId(), localId: local.id, name: 'Barra', priceListId: null };
  const salon = { id: newId(), localId: local.id, name: 'Salón', priceListId: null };
  db.areas.push(barra, salon);
  db.tables.push({ id: newId(), areaId: barra.id, name: 'Barra', seats: 1 });
  for (let i = 1; i <= 8; i++) {
    db.tables.push({ id: newId(), areaId: salon.id, name: 'Mesa ' + i, seats: 4 });
  }
  saveDb();
}

// Migra bases de datos de la versión 1 (mesas numeradas, sin locales ni tarifas).
function migrateDb() {
  if (db.version >= 2) return;
  db.version = 2;
  db.priceLists = db.priceLists || [];
  const numMesas = db.config.numMesas || 8;
  delete db.config.numMesas;

  const local = { id: newId(), name: 'Local principal' };
  db.locales = [local];
  const areaBarra = { id: newId(), localId: local.id, name: 'Barra', priceListId: null };
  const areaSalon = { id: newId(), localId: local.id, name: 'Salón', priceListId: null };
  db.areas = [areaBarra, areaSalon];
  db.tables = [];
  const byOldNumber = {};
  const barraTable = { id: newId(), areaId: areaBarra.id, name: 'Barra', seats: 1 };
  db.tables.push(barraTable);
  byOldNumber[0] = barraTable.id;
  for (let i = 1; i <= numMesas; i++) {
    const t = { id: newId(), areaId: areaSalon.id, name: 'Mesa ' + i, seats: 4 };
    db.tables.push(t);
    byOldNumber[i] = t.id;
  }
  for (const o of db.orders) {
    o.tableId = byOldNumber[o.table] ?? barraTable.id;
    o.priceListId = null;
    delete o.table;
  }
  for (const s of db.sales) {
    s.tableLabel = s.table === 0 ? 'Barra' : 'Mesa ' + s.table;
    delete s.table;
  }
  for (const p of db.products) {
    if (p.maxStock == null) p.maxStock = Math.max(p.stock, p.minStock * 2) || 10;
  }
  saveDb();
}

function loadDb() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(DB_FILE)) {
    db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    migrateDb();
  } else {
    seedDb();
  }
}

function saveDb() {
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DB_FILE);
}

// ---------- Utilidades ----------

function round2(n) { return Math.round(n * 100) / 100; }

function orderTotal(order) {
  return round2(order.items.reduce((s, it) => s + it.price * it.qty, 0));
}

function findProduct(id) { return db.products.find(p => p.id === id); }
function findOrder(id) { return db.orders.find(o => o.id === id); }
function findTable(id) { return db.tables.find(t => t.id === id); }
function findArea(id) { return db.areas.find(a => a.id === id); }
function findLocal(id) { return db.locales.find(l => l.id === id); }
function findPriceList(id) { return db.priceLists.find(l => l.id === id); }

// Precio de un producto según la tarifa de la comanda (o precio base si no hay tarifa u override).
function priceFor(order, product) {
  if (order.priceListId != null) {
    const pl = findPriceList(order.priceListId);
    if (pl && pl.prices[product.id] != null) return pl.prices[product.id];
  }
  return product.price;
}

function tableLabel(tableId) {
  const table = findTable(tableId);
  const area = table && findArea(table.areaId);
  const local = area && findLocal(area.localId);
  return [local && local.name, area && area.name, table && table.name].filter(Boolean).join(' · ');
}

function lastCloseTime() {
  return db.cashCloses.length ? db.cashCloses[db.cashCloses.length - 1].closedAt : null;
}

function salesSinceLastClose() {
  const since = lastCloseTime();
  return db.sales.filter(s => !since || s.paidAt > since);
}

// ---------- API ----------

function jsonRes(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

function badRequest(res, msg) { jsonRes(res, 400, { error: msg }); }
function notFound(res, msg = 'No encontrado') { jsonRes(res, 404, { error: msg }); }

function parsePrice(v) {
  const n = round2(parseFloat(v));
  return isNaN(n) || n < 0 ? null : n;
}

const routes = {

  // --- Estado general ---
  'GET /api/state': (req, res) => {
    jsonRes(res, 200, {
      config: db.config,
      locales: db.locales,
      areas: db.areas,
      tables: db.tables,
      priceLists: db.priceLists,
      products: db.products,
      orders: db.orders,
      pendingSales: salesSinceLastClose(),
      lastClose: lastCloseTime(),
    });
  },

  'PUT /api/config': (req, res, body) => {
    if (body.nombreBar !== undefined) db.config.nombreBar = String(body.nombreBar);
    if (body.ivaPct !== undefined) {
      const v = parseFloat(body.ivaPct);
      if (isNaN(v) || v < 0 || v > 50) return badRequest(res, 'IVA inválido');
      db.config.ivaPct = v;
    }
    saveDb();
    jsonRes(res, 200, db.config);
  },

  // --- Locales ---
  'POST /api/locales': (req, res, body) => {
    if (!body.name || !String(body.name).trim()) return badRequest(res, 'Falta el nombre del local');
    const local = { id: newId(), name: String(body.name).trim() };
    db.locales.push(local);
    saveDb();
    jsonRes(res, 201, local);
  },

  'PUT /api/locales/:id': (req, res, body, params) => {
    const local = findLocal(parseInt(params.id, 10));
    if (!local) return notFound(res, 'Local no encontrado');
    if (body.name !== undefined) local.name = String(body.name).trim();
    saveDb();
    jsonRes(res, 200, local);
  },

  'DELETE /api/locales/:id': (req, res, body, params) => {
    const id = parseInt(params.id, 10);
    if (!findLocal(id)) return notFound(res, 'Local no encontrado');
    if (db.areas.some(a => a.localId === id)) return badRequest(res, 'El local tiene áreas; elimínalas primero');
    if (db.locales.length === 1) return badRequest(res, 'Debe existir al menos un local');
    db.locales = db.locales.filter(l => l.id !== id);
    saveDb();
    jsonRes(res, 200, { ok: true });
  },

  // --- Áreas ---
  'POST /api/areas': (req, res, body) => {
    const local = findLocal(parseInt(body.localId, 10));
    if (!local) return badRequest(res, 'Local inválido');
    if (!body.name || !String(body.name).trim()) return badRequest(res, 'Falta el nombre del área');
    const area = { id: newId(), localId: local.id, name: String(body.name).trim(), priceListId: null };
    db.areas.push(area);
    saveDb();
    jsonRes(res, 201, area);
  },

  'PUT /api/areas/:id': (req, res, body, params) => {
    const area = findArea(parseInt(params.id, 10));
    if (!area) return notFound(res, 'Área no encontrada');
    if (body.name !== undefined) area.name = String(body.name).trim();
    if (body.priceListId !== undefined) {
      if (body.priceListId === null || body.priceListId === '') {
        area.priceListId = null;
      } else {
        const pl = findPriceList(parseInt(body.priceListId, 10));
        if (!pl) return badRequest(res, 'Lista de precios no encontrada');
        area.priceListId = pl.id;
      }
    }
    saveDb();
    jsonRes(res, 200, area);
  },

  'DELETE /api/areas/:id': (req, res, body, params) => {
    const id = parseInt(params.id, 10);
    if (!findArea(id)) return notFound(res, 'Área no encontrada');
    if (db.tables.some(t => t.areaId === id)) return badRequest(res, 'El área tiene mesas; elimínalas primero');
    db.areas = db.areas.filter(a => a.id !== id);
    saveDb();
    jsonRes(res, 200, { ok: true });
  },

  // --- Mesas (una silla es una mesa de 1 puesto) ---
  'POST /api/tables': (req, res, body) => {
    const area = findArea(parseInt(body.areaId, 10));
    if (!area) return badRequest(res, 'Área inválida');
    if (!body.name || !String(body.name).trim()) return badRequest(res, 'Falta el nombre de la mesa');
    const seats = parseInt(body.seats, 10) || 1;
    if (seats < 1 || seats > 50) return badRequest(res, 'Número de puestos inválido');
    const table = { id: newId(), areaId: area.id, name: String(body.name).trim(), seats };
    db.tables.push(table);
    saveDb();
    jsonRes(res, 201, table);
  },

  'PUT /api/tables/:id': (req, res, body, params) => {
    const table = findTable(parseInt(params.id, 10));
    if (!table) return notFound(res, 'Mesa no encontrada');
    if (body.name !== undefined) table.name = String(body.name).trim();
    if (body.seats !== undefined) {
      const seats = parseInt(body.seats, 10);
      if (!Number.isInteger(seats) || seats < 1 || seats > 50) return badRequest(res, 'Número de puestos inválido');
      table.seats = seats;
    }
    saveDb();
    jsonRes(res, 200, table);
  },

  'DELETE /api/tables/:id': (req, res, body, params) => {
    const id = parseInt(params.id, 10);
    if (!findTable(id)) return notFound(res, 'Mesa no encontrada');
    if (db.orders.some(o => o.tableId === id)) return badRequest(res, 'La mesa tiene una comanda abierta');
    db.tables = db.tables.filter(t => t.id !== id);
    saveDb();
    jsonRes(res, 200, { ok: true });
  },

  // --- Listas de precios ---
  'POST /api/pricelists': (req, res, body) => {
    if (!body.name || !String(body.name).trim()) return badRequest(res, 'Falta el nombre de la lista');
    const pl = { id: newId(), name: String(body.name).trim(), prices: {} };
    db.priceLists.push(pl);
    saveDb();
    jsonRes(res, 201, pl);
  },

  'PUT /api/pricelists/:id': (req, res, body, params) => {
    const pl = findPriceList(parseInt(params.id, 10));
    if (!pl) return notFound(res, 'Lista no encontrada');
    if (body.name !== undefined) pl.name = String(body.name).trim();
    if (body.prices) {
      for (const [pid, value] of Object.entries(body.prices)) {
        if (!findProduct(parseInt(pid, 10))) return badRequest(res, `Producto ${pid} no existe`);
        if (value === null || value === '') {
          delete pl.prices[pid];
        } else {
          const v = parsePrice(value);
          if (v === null) return badRequest(res, 'Precio inválido');
          pl.prices[pid] = v;
        }
      }
    }
    saveDb();
    jsonRes(res, 200, pl);
  },

  'DELETE /api/pricelists/:id': (req, res, body, params) => {
    const id = parseInt(params.id, 10);
    if (!findPriceList(id)) return notFound(res, 'Lista no encontrada');
    if (db.areas.some(a => a.priceListId === id)) return badRequest(res, 'La lista está asignada a un área; desasígnala primero');
    if (db.orders.some(o => o.priceListId === id)) return badRequest(res, 'Hay comandas abiertas usando esta lista');
    db.priceLists = db.priceLists.filter(l => l.id !== id);
    saveDb();
    jsonRes(res, 200, { ok: true });
  },

  // --- Productos / inventario ---
  'POST /api/products': (req, res, body) => {
    const { name, category, price, stock, minStock, maxStock } = body;
    if (!name || !category || price == null) return badRequest(res, 'Faltan campos: nombre, categoría o precio');
    const p = {
      id: newId(),
      name: String(name).trim(),
      category: String(category).trim(),
      price: parsePrice(price),
      stock: parseInt(stock, 10) || 0,
      minStock: parseInt(minStock, 10) || 0,
      maxStock: parseInt(maxStock, 10) || 0,
      active: true,
    };
    if (p.price === null) return badRequest(res, 'Precio inválido');
    db.products.push(p);
    saveDb();
    jsonRes(res, 201, p);
  },

  'PUT /api/products/:id': (req, res, body, params) => {
    const p = findProduct(parseInt(params.id, 10));
    if (!p) return notFound(res, 'Producto no encontrado');
    for (const key of ['name', 'category']) {
      if (body[key] !== undefined) p[key] = String(body[key]).trim();
    }
    if (body.price !== undefined) {
      const v = parsePrice(body.price);
      if (v === null) return badRequest(res, 'Precio inválido');
      p.price = v;
    }
    for (const key of ['stock', 'minStock', 'maxStock']) {
      if (body[key] !== undefined) {
        const v = parseInt(body[key], 10);
        if (isNaN(v) || v < 0) return badRequest(res, `${key} inválido`);
        p[key] = v;
      }
    }
    if (body.active !== undefined) p.active = !!body.active;
    saveDb();
    jsonRes(res, 200, p);
  },

  'DELETE /api/products/:id': (req, res, body, params) => {
    const id = parseInt(params.id, 10);
    const p = findProduct(id);
    if (!p) return notFound(res, 'Producto no encontrado');
    const inUse = db.orders.some(o => o.items.some(it => it.productId === id));
    if (inUse) return badRequest(res, 'El producto está en una comanda abierta; ciérrala antes de borrarlo');
    p.active = false; // baja lógica: se conserva en el histórico de ventas
    saveDb();
    jsonRes(res, 200, { ok: true });
  },

  // --- Comandas ---
  'POST /api/orders': (req, res, body) => {
    const table = findTable(parseInt(body.tableId, 10));
    if (!table) return badRequest(res, 'Mesa inválida');
    if (db.orders.some(o => o.tableId === table.id)) return badRequest(res, 'La mesa ya tiene una comanda abierta');
    const area = findArea(table.areaId);
    const order = {
      id: newId(),
      tableId: table.id,
      priceListId: (area && area.priceListId) || null,
      items: [],
      openedAt: new Date().toISOString(),
    };
    db.orders.push(order);
    saveDb();
    jsonRes(res, 201, order);
  },

  // Cambiar la tarifa de una comanda (p. ej. cliente con lista especial); reprecia las líneas.
  'PUT /api/orders/:id/pricelist': (req, res, body, params) => {
    const order = findOrder(parseInt(params.id, 10));
    if (!order) return notFound(res, 'Comanda no encontrada');
    if (body.priceListId === null || body.priceListId === '') {
      order.priceListId = null;
    } else {
      const pl = findPriceList(parseInt(body.priceListId, 10));
      if (!pl) return badRequest(res, 'Lista de precios no encontrada');
      order.priceListId = pl.id;
    }
    for (const it of order.items) {
      const product = findProduct(it.productId);
      if (product) it.price = priceFor(order, product);
    }
    saveDb();
    jsonRes(res, 200, order);
  },

  'POST /api/orders/:id/items': (req, res, body, params) => {
    const order = findOrder(parseInt(params.id, 10));
    if (!order) return notFound(res, 'Comanda no encontrada');
    const product = findProduct(parseInt(body.productId, 10));
    if (!product || !product.active) return notFound(res, 'Producto no encontrado');
    const qty = parseInt(body.qty, 10) || 1;
    if (qty < 1) return badRequest(res, 'Cantidad inválida');
    if (product.stock < qty) return badRequest(res, `Sin stock suficiente de "${product.name}" (quedan ${product.stock})`);
    product.stock -= qty;
    const existing = order.items.find(it => it.productId === product.id);
    if (existing) existing.qty += qty;
    else order.items.push({ productId: product.id, name: product.name, price: priceFor(order, product), qty });
    saveDb();
    jsonRes(res, 200, order);
  },

  'DELETE /api/orders/:id/items/:productId': (req, res, body, params) => {
    const order = findOrder(parseInt(params.id, 10));
    if (!order) return notFound(res, 'Comanda no encontrada');
    const pid = parseInt(params.productId, 10);
    const item = order.items.find(it => it.productId === pid);
    if (!item) return notFound(res, 'Línea no encontrada');
    const qty = parseInt((body && body.qty) || 1, 10);
    const removed = Math.min(qty, item.qty);
    item.qty -= removed;
    if (item.qty <= 0) order.items = order.items.filter(it => it !== item);
    const product = findProduct(pid);
    if (product) product.stock += removed; // devolver al inventario
    saveDb();
    jsonRes(res, 200, order);
  },

  'POST /api/orders/:id/pay': (req, res, body, params) => {
    const order = findOrder(parseInt(params.id, 10));
    if (!order) return notFound(res, 'Comanda no encontrada');
    if (!order.items.length) return badRequest(res, 'La comanda está vacía');
    const method = body.method === 'tarjeta' ? 'tarjeta' : 'efectivo';
    const pl = order.priceListId != null ? findPriceList(order.priceListId) : null;
    const sale = {
      id: newId(),
      tableId: order.tableId,
      tableLabel: tableLabel(order.tableId),
      priceListName: pl ? pl.name : null,
      items: order.items,
      total: orderTotal(order),
      method,
      openedAt: order.openedAt,
      paidAt: new Date().toISOString(),
    };
    db.sales.push(sale);
    db.orders = db.orders.filter(o => o.id !== order.id);
    saveDb();
    jsonRes(res, 200, sale);
  },

  'DELETE /api/orders/:id': (req, res, body, params) => {
    const order = findOrder(parseInt(params.id, 10));
    if (!order) return notFound(res, 'Comanda no encontrada');
    for (const it of order.items) {
      const p = findProduct(it.productId);
      if (p) p.stock += it.qty; // anular comanda devuelve el stock
    }
    db.orders = db.orders.filter(o => o.id !== order.id);
    saveDb();
    jsonRes(res, 200, { ok: true });
  },

  // --- Caja ---
  'POST /api/cashclose': (req, res) => {
    const pending = salesSinceLastClose();
    if (!pending.length) return badRequest(res, 'No hay ventas pendientes de cierre');
    const efectivo = round2(pending.filter(s => s.method === 'efectivo').reduce((a, s) => a + s.total, 0));
    const tarjeta = round2(pending.filter(s => s.method === 'tarjeta').reduce((a, s) => a + s.total, 0));
    const close = {
      id: newId(),
      closedAt: new Date().toISOString(),
      numSales: pending.length,
      efectivo,
      tarjeta,
      total: round2(efectivo + tarjeta),
    };
    db.cashCloses.push(close);
    saveDb();
    jsonRes(res, 200, close);
  },

  'GET /api/cashcloses': (req, res) => {
    jsonRes(res, 200, db.cashCloses.slice().reverse());
  },

  // --- Informes ---
  'GET /api/reports': (req, res, body, params, query) => {
    const days = Math.min(parseInt(query.days, 10) || 30, 365);
    const since = new Date(Date.now() - days * 86400000).toISOString();
    const sales = db.sales.filter(s => s.paidAt >= since);

    const byDay = {};
    const byProduct = {};
    for (const s of sales) {
      const day = s.paidAt.slice(0, 10);
      byDay[day] = byDay[day] || { day, total: 0, numSales: 0 };
      byDay[day].total = round2(byDay[day].total + s.total);
      byDay[day].numSales++;
      for (const it of s.items) {
        byProduct[it.name] = byProduct[it.name] || { name: it.name, qty: 0, total: 0 };
        byProduct[it.name].qty += it.qty;
        byProduct[it.name].total = round2(byProduct[it.name].total + it.price * it.qty);
      }
    }
    const total = round2(sales.reduce((a, s) => a + s.total, 0));
    jsonRes(res, 200, {
      days,
      total,
      numSales: sales.length,
      byDay: Object.values(byDay).sort((a, b) => a.day.localeCompare(b.day)),
      topProducts: Object.values(byProduct).sort((a, b) => b.total - a.total).slice(0, 15),
    });
  },

  // Reposición: agotados o por debajo del 20% del stock máximo, con cantidad sugerida de pedido.
  'GET /api/reports/restock': (req, res) => {
    const items = db.products
      .filter(p => p.active && (p.stock === 0 || (p.maxStock > 0 && p.stock < 0.2 * p.maxStock)))
      .map(p => ({
        id: p.id,
        name: p.name,
        category: p.category,
        stock: p.stock,
        maxStock: p.maxStock,
        pct: p.maxStock > 0 ? Math.round((p.stock / p.maxStock) * 100) : 0,
        suggested: Math.max(p.maxStock - p.stock, 0),
      }))
      .sort((a, b) => a.pct - b.pct || a.name.localeCompare(b.name));
    jsonRes(res, 200, { generatedAt: new Date().toISOString(), items });
  },
};

function matchRoute(method, pathname) {
  for (const key of Object.keys(routes)) {
    const [m, pattern] = key.split(' ');
    if (m !== method) continue;
    const patParts = pattern.split('/').filter(Boolean);
    const pathParts = pathname.split('/').filter(Boolean);
    if (patParts.length !== pathParts.length) continue;
    const params = {};
    let ok = true;
    for (let i = 0; i < patParts.length; i++) {
      if (patParts[i].startsWith(':')) params[patParts[i].slice(1)] = decodeURIComponent(pathParts[i]);
      else if (patParts[i] !== pathParts[i]) { ok = false; break; }
    }
    if (ok) return { handler: routes[key], params };
  }
  return null;
}

// ---------- Servidor ----------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function serveStatic(res, urlPath) {
  let rel = urlPath === '/' ? '/index.html' : urlPath;
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('No encontrado');
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const query = Object.fromEntries(url.searchParams);

  if (url.pathname.startsWith('/api/')) {
    const match = matchRoute(req.method, url.pathname);
    if (!match) return notFound(res, 'Ruta no encontrada');
    let raw = '';
    req.on('data', chunk => { raw += chunk; if (raw.length > 1e6) req.destroy(); });
    req.on('end', () => {
      let body = {};
      if (raw) {
        try { body = JSON.parse(raw); } catch { return badRequest(res, 'JSON inválido'); }
      }
      try {
        match.handler(req, res, body, match.params, query);
      } catch (err) {
        console.error(err);
        jsonRes(res, 500, { error: 'Error interno' });
      }
    });
    return;
  }

  serveStatic(res, url.pathname);
});

loadDb();
server.listen(PORT, () => {
  console.log(`Sistema del bar en marcha: http://localhost:${PORT}`);
  console.log(`Datos guardados en: ${DB_FILE}`);
});
