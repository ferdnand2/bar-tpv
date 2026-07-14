// Regenera docs/ (demo de GitHub Pages) a partir de public/.
// docs/localdb.js es fuente propia y no se toca. Ejecutar tras cambiar el frontend:
//   node tools/build-pages.js
const fs = require('fs');
const path = require('path');

const pub = path.join(__dirname, '..', 'public');
const docs = path.join(__dirname, '..', 'docs');

fs.mkdirSync(docs, { recursive: true });
for (const f of ['styles.css', 'app.js']) {
  fs.copyFileSync(path.join(pub, f), path.join(docs, f));
}

let html = fs.readFileSync(path.join(pub, 'index.html'), 'utf8');
html = html.replace('<title>Bar TPV</title>', '<title>Bar TPV — demo</title>');
html = html.replace('<script src="app.js"></script>',
  '<script src="localdb.js"></script>\n<script src="app.js"></script>');
fs.writeFileSync(path.join(docs, 'index.html'), html);

console.log('docs/ regenerado desde public/');
