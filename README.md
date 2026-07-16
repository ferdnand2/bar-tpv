# Sistema del bar

TPV con comandas por mesa y estados de pedido, pantalla de preparación (cocina/barra), inventario con reposición, listas de precios con vigencia, plano de mesas, caja con cierres y anulación de pagos, meseros y códigos QR. App web local en español, sin dependencias (solo Node.js).

**Demo:** https://ferdnand2.github.io/bar-tpv/ — versión de demostración en GitHub Pages que guarda los datos en el navegador (localStorage). La versión real es esta, con servidor y base de datos (`data/db.json`); la demo (`docs/`) es solo para enseñar el sistema.

## Arrancar

```
node server.js
```

Abrir **http://localhost:3000** en el navegador. Desde tablets o móviles conectados a la misma wifi: `http://<IP-de-este-PC>:3000`.

Los datos se guardan en `data/db.json` (se crea solo, con datos de ejemplo la primera vez). Para empezar de cero, borra ese archivo. Las bases de datos de versiones anteriores se migran automáticamente al arrancar.

La **clave de supervisor** inicial es `0000` (cámbiala en Ajustes). Protege la entrada a Ajustes, los borrados, la anulación de pagos y la cancelación de líneas ya en preparación.

## Secciones

- **Mesas** — pestañas por local (si hay más de uno) y mesas por área; las áreas sin mesas (p. ej. Cocina) no aparecen aquí. Cada mesa se colorea según sus pedidos: 🟢 pendiente a tiempo, 🟡 espera alta, 🔴 demasiada espera, 🔵 todo entregado, ⚪ libre (hay leyenda en pantalla). Con **✏️ Distribución** se dibuja el plano real de cada área: las mesas se arrastran a su sitio (ratón o táctil) y el tirador ◢ cambia el tamaño del lienzo; todo queda guardado por área.
- **Comanda de una mesa** — productos por categoría con precios de la tarifa activa. Las líneas nuevas quedan **«Sin enviar»** hasta pulsar **📤 Enviar pedido** (así el cliente puede retractarse antes de que llegue a cocina). Cada línea muestra su estado (pedido → procesando → listo → entregado); tocar el estado **anula** la línea: pregunta cuántas unidades si hay varias, y exige clave de supervisor si ya se está preparando. Pedir un producto cuya línea ya está en preparación crea una línea nueva (no se mezclan estados). Además: descripción de la mesa, selector de tarifa, QR de la mesa (🖨), cobro en efectivo o tarjeta (con POS y código de transacción) y ticket imprimible.
- **Preparación** — cola de pedidos por área de preparación (cocina, barra…), según el envío por categoría configurado en Ajustes. Cada línea avanza con un botón: 👨‍🍳 Preparar → ✔ Listo → 🛎 Llevado al cliente (queda registrado el mesero que lo llevó), con colores según los tiempos de aviso.
- **Inventario** — tabla editable y ordenable (nombre, categoría, precio base, stock, mínimo, máximo). Bajo mínimo se marca en rojo. **📋 Informe de reposición**: agotados o por debajo del 20% del máximo, con cantidad sugerida (máximo − stock); imprimible. Los productos de **precio libre** (tipo «Varios») piden precio y descripción al vender y no controlan stock.
- **Precios** — listas de precios con **vigencia** (desde/hasta; fuera de vigencia rigen los precios base), **± ajuste masivo** (importe o % sobre el precio base; todo, una categoría o un producto) y **📱 QR de la carta**: al escanearlo se abre la carta pública con esos precios, sin revelar el nombre de la lista (también hay QR de la carta con precios base). Las listas se asignan a áreas en Ajustes o se eligen por comanda. **⬇ Exportar / ⬆ Importar**: descarga o carga un fichero JSON con los productos (lista base incluida) y todas las listas; el fichero va por nombres, así que sirve para llevar los precios a otra instalación. Importar crea o actualiza por nombre, no borra nada, no toca el stock de los productos existentes y pide la clave de supervisor.
- **Caja** — total desde el último cierre desglosado por efectivo/tarjeta, ventas pendientes con **↩ Anular** (anula el pago con clave de supervisor y reabre la comanda en su mesa; la venta deja de contar en caja e informes), cierre de caja con informe imprimible, histórico de cierres e informe de 30 días.
- **Ajustes** (con clave de supervisor) — nombre, IVA y clave; **terminales POS** (datáfonos); **meseros** (el mesero activo se elige en la cabecera y queda registrado al comandar y entregar); **categorías**: área de preparación y tiempos de aviso 🟡 Alto / 🔴 Demasiado en minutos; estructura de **locales → áreas → mesas** (una silla es una mesa de 1 puesto) con descripción por mesa, **⬇ Exportar / ⬆ Importar** de las salas (locales, áreas y mesas con su plano y tarifa, enlazada por nombre de lista; importar crea o actualiza por nombre y no borra nada), y **🖨 códigos QR de mesas** (al escanearlos se abre la comanda de esa mesa).

## Accesos por QR

- `?mesa=<id>` — abre directamente la comanda de esa mesa (QR impreso en la mesa).
- `?carta=base` o `?carta=<idLista>` — carta pública de solo lectura para clientes, sin el nombre de la lista.

Los QR se generan sin dependencias con `public/qr.js` (propio).

## Demo de GitHub Pages

`docs/` contiene la demo estática: el mismo frontend más `docs/localdb.js`, que implementa la API en el navegador sobre localStorage. Tras cambiar algo en `public/`, regenerarla con:

```
node tools/build-pages.js
```

(`docs/localdb.js` es fuente propia: si cambia la lógica de `server.js`, hay que replicar el cambio ahí a mano.)

## Modelo de datos

Un negocio tiene 1+ locales; un local tiene 1+ áreas (con tarifa, área de preparación y plano opcionales); un área tiene mesas (con puestos, descripción y posición en el plano). Las comandas pertenecen a una mesa y llevan la tarifa del área (modificable por comanda); sus líneas tienen estado (`borrador → pedido → procesando → listo → entregado`), mesero que comanda y que entrega, y hora de envío (de ahí salen los avisos de tiempo). El stock se descuenta al comandar y se devuelve al anular. Las ventas anuladas se conservan marcadas (`voided`) pero no cuentan en caja ni informes. Todo en `data/db.json` con escritura atómica y versión de esquema (`db.version`, actual 7) con migraciones automáticas.
