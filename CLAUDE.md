# Notas para trabajar en este repo

Sistema TPV de bar en español. Node.js **sin dependencias** (ni npm ni package.json): `server.js` (API REST + estáticos de `public/`) y frontend vanilla en `public/` (`app.js`, `index.html`, `styles.css`, `qr.js`). Datos en `data/db.json` (en .gitignore, nunca subirlo).

## Reglas del proyecto

- **⛔ No hacer push ni actualizar GitHub/Pages sin autorización expresa del usuario** — un posible cliente prueba la demo. Los commits locales sí están bien.
- **Toda lógica nueva de `server.js` hay que replicarla a mano en `docs/localdb.js`** (la demo reimplementa la API sobre localStorage). Después regenerar la demo: `node tools/build-pages.js` (copia `app.js`, `styles.css`, `qr.js` e `index.html` transformado de `public/` a `docs/`). `docs/localdb.js` es el único fichero de `docs/` que se edita a mano.
- **Cambios de esquema**: subir `db.version` (actual: 7) en el seed y añadir un bloque de migración `if (db.version < N)` en `migrateDb()` — en `server.js` **y** en `docs/localdb.js` (allí las migraciones parten de v2). Nunca romper datos existentes.
- Comentarios y UI en **español**. Estilo: sin dependencias, funciones pequeñas, validar en el servidor antes de mutar.
- Para probar mutaciones de la API **no usar el servidor del puerto 3000** (escribe en `data/db.json` real): copiar `server.js` al scratchpad y arrancarlo allí con datos limpios. Hay una suite end-to-end en el scratchpad de la sesión (`test-api.js`, 41 checks) que conviene mantener/extender.
- Tras tocar `server.js`, reiniciar el servidor del usuario (`node server.js`, puerto 3000, en background) — los estáticos no lo necesitan.

## Conceptos con semántica pactada (no cambiar sin preguntar)

- Estados de línea: `borrador → pedido → procesando → listo → entregado`. Borrador = sin enviar a cocina; solo se envía desde la mesa con «Enviar pedido». Los estados avanzan **solo** en la pestaña Preparación; en la comanda, tocar el chip = **anular** (pregunta unidades; clave de supervisor si está en `procesando` o después — regla `canCancelLine`).
- Al añadir un producto solo se agrupa con una línea **en borrador**; si ya se envió, línea nueva (no mezclar estados).
- Colores de mesa: verde = pedido pendiente a tiempo, amarillo/rojo = supera tiempos «Alto»/«Demasiado» de la categoría (corren desde `sentAt`), azul = todo entregado, normal = libre/pagada.
- La clave de supervisor (`config.supervisorPin`, nunca se envía al cliente — ver `publicConfig()`) protege: Ajustes, borrados, anulación de pagos y cancelaciones en preparación.
- Anular pago (`POST /api/sales/:id/void`): solo ventas de la caja actual; marca `voided` (fuera de caja e informes) y reabre la comanda en su mesa.
- QR: `?mesa=<id>` abre la comanda; `?carta=base|<idLista>` muestra la carta pública sin el nombre de la lista.

## Memoria

El detalle histórico de decisiones está en la memoria persistente (`bar-system.md`): modelo por versiones v2→v7, URLs del repo/demo y estado de la congelación de GitHub.
