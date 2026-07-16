// Versión GitHub Pages: implementa la API del servidor dentro del navegador,
// guardando los datos en localStorage. Intercepta fetch('/api/...') para que
// app.js funcione sin cambios. Cada navegador tiene sus propios datos.
(() => {
'use strict';

const KEY = 'bar-tpv-db';

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
    version: 7,
    config: {
      nombreBar: 'Mi Bar',
      ivaPct: 10,
      supervisorPin: '0000',
      posTerminals: ['POS 1'],
      categoryStations: {}, // categoría de producto -> areaId que prepara esos pedidos
      categoryTimes: {}, // categoría -> { alto, demasiado } en minutos (avisos amarillo/rojo)
      waiters: [], // meseros: responsables de comandar y llevar los pedidos
    },
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
    db.products.push({ id: newId(), name, category, price, stock, minStock, maxStock: stock, active: true, openPrice: false });
  }
  // Producto de precio libre: el precio (y descripción) se indican al vender; sin control de stock.
  db.products.push({ id: newId(), name: 'Varios', category: 'Varios', price: 0, stock: 0, minStock: 0, maxStock: 0, active: true, openPrice: true });
  const local = { id: newId(), name: 'Local principal' };
  db.locales.push(local);
  const barra = { id: newId(), localId: local.id, name: 'Barra', priceListId: null, planW: null, planH: null };
  const salon = { id: newId(), localId: local.id, name: 'Salón', priceListId: null, planW: null, planH: null };
  db.areas.push(barra, salon);
  db.tables.push({ id: newId(), areaId: barra.id, name: 'Barra', seats: 1, note: '', posX: null, posY: null });
  for (let i = 1; i <= 8; i++) {
    db.tables.push({ id: newId(), areaId: salon.id, name: 'Mesa ' + i, seats: 4, note: '', posX: null, posY: null });
  }
  saveDb();
}

// Migraciones (la demo nació en v2): mismos cambios que el servidor,
// para que quien ya tenga datos guardados en el navegador no los pierda.
function migrateDb() {
  const startVersion = db.version;

  // v2 -> v3
  if (db.version < 3) {
    db.version = 3;
    if (db.config.supervisorPin === undefined) db.config.supervisorPin = '0000';
    if (db.config.posTerminals === undefined) db.config.posTerminals = ['POS 1'];
    if (db.config.categoryStations === undefined) db.config.categoryStations = {};
    for (const pl of db.priceLists) {
      if (pl.validFrom === undefined) pl.validFrom = null;
      if (pl.validUntil === undefined) pl.validUntil = null;
    }
    for (const p of db.products) {
      if (p.openPrice === undefined) p.openPrice = false;
    }
    if (!db.products.some(p => p.active && p.openPrice)) {
      db.products.push({ id: newId(), name: 'Varios', category: 'Varios', price: 0, stock: 0, minStock: 0, maxStock: 0, active: true, openPrice: true });
    }
    for (const t of db.tables) {
      if (t.note === undefined) t.note = '';
    }
    for (const o of db.orders) {
      for (const it of o.items) {
        if (it.lineId === undefined) it.lineId = newId();
        if (it.category === undefined) {
          const p = findProduct(it.productId);
          it.category = p ? p.category : '';
        }
        if (it.done === undefined) it.done = false;
        if (it.addedAt === undefined) it.addedAt = o.openedAt;
      }
    }
  }

  // v3 -> v4: meseros, estados de línea (pedido/procesando/listo/entregado) y anulación de pagos.
  if (db.version < 4) {
    db.version = 4;
    if (db.config.waiters === undefined) db.config.waiters = [];
    for (const s of db.sales) {
      if (s.voided === undefined) s.voided = false;
    }
    for (const o of db.orders) {
      for (const it of o.items) {
        if (it.status === undefined) it.status = it.done ? 'entregado' : 'pedido';
        delete it.done;
        if (it.orderedBy === undefined) it.orderedBy = null;
        if (it.deliveredBy === undefined) it.deliveredBy = null;
      }
    }
  }

  // v4 -> v5: tiempos de aviso por categoría y hora de envío de cada línea.
  if (db.version < 5) {
    db.version = 5;
    if (db.config.categoryTimes === undefined) db.config.categoryTimes = {};
    for (const o of db.orders) {
      for (const it of o.items) {
        if (it.sentAt === undefined) it.sentAt = it.status !== 'borrador' ? it.addedAt : null;
      }
    }
  }

  // v5 -> v6: posición de las mesas en el plano del área (% del lienzo; null = sin plano).
  if (db.version < 6) {
    db.version = 6;
    for (const t of db.tables) {
      if (t.posX === undefined) t.posX = null;
      if (t.posY === undefined) t.posY = null;
    }
  }

  // v6 -> v7: tamaño del plano por área (planW en % del ancho disponible, planH en px).
  if (db.version < 7) {
    db.version = 7;
    for (const a of db.areas) {
      if (a.planW === undefined) a.planW = null;
      if (a.planH === undefined) a.planH = null;
    }
  }

  if (db.version !== startVersion) saveDb();
}

