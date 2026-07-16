// Generador de códigos QR sin dependencias (modo byte, corrección de errores nivel M,
// versiones 1-10: hasta ~200 caracteres, de sobra para las URL de las mesas).
// Expone qrSvg(texto, tamañoPx) -> string SVG, y qrMatrix(texto) -> matriz de booleanos.
(function (global) {
'use strict';

// ---- Aritmética en GF(256) (polinomio 0x11d) para Reed-Solomon ----

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(function () {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();

function gfMul(a, b) { return a && b ? EXP[LOG[a] + LOG[b]] : 0; }

// Polinomio generador de grado n (coeficientes en orden descendente, líder = 1).
function rsGenPoly(n) {
  let poly = [1];
  for (let i = 0; i < n; i++) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];                    // * x
      next[j + 1] ^= gfMul(poly[j], EXP[i]); // * α^i
    }
    poly = next;
  }
  return poly;
}

// Codewords de corrección de errores de un bloque de datos.
function rsEncode(data, ecLen) {
  const gen = rsGenPoly(ecLen);
  const res = data.concat(new Array(ecLen).fill(0));
  for (let i = 0; i < data.length; i++) {
    const factor = res[i];
    if (factor === 0) continue;
    for (let j = 0; j < gen.length; j++) res[i + j] ^= gfMul(gen[j], factor);
  }
  return res.slice(data.length);
}

// ---- Tablas del estándar (nivel M, versiones 1-10) ----

// [codewords EC por bloque, [[nº bloques, codewords de datos por bloque], ...]]
const EC_TABLE = [
  [10, [[1, 16]]],
  [16, [[1, 28]]],
  [26, [[1, 44]]],
  [18, [[2, 32]]],
  [24, [[2, 43]]],
  [16, [[4, 27]]],
  [18, [[4, 31]]],
  [22, [[2, 38], [2, 39]]],
  [22, [[3, 36], [2, 37]]],
  [26, [[4, 43], [1, 44]]],
];

// Posiciones de los patrones de alineamiento por versión.
const ALIGN = [
  [], [6, 18], [6, 22], [6, 26], [6, 30],
  [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50],
];

const MASKS = [
  (r, c) => (r + c) % 2 === 0,
  (r, c) => r % 2 === 0,
  (r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => (r * c) % 2 + (r * c) % 3 === 0,
  (r, c) => ((r * c) % 2 + (r * c) % 3) % 2 === 0,
  (r, c) => ((r + c) % 2 + (r * c) % 3) % 2 === 0,
];

// ---- Bits de formato y versión (códigos BCH) ----

function bitLen(v) { let n = 0; while (v) { n++; v >>>= 1; } return n; }

function bchFormat(data) { // data: 5 bits (nivel EC + máscara)
  let d = data << 10;
  while (bitLen(d) >= bitLen(0x537)) d ^= 0x537 << (bitLen(d) - bitLen(0x537));
  return ((data << 10) | d) ^ 0x5412;
}

function bchVersion(version) { // 18 bits para versiones >= 7
  let d = version << 12;
  while (bitLen(d) >= bitLen(0x1f25)) d ^= 0x1f25 << (bitLen(d) - bitLen(0x1f25));
  return (version << 12) | d;
}

const EC_LEVEL_M = 0; // bits de nivel: L=01, M=00, Q=11, H=10

// ---- Codificación de los datos ----

function dataCapacity(version) {
  const [, blocks] = EC_TABLE[version - 1];
  return blocks.reduce((s, [n, dc]) => s + n * dc, 0);
}

function buildCodewords(text) {
  const bytes = Array.from(new TextEncoder().encode(text));
  let version = 0;
  for (let v = 1; v <= 10; v++) {
    const ccBits = v <= 9 ? 8 : 16;
    if (4 + ccBits + 8 * bytes.length <= 8 * dataCapacity(v)) { version = v; break; }
  }
  if (!version) throw new Error('Texto demasiado largo para el QR (máx. versión 10)');

  // Buffer de bits: modo byte (0100) + longitud + datos
  const bits = [];
  const push = (value, len) => { for (let i = len - 1; i >= 0; i--) bits.push((value >>> i) & 1); };
  push(0b0100, 4);
  push(bytes.length, version <= 9 ? 8 : 16);
  for (const b of bytes) push(b, 8);

  const capacityBits = 8 * dataCapacity(version);
  push(0, Math.min(4, capacityBits - bits.length)); // terminador
  while (bits.length % 8 !== 0) bits.push(0);
  const data = [];
  for (let i = 0; i < bits.length; i += 8) {
    let b = 0;
    for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j];
    data.push(b);
  }
  const pads = [0xec, 0x11];
  for (let i = 0; data.length < dataCapacity(version); i++) data.push(pads[i % 2]);

  // División en bloques + EC + intercalado
  const [ecPerBlock, blockDefs] = EC_TABLE[version - 1];
  const blocks = [];
  let off = 0;
  for (const [n, dc] of blockDefs) {
    for (let i = 0; i < n; i++) {
      const d = data.slice(off, off + dc);
      off += dc;
      blocks.push({ data: d, ec: rsEncode(d, ecPerBlock) });
    }
  }
  const interleaved = [];
  const maxData = Math.max(...blocks.map(b => b.data.length));
  for (let i = 0; i < maxData; i++) for (const b of blocks) if (i < b.data.length) interleaved.push(b.data[i]);
  for (let i = 0; i < ecPerBlock; i++) for (const b of blocks) interleaved.push(b.ec[i]);
  return { version, codewords: interleaved, blocks, ecPerBlock };
}

// ---- Construcción de la matriz ----

function setupPatterns(m, size, version) {
  const finder = (r0, c0) => {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const rr = r0 + r, cc = c0 + c;
        if (rr < 0 || rr >= size || cc < 0 || cc >= size) continue;
        m[rr][cc] = (r >= 0 && r <= 6 && (c === 0 || c === 6)) ||
                    (c >= 0 && c <= 6 && (r === 0 || r === 6)) ||
                    (r >= 2 && r <= 4 && c >= 2 && c <= 4);
      }
    }
  };
  finder(0, 0);
  finder(0, size - 7);
  finder(size - 7, 0);
  for (let i = 8; i < size - 8; i++) {
    if (m[6][i] === null) m[6][i] = i % 2 === 0;
    if (m[i][6] === null) m[i][6] = i % 2 === 0;
  }
  const pos = ALIGN[version - 1];
  for (const r of pos) {
    for (const c of pos) {
      if (m[r][c] !== null) continue; // solapa con un patrón localizador
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          m[r + dr][c + dc] = Math.max(Math.abs(dr), Math.abs(dc)) !== 1;
        }
      }
    }
  }
}

