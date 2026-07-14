# Sistema del bar

TPV con comandas por mesa, inventario con reposición, listas de precios, locales/áreas/mesas y caja con cierres e informes. App web local sin dependencias (solo Node.js).

**Demo:** https://ferdnand2.github.io/bar-tpv/ — versión de demostración en GitHub Pages que guarda los datos en el navegador (localStorage). La versión real es esta, con servidor y base de datos (`data/db.json`); la demo (`docs/`) es solo para enseñar el sistema.

## Arrancar

```
node server.js
```

Abrir **http://localhost:3000** en el navegador. Desde tablets o móviles conectados a la misma wifi: `http://<IP-de-este-PC>:3000`.

Los datos se guardan en `data/db.json` (se crea solo, con datos de ejemplo la primera vez). Para empezar de cero, borra ese archivo. Las bases de datos de versiones anteriores se migran automáticamente al arrancar.

## Secciones

- **Mesas** — pestañas por local (si hay más de uno) y mesas agrupadas por área. Al tocar una mesa se abre su comanda: productos por categoría, cantidades con +/−, selector de tarifa de la comanda, y cobro en efectivo o tarjeta con ticket imprimible. "Anular" devuelve el stock.
- **Inventario** — tabla editable (nombre, categoría, precio base, stock, mínimo, **máximo**). Bajo mínimo se marca en rojo. **📋 Informe de reposición**: productos agotados o por debajo del 20% del stock máximo, con la cantidad sugerida para pedir al proveedor (máximo − stock); imprimible.
- **Precios** — listas de precios libres: cada lista puede fijar precios distintos por producto (vacío = precio base). Se asignan a áreas en Ajustes (p. ej. tarifa de terraza) o se eligen manualmente en una comanda (p. ej. cliente especial). Cualquier lista, y la carta base, se pueden imprimir.
- **Caja** — total en caja desde el último cierre desglosado por efectivo/tarjeta, cierre de caja, histórico de cierres e informe de 30 días con los productos más vendidos.
- **Ajustes** — nombre del negocio e IVA del ticket; estructura de **locales → áreas → mesas**. Una silla es una mesa de 1 puesto (botones "+ Mesa" y "+ Silla"). Cada área puede tener asignada una lista de precios, que heredan sus comandas.

## Demo de GitHub Pages

`docs/` contiene la demo estática: el mismo frontend más `docs/localdb.js`, que implementa la API en el navegador sobre localStorage. Tras cambiar algo en `public/`, regenerarla con:

```
node tools/build-pages.js
```

(`docs/localdb.js` es fuente propia: si cambia la lógica de `server.js`, hay que replicar el cambio ahí a mano.)

## Modelo de datos

Un negocio tiene 1+ locales; un local tiene 1+ áreas; un área tiene mesas (con nº de puestos). Las comandas pertenecen a una mesa y llevan la tarifa del área (modificable por comanda). El stock se descuenta al comandar y se devuelve al anular. Todo en `data/db.json` con escritura atómica.