function loadDb() {
  const raw = localStorage.getItem(KEY);
  if (raw) {
    db = JSON.parse(raw);
    migrateDb();
  } else {
    seedDb();
  }
}

function saveDb() {
  localStorage.setItem(KEY, JSON.stringify(db));
}

// ---------- Utilidades (idénticas al servidor) ----------

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

function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function plVigente(pl) {
  const today = todayISO();
  return (!pl.validFrom || today >= pl.validFrom) && (!pl.validUntil || today <= pl.validUntil);
}

function priceFor(order, product) {
  if (order.priceListId != null) {
    const pl = findPriceList(order.priceListId);
    if (pl && plVigente(pl) && pl.prices[product.id] != null) return pl.prices[product.id];
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
  return db.sales.filter(s => !s.voided && (!since || s.paidAt > since));
}

// Estados de una línea de comanda. 'borrador' = aún sin enviar a preparación.
const LINE_STATUSES = ['borrador', 'pedido', 'procesando', 'listo', 'entregado'];

// Cancelar líneas ya en preparación (procesando o después) exige clave de supervisor.
function canCancelLine(res, item, pin) {
  if (item.status === 'borrador' || item.status === 'pedido') return true;
  if (String(pin || '') === String(db.config.supervisorPin)) return true;
  jsonRes(res, 403, { error: 'La línea ya está en preparación; se necesita la clave de supervisor para cancelarla' });
  return false;
}

function publicConfig() {
  const { supervisorPin, ...rest } = db.config;
  return rest;
}

// ---------- Rutas (portadas del servidor; res es un objeto {_status,_data}) ----------

function jsonRes(res, status, data) { res._status = status; res._data = data; }
function badRequest(res, msg) { jsonRes(res, 400, { error: msg }); }
function notFound(res, msg = 'No encontrado') { jsonRes(res, 404, { error: msg }); }

function checkPin(res, pin) {
  if (String(pin || '') !== String(db.config.supervisorPin)) {
    jsonRes(res, 403, { error: 'Clave de supervisor incorrecta' });
    return false;
  }
  return true;
}

function parsePrice(v) {
  const n = round2(parseFloat(v));
  return isNaN(n) || n < 0 ? null : n;
}

function parseDateOrNull(res, v) {
  if (v === null || v === undefined || v === '') return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(v))) {
    badRequest(res, 'Fecha inválida (formato AAAA-MM-DD)');
    return undefined; // undefined = error ya respondido
  }
  return String(v);
}