function setupFormatInfo(m, size, maskId) {
  const bits = bchFormat((EC_LEVEL_M << 3) | maskId);
  for (let i = 0; i < 15; i++) {
    const mod = ((bits >> i) & 1) === 1;
    // vertical (columna 8)
    if (i < 6) m[i][8] = mod;
    else if (i < 8) m[i + 1][8] = mod;
    else m[size - 15 + i][8] = mod;
    // horizontal (fila 8)
    if (i < 8) m[8][size - i - 1] = mod;
    else if (i < 9) m[8][15 - i] = mod;
    else m[8][15 - i - 1] = mod;
  }
  m[size - 8][8] = true; // módulo oscuro fijo
}

function setupVersionInfo(m, size, version) {
  if (version < 7) return;
  const bits = bchVersion(version);
  for (let i = 0; i < 18; i++) {
    const mod = ((bits >> i) & 1) === 1;
    const a = Math.floor(i / 3), b = (i % 3) + size - 11;
    m[a][b] = mod;
    m[b][a] = mod;
  }
}

function mapData(m, size, codewords, maskId) {
  const maskFn = MASKS[maskId];
  let inc = -1, row = size - 1, bitIndex = 7, byteIndex = 0;
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col--;
    while (true) {
      for (let c = 0; c < 2; c++) {
        if (m[row][col - c] === null) {
          let dark = false;
          if (byteIndex < codewords.length) dark = ((codewords[byteIndex] >>> bitIndex) & 1) === 1;
          if (maskFn(row, col - c)) dark = !dark;
          m[row][col - c] = dark;
          bitIndex--;
          if (bitIndex === -1) { byteIndex++; bitIndex = 7; }
        }
      }
      row += inc;
      if (row < 0 || row >= size) { row -= inc; inc = -inc; break; }
    }
  }
}

function buildMatrix(version, codewords, maskId) {
  const size = 17 + 4 * version;
  const m = Array.from({ length: size }, () => new Array(size).fill(null));
  setupPatterns(m, size, version);
  setupFormatInfo(m, size, maskId);
  setupVersionInfo(m, size, version);
  mapData(m, size, codewords, maskId);
  return m;
}

// ---- Penalización estándar para elegir la mejor máscara ----

function penaltyLine(line) {
  let score = 0, run = 1;
  for (let i = 1; i < line.length; i++) {
    if (line[i] === line[i - 1]) run++;
    else { if (run >= 5) score += 3 + run - 5; run = 1; }
  }
  if (run >= 5) score += 3 + run - 5;
  // patrón parecido a un localizador (1011101 con 4 claros a un lado)
  for (let i = 0; i + 7 <= line.length; i++) {
    if (line[i] && !line[i + 1] && line[i + 2] && line[i + 3] && line[i + 4] && !line[i + 5] && line[i + 6]) {
      const before = i >= 4 && !line[i - 1] && !line[i - 2] && !line[i - 3] && !line[i - 4];
      const after = i + 11 <= line.length && !line[i + 7] && !line[i + 8] && !line[i + 9] && !line[i + 10];
      if (before || after) score += 40;
    }
  }
  return score;
}

function penalty(m) {
  const size = m.length;
  let score = 0;
  for (let i = 0; i < size; i++) {
    score += penaltyLine(m[i]);
    score += penaltyLine(m.map(row => row[i]));
  }
  for (let r = 0; r < size - 1; r++) {
    for (let c = 0; c < size - 1; c++) {
      if (m[r][c] === m[r][c + 1] && m[r][c] === m[r + 1][c] && m[r][c] === m[r + 1][c + 1]) score += 3;
    }
  }
  let dark = 0;
  for (const row of m) for (const cell of row) if (cell) dark++;
  score += Math.floor(Math.abs((dark * 100) / (size * size) - 50) / 5) * 10;
  return score;
}

// ---- API pública ----

function qrMatrix(text) {
  const { version, codewords } = buildCodewords(text);
  let best = null, bestScore = Infinity;
  for (let maskId = 0; maskId < 8; maskId++) {
    const m = buildMatrix(version, codewords, maskId);
    const score = penalty(m);
    if (score < bestScore) { bestScore = score; best = m; }
  }
  return best;
}

function qrSvg(text, size = 160) {
  const m = qrMatrix(text);
  const n = m.length, quiet = 4, total = n + quiet * 2;
  let path = '';
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (m[r][c]) path += `M${c + quiet} ${r + quiet}h1v1h-1z`;
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}" width="${size}" height="${size}" shape-rendering="crispEdges">` +
    `<rect width="${total}" height="${total}" fill="#fff"/><path d="${path}" fill="#000"/></svg>`;
}

global.qrSvg = qrSvg;
global.qrMatrix = qrMatrix;
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { qrSvg, qrMatrix, _internals: { buildCodewords, buildMatrix, rsEncode, rsGenPoly, gfMul, EXP, LOG, bchFormat, bchVersion, penalty, EC_LEVEL_M, setupPatterns, setupFormatInfo, setupVersionInfo, MASKS } };
}

})(typeof window !== 'undefined' ? window : globalThis);