const routes = {

  'GET /api/state': (req, res) => {
    jsonRes(res, 200, {
      config: publicConfig(),
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
    // Validaciones primero: no mutar nada si algo falla.
    if (body.supervisorPin !== undefined) {
      if (!checkPin(res, body.pin)) return;
      if (!/^\d{4,8}$/.test(String(body.supervisorPin).trim())) return badRequest(res, 'La clave debe tener de 4 a 8 dígitos');
    }
    if (body.ivaPct !== undefined) {
      const v = parseFloat(body.ivaPct);
      if (isNaN(v) || v < 0 || v > 50) return badRequest(res, 'IVA inválido');
    }
    if (body.posTerminals !== undefined && !Array.isArray(body.posTerminals)) {
      return badRequest(res, 'Lista de terminales POS inválida');
    }
    if (body.waiters !== undefined && !Array.isArray(body.waiters)) {
      return badRequest(res, 'Lista de meseros inválida');
    }
    let newStations;
    if (body.categoryStations !== undefined) {
      if (typeof body.categoryStations !== 'object' || body.categoryStations === null || Array.isArray(body.categoryStations)) {
        return badRequest(res, 'Configuración de envío de comandas inválida');
      }
      newStations = {};
      for (const [cat, areaId] of Object.entries(body.categoryStations)) {
        if (areaId === null || areaId === '') continue;
        const area = findArea(parseInt(areaId, 10));
        if (!area) return badRequest(res, `Área inválida para la categoría "${cat}"`);
        newStations[cat] = area.id;
      }
    }
    // Tiempos de aviso por categoría, en minutos: 'alto' (amarillo) y 'demasiado' (rojo).
    let newTimes;
    if (body.categoryTimes !== undefined) {
      if (typeof body.categoryTimes !== 'object' || body.categoryTimes === null || Array.isArray(body.categoryTimes)) {
        return badRequest(res, 'Configuración de tiempos inválida');
      }
      newTimes = {};
      for (const [cat, t] of Object.entries(body.categoryTimes)) {
        if (!t) continue;
        const parseMin = v => (v === null || v === undefined || v === '') ? null : parseFloat(v);
        const alto = parseMin(t.alto);
        const demasiado = parseMin(t.demasiado);
        if (alto !== null && (isNaN(alto) || alto <= 0)) return badRequest(res, `Tiempo «Alto» inválido en la categoría "${cat}"`);
        if (demasiado !== null && (isNaN(demasiado) || demasiado <= 0)) return badRequest(res, `Tiempo «Demasiado» inválido en la categoría "${cat}"`);
        if (alto !== null && demasiado !== null && demasiado <= alto) {
          return badRequest(res, `En la categoría "${cat}", el tiempo «Demasiado» debe ser mayor que «Alto»`);
        }
        if (alto !== null || demasiado !== null) newTimes[cat] = { alto, demasiado };
      }
    }

    if (body.nombreBar !== undefined) db.config.nombreBar = String(body.nombreBar);
    if (body.ivaPct !== undefined) db.config.ivaPct = parseFloat(body.ivaPct);
    if (body.posTerminals !== undefined) db.config.posTerminals = body.posTerminals.map(t => String(t).trim()).filter(Boolean);
    if (body.waiters !== undefined) db.config.waiters = body.waiters.map(t => String(t).trim()).filter(Boolean);
    if (newStations !== undefined) db.config.categoryStations = newStations;
    if (newTimes !== undefined) db.config.categoryTimes = newTimes;
    if (body.supervisorPin !== undefined) db.config.supervisorPin = String(body.supervisorPin).trim();
    saveDb();
    jsonRes(res, 200, publicConfig());
  },

  'POST /api/supervisor/check': (req, res, body) => {
    if (!checkPin(res, body.pin)) return;
    jsonRes(res, 200, { ok: true });
  },

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

  'POST /api/areas': (req, res, body) => {
    const local = findLocal(parseInt(body.localId, 10));
    if (!local) return badRequest(res, 'Local inválido');
    if (!body.name || !String(body.name).trim()) return badRequest(res, 'Falta el nombre del área');
    const area = { id: newId(), localId: local.id, name: String(body.name).trim(), priceListId: null, planW: null, planH: null };
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
    // Tamaño del plano del área: ancho en % (20-100) y alto en px (180-2000); null = por defecto.
    if (body.planW !== undefined) {
      if (body.planW === null || body.planW === '') area.planW = null;
      else {
        const v = parseFloat(body.planW);
        if (isNaN(v) || v < 20 || v > 100) return badRequest(res, 'Ancho del plano inválido (20-100%)');
        area.planW = Math.round(v * 10) / 10;
      }
    }
    if (body.planH !== undefined) {
      if (body.planH === null || body.planH === '') area.planH = null;
      else {
        const v = parseInt(body.planH, 10);
        if (isNaN(v) || v < 180 || v > 2000) return badRequest(res, 'Alto del plano inválido (180-2000 px)');
        area.planH = v;
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
    // Si alguna categoría enviaba sus comandas a esta área, se desconfigura.
    for (const [cat, areaId] of Object.entries(db.config.categoryStations)) {
      if (areaId === id) delete db.config.categoryStations[cat];
    }
    saveDb();
    jsonRes(res, 200, { ok: true });
  },

  'POST /api/tables': (req, res, body) => {
    const area = findArea(parseInt(body.areaId, 10));
    if (!area) return badRequest(res, 'Área inválida');
    if (!body.name || !String(body.name).trim()) return badRequest(res, 'Falta el nombre de la mesa');
    const seats = parseInt(body.seats, 10) || 1;
    if (seats < 1 || seats > 50) return badRequest(res, 'Número de puestos inválido');
    const table = { id: newId(), areaId: area.id, name: String(body.name).trim(), seats, note: String(body.note || '').trim(), posX: null, posY: null };
    db.tables.push(table);
    saveDb();
    jsonRes(res, 201, table);
  },

  'PUT /api/tables/:id': (req, res, body, params) => {
    const table = findTable(parseInt(params.id, 10));
    if (!table) return notFound(res, 'Mesa no encontrada');
    if (body.name !== undefined) table.name = String(body.name).trim();
    if (body.note !== undefined) table.note = String(body.note).trim().slice(0, 200);
    if (body.seats !== undefined) {
      const seats = parseInt(body.seats, 10);
      if (!Number.isInteger(seats) || seats < 1 || seats > 50) return badRequest(res, 'Número de puestos inválido');
      table.seats = seats;
    }
    // Posición en el plano del área (0-100, % del lienzo); null = quitar del plano.
    for (const key of ['posX', 'posY']) {
      if (body[key] !== undefined) {
        if (body[key] === null || body[key] === '') {
          table[key] = null;
        } else {
          const v = parseFloat(body[key]);
          if (isNaN(v) || v < 0 || v > 100) return badRequest(res, 'Posición inválida');
          table[key] = Math.round(v * 10) / 10;
        }
      }
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

  'POST /api/pricelists': (req, res, body) => {
    if (!body.name || !String(body.name).trim()) return badRequest(res, 'Falta el nombre de la lista');
    const pl = { id: newId(), name: String(body.name).trim(), prices: {}, validFrom: null, validUntil: null };
    db.priceLists.push(pl);
    saveDb();
    jsonRes(res, 201, pl);
  },

  'PUT /api/pricelists/:id': (req, res, body, params) => {
    const pl = findPriceList(parseInt(params.id, 10));
    if (!pl) return notFound(res, 'Lista no encontrada');
    if (body.name !== undefined) pl.name = String(body.name).trim();
    if (body.validFrom !== undefined) {
      const v = parseDateOrNull(res, body.validFrom);
      if (v === undefined) return;
      pl.validFrom = v;
    }
    if (body.validUntil !== undefined) {
      const v = parseDateOrNull(res, body.validUntil);
      if (v === undefined) return;
      pl.validUntil = v;
    }
    if (pl.validFrom && pl.validUntil && pl.validFrom > pl.validUntil) {
      return badRequest(res, 'La fecha de inicio de vigencia es posterior a la de fin');
    }
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

  // Ajuste masivo: fija los precios de la lista a partir del precio BASE de cada producto,
  // sumando un importe (negativo resta) o aplicando un porcentaje (negativo rebaja).
  'POST /api/pricelists/:id/adjust': (req, res, body, params) => {
    const pl = findPriceList(parseInt(params.id, 10));
    if (!pl) return notFound(res, 'Lista no encontrada');
    const mode = body.mode === 'percent' || body.mode === 'amount' ? body.mode : null;
    if (!mode) return badRequest(res, 'Tipo de ajuste inválido (amount o percent)');
    const value = parseFloat(body.value);
    if (isNaN(value)) return badRequest(res, 'Valor de ajuste inválido');
    let targets = db.products.filter(p => p.active && !p.openPrice);
    if (body.scope === 'category') {
      const cat = String(body.category || '').trim();
      targets = targets.filter(p => p.category === cat);
      if (!targets.length) return badRequest(res, 'No hay productos en esa categoría');
    } else if (body.scope === 'product') {
      const p = findProduct(parseInt(body.productId, 10));
      if (!p || !p.active) return badRequest(res, 'Producto no encontrado');
      if (p.openPrice) return badRequest(res, 'Los productos de precio libre no tienen precio en las listas');
      targets = [p];
    } else if (body.scope !== 'all') {
      return badRequest(res, 'Ámbito inválido (all, category o product)');
    }
    for (const p of targets) {
      const nuevo = mode === 'amount' ? p.price + value : p.price * (1 + value / 100);
      pl.prices[p.id] = round2(Math.max(nuevo, 0));
    }
    saveDb();
    jsonRes(res, 200, { ok: true, updated: targets.length, priceList: pl });
  },

  'DELETE /api/pricelists/:id': (req, res, body, params) => {
    if (!checkPin(res, body.pin)) return;
    const id = parseInt(params.id, 10);
    if (!findPriceList(id)) return notFound(res, 'Lista no encontrada');
    if (db.areas.some(a => a.priceListId === id)) return badRequest(res, 'La lista está asignada a un área; desasígnala primero');
    if (db.orders.some(o => o.priceListId === id)) return badRequest(res, 'Hay comandas abiertas usando esta lista');
    db.priceLists = db.priceLists.filter(l => l.id !== id);
    saveDb();
    jsonRes(res, 200, { ok: true });
  },

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
      openPrice: !!body.openPrice,
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
    if (body.openPrice !== undefined) p.openPrice = !!body.openPrice;
    if (body.active !== undefined) p.active = !!body.active;
    saveDb();
    jsonRes(res, 200, p);
  },

  'DELETE /api/products/:id': (req, res, body, params) => {
    if (!checkPin(res, body.pin)) return;
    const id = parseInt(params.id, 10);
    const p = findProduct(id);
    if (!p) return notFound(res, 'Producto no encontrado');
    const inUse = db.orders.some(o => o.items.some(it => it.productId === id));
    if (inUse) return badRequest(res, 'El producto está en una comanda abierta; ciérrala antes de borrarlo');
    p.active = false;
    saveDb();
    jsonRes(res, 200, { ok: true });
  },

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
      if (product && !product.openPrice) it.price = priceFor(order, product);
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
    const now = new Date().toISOString();
    const waiter = String(body.waiter || '').trim() || null;
    // Las líneas nuevas nacen en 'borrador': no llegan a preparación hasta confirmar el envío.
    if (product.openPrice) {
      // Precio libre: precio (y descripción opcional) en el momento de la venta; sin stock.
      const price = parsePrice(body.price);
      if (price === null) return badRequest(res, 'Indica el precio del producto');
      const name = String(body.name || '').trim() || product.name;
      order.items.push({ lineId: newId(), productId: product.id, name, category: product.category, price, qty, status: 'borrador', orderedBy: waiter, deliveredBy: null, addedAt: now, sentAt: null });
    } else {
      if (product.stock < qty) return badRequest(res, `Sin stock suficiente de "${product.name}" (quedan ${product.stock})`);
      product.stock -= qty;
      // Solo se agrupa con una línea aún sin enviar; si ya se envió (pedido, procesando…)
      // se crea una línea nueva para no mezclar estados de pedidos viejos y nuevos.
      const existing = order.items.find(it => it.productId === product.id && it.status === 'borrador');
      if (existing) {
        existing.qty += qty;
        existing.orderedBy = waiter || existing.orderedBy;
        existing.addedAt = now;
      } else {
        order.items.push({ lineId: newId(), productId: product.id, name: product.name, category: product.category, price: priceFor(order, product), qty, status: 'borrador', orderedBy: waiter, deliveredBy: null, addedAt: now, sentAt: null });
      }
    }
    saveDb();
    jsonRes(res, 200, order);
  },

  // Enviar el pedido: confirma todas las líneas en borrador y las pasa a preparación.
  'POST /api/orders/:id/send': (req, res, body, params) => {
    const order = findOrder(parseInt(params.id, 10));
    if (!order) return notFound(res, 'Comanda no encontrada');
    const waiter = String(body.waiter || '').trim() || null;
    const now = new Date().toISOString();
    let sent = 0;
    for (const it of order.items) {
      if (it.status === 'borrador') {
        it.status = 'pedido';
        it.sentAt = now; // desde aquí corren los tiempos de aviso
        if (waiter) it.orderedBy = waiter;
        sent++;
      }
    }
    if (!sent) return badRequest(res, 'No hay líneas pendientes de enviar');
    saveDb();
    jsonRes(res, 200, { ok: true, sent, order });
  },

  // Modificar una línea: cantidad (qtyDelta ±N) o estado (borrador/pedido/procesando/listo/entregado).
  'PUT /api/orders/:id/items/:lineId': (req, res, body, params) => {
    const order = findOrder(parseInt(params.id, 10));
    if (!order) return notFound(res, 'Comanda no encontrada');
    const item = order.items.find(it => it.lineId === parseInt(params.lineId, 10));
    if (!item) return notFound(res, 'Línea no encontrada');
    const product = findProduct(item.productId);
    if (body.qtyDelta !== undefined) {
      const delta = parseInt(body.qtyDelta, 10);
      if (!Number.isInteger(delta) || delta === 0) return badRequest(res, 'Cantidad inválida');
      if (delta > 0) {
        if (product && !product.openPrice) {
          if (product.stock < delta) return badRequest(res, `Sin stock suficiente de "${product.name}" (quedan ${product.stock})`);
          product.stock -= delta;
        }
        const now = new Date().toISOString();
        if (item.status === 'borrador') {
          item.qty += delta;
          item.addedAt = now;
        } else {
          // La línea ya se envió: las unidades nuevas van en una línea aparte (borrador)
          // para no mezclar estados de pedidos viejos y nuevos.
          const waiter = String(body.waiter || '').trim() || null;
          order.items.push({ lineId: newId(), productId: item.productId, name: item.name, category: item.category, price: item.price, qty: delta, status: 'borrador', orderedBy: waiter, deliveredBy: null, addedAt: now, sentAt: null });
        }
      } else {
        if (!canCancelLine(res, item, body.pin)) return;
        const removed = Math.min(-delta, item.qty);
        item.qty -= removed;
        if (product && !product.openPrice) product.stock += removed; // devolver al inventario
        if (item.qty <= 0) order.items = order.items.filter(it => it !== item);
      }
    }
    if (body.status !== undefined) {
      if (!LINE_STATUSES.includes(body.status)) return badRequest(res, 'Estado inválido');
      const waiter = String(body.waiter || '').trim() || null;
      item.status = body.status;
      if (body.status === 'pedido') {
        if (!item.sentAt) item.sentAt = new Date().toISOString();
        if (waiter && !item.orderedBy) item.orderedBy = waiter;
      }
      if (body.status === 'entregado') {
        item.deliveredBy = waiter;
        item.deliveredAt = new Date().toISOString();
      }
    }
    saveDb();
    jsonRes(res, 200, order);
  },

  'DELETE /api/orders/:id/items/:lineId': (req, res, body, params) => {
    const order = findOrder(parseInt(params.id, 10));
    if (!order) return notFound(res, 'Comanda no encontrada');
    const item = order.items.find(it => it.lineId === parseInt(params.lineId, 10));
    if (!item) return notFound(res, 'Línea no encontrada');
    if (!canCancelLine(res, item, body.pin)) return;
    const product = findProduct(item.productId);
    if (product && !product.openPrice) product.stock += item.qty;
    order.items = order.items.filter(it => it !== item);
    saveDb();
    jsonRes(res, 200, order);
  },

  'POST /api/orders/:id/pay': (req, res, body, params) => {
    const order = findOrder(parseInt(params.id, 10));
    if (!order) return notFound(res, 'Comanda no encontrada');
    if (!order.items.length) return badRequest(res, 'La comanda está vacía');
    const method = body.method === 'tarjeta' ? 'tarjeta' : 'efectivo';
    let card = null;
    if (method === 'tarjeta') {
      const c = body.card || {};
      const pos = String(c.pos || '').trim();
      const code = String(c.code || '').trim();
      if (!pos || !code) return badRequest(res, 'Pago con tarjeta: faltan el POS y el código de transacción');
      card = { pos, code, ref: String(c.ref || '').trim() };
    }
    const pl = order.priceListId != null ? findPriceList(order.priceListId) : null;
    const sale = {
      id: newId(),
      tableId: order.tableId,
      tableLabel: tableLabel(order.tableId),
      priceListName: pl ? pl.name : null,
      items: order.items,
      total: orderTotal(order),
      method,
      card,
      openedAt: order.openedAt,
      paidAt: new Date().toISOString(),
    };
    db.sales.push(sale);
    db.orders = db.orders.filter(o => o.id !== order.id);
    saveDb();
    jsonRes(res, 200, sale);
  },

  // Anular el pago de una venta de la caja actual (con clave de supervisor): la venta
  // deja de contar en caja e informes y la comanda vuelve a abrirse en su mesa.
  'POST /api/sales/:id/void': (req, res, body, params) => {
    if (!checkPin(res, body.pin)) return;
    const sale = db.sales.find(s => s.id === parseInt(params.id, 10));
    if (!sale) return notFound(res, 'Venta no encontrada');
    if (sale.voided) return badRequest(res, 'El pago ya está anulado');
    const since = lastCloseTime();
    if (since && sale.paidAt <= since) return badRequest(res, 'La venta pertenece a una caja ya cerrada; no se puede anular');
    const table = findTable(sale.tableId);
    if (!table) return badRequest(res, 'La mesa de la venta ya no existe');
    if (db.orders.some(o => o.tableId === table.id)) return badRequest(res, 'La mesa tiene otra comanda abierta; ciérrala antes de anular el pago');
    sale.voided = true;
    sale.voidedAt = new Date().toISOString();
    const order = {
      id: newId(),
      tableId: sale.tableId,
      priceListId: null, // las líneas conservan el precio al que se cobraron
      items: sale.items.map(it => ({ ...it })),
      openedAt: sale.openedAt,
    };
    db.orders.push(order);
    saveDb();
    jsonRes(res, 200, { ok: true, order });
  },

  'DELETE /api/orders/:id': (req, res, body, params) => {
    const order = findOrder(parseInt(params.id, 10));
    if (!order) return notFound(res, 'Comanda no encontrada');
    for (const it of order.items) {
      if (!canCancelLine(res, it, body.pin)) return; // líneas en preparación: solo con clave
    }
    for (const it of order.items) {
      const p = findProduct(it.productId);
      if (p && !p.openPrice) p.stock += it.qty;
    }
    db.orders = db.orders.filter(o => o.id !== order.id);
    saveDb();
    jsonRes(res, 200, { ok: true });
  },

  'POST /api/cashclose': (req, res) => {
    const pending = salesSinceLastClose();
    if (!pending.length) return badRequest(res, 'No hay ventas pendientes de cierre');
    const efectivo = round2(pending.filter(s => s.method === 'efectivo').reduce((a, s) => a + s.total, 0));
    const tarjeta = round2(pending.filter(s => s.method === 'tarjeta').reduce((a, s) => a + s.total, 0));
    const byProduct = {};
    for (const s of pending) {
      for (const it of s.items) {
        byProduct[it.name] = byProduct[it.name] || { name: it.name, qty: 0, total: 0 };
        byProduct[it.name].qty += it.qty;
        byProduct[it.name].total = round2(byProduct[it.name].total + it.price * it.qty);
      }
    }
    const close = {
      id: newId(),
      closedAt: new Date().toISOString(),
      since: lastCloseTime(),
      numSales: pending.length,
      efectivo,
      tarjeta,
      total: round2(efectivo + tarjeta),
      byProduct: Object.values(byProduct).sort((a, b) => b.total - a.total),
      salesDetail: pending.map(s => ({
        paidAt: s.paidAt,
        tableLabel: s.tableLabel,
        method: s.method,
        card: s.card || null,
        total: s.total,
      })),
    };
    db.cashCloses.push(close);
    saveDb();
    jsonRes(res, 200, close);
  },

  'GET /api/cashcloses': (req, res) => {
    jsonRes(res, 200, db.cashCloses.slice().reverse());
  },

  'GET /api/reports': (req, res, body, params, query) => {
    const days = Math.min(parseInt(query.days, 10) || 30, 365);
    const since = new Date(Date.now() - days * 86400000).toISOString();
    const sales = db.sales.filter(s => !s.voided && s.paidAt >= since);

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

  'GET /api/reports/restock': (req, res) => {
    const items = db.products
      .filter(p => p.active && !p.openPrice && (p.stock === 0 || (p.maxStock > 0 && p.stock < 0.2 * p.maxStock)))
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

// ---------- Interceptor de fetch ----------

const realFetch = window.fetch && window.fetch.bind(window);

window.fetch = async (input, opts = {}) => {
  const rawUrl = typeof input === 'string' ? input : input.url;
  if (!rawUrl.startsWith('/api/')) return realFetch(input, opts);

  const u = new URL(rawUrl, location.href);
  const method = (opts.method || 'GET').toUpperCase();
  const match = matchRoute(method, rawUrl.split('?')[0]);
  const res = { _status: 404, _data: { error: 'Ruta no encontrada' } };
  if (match) {
    let body = {};
    if (opts.body) {
      try { body = JSON.parse(opts.body); }
      catch { jsonRes(res, 400, { error: 'JSON inválido' }); return respond(res); }
    }
    try {
      match.handler(null, res, body, match.params, Object.fromEntries(u.searchParams));
    } catch (err) {
      console.error(err);
      jsonRes(res, 500, { error: 'Error interno' });
    }
  }
  return respond(res);
};

function respond(res) {
  return new Response(JSON.stringify(res._data), {
    status: res._status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

loadDb();

// ---------- Aviso de versión demo ----------

function insertBanner() {
  const banner = document.createElement('div');
  banner.style.cssText = 'background:#2b2620;color:#fff;padding:0.45rem 1rem;font-size:0.85rem;text-align:center;';
  banner.textContent = 'Versión de demostración — los datos se guardan solo en este navegador.';
  document.body.prepend(banner);
}

// El botón de restablecer va en Ajustes para evitar borrados accidentales.
function insertResetCard() {
  const ajustes = document.getElementById('view-ajustes');
  if (!ajustes) return;
  const card = document.createElement('div');
  card.className = 'card';
  card.style.marginTop = '1rem';
  const h2 = document.createElement('h2');
  h2.textContent = 'Demo';
  const p = document.createElement('p');
  p.className = 'hint';
  p.textContent = 'Borra todos los datos guardados en este navegador y vuelve a los datos de ejemplo.';
  const btn = document.createElement('button');
  btn.textContent = 'Restablecer datos de ejemplo';
  btn.className = 'btn-danger';
  btn.addEventListener('click', () => {
    if (!confirm('¿Borrar todos los datos de este navegador y volver a los de ejemplo?')) return;
    localStorage.removeItem(KEY);
    location.reload();
  });
  card.append(h2, p, btn);
  ajustes.append(card);
}

function insertDemoUi() {
  insertBanner();
  insertResetCard();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', insertDemoUi);
else insertDemoUi();

})();
