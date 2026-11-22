# Gastos familiares

App para registrar los gastos de la casa entre Iris y Sebas, por período (del 22 de un mes al 21 del siguiente), con límites por categoría.

Corre en su propio servidor (`gropa-server`) y se abre con Tailscale. La guía paso a paso está en [`ayuda/GUIA-INSTALACION.md`](ayuda/GUIA-INSTALACION.md).

## Qué hace

- **Registrar** (pantalla principal): monto, categoría, descripción y fecha, con lo que queda disponible en cada categoría. Por excepción, un gasto se puede descontar de otra categoría (por ejemplo, un gasto de Ocio que se paga con lo que sobró de Gasolina).
- **Resumen**: presupuesto, gastado y disponible del período, con avisos al acercarse al límite.
- **Compras en cuotas**: se registra el monto total y el número de cuotas (2 a 48). La app crea una cuota por período: la primera en la fecha de compra y las siguientes el 22 de cada corte (la última ajusta los centavos) y el Resumen muestra las compras activas con lo que falta; al pasar la última cuota, la compra deja de aparecer. Borrar una cuota borra la compra completa; editar la descripción o la categoría cambia todas las cuotas.
- **Gastos**: buscar por texto y filtrar por categoría, persona o todos los períodos. Cada uno edita o borra solo lo que registró.
- **Estadísticas**: en qué se fue el dinero, últimos 6 períodos, comparación con el período anterior, quién registró más y los 5 gastos más grandes.
- **Categorías**: crear, editar y quitar. Un límite nuevo aplica desde el período elegido; los anteriores conservan el suyo.
- **Datos**: exportar a Excel, descargar una copia completa y traer los datos de la versión anterior (Firebase).
- Se instala en el celular como app, con su propio ícono.
- **Sin conexión:** abre con la última copia guardada en el celular (con una franja que lo avisa) y permite registrar gastos, que quedan "pendientes de subir" y se suben solos al volver la conexión. Editar, borrar y cambiar categorías siguen necesitando conexión.

## Cómo está hecha

| Parte | Archivo |
| --- | --- |
| Servidor y API (Node.js, sin paquetes externos) | `server.js`, `lib/` |
| App del navegador | `public/` |
| Instalación en el servidor (Docker) | `servidor/` |
| Guía | `ayuda/GUIA-INSTALACION.md` |

- Los datos se guardan en `datos/gastos.json` en el servidor, con respaldo diario (últimos 30 días). Cada gasto se guarda por separado, así que dos registros al mismo tiempo nunca se pisan.
- El inicio de sesión usa cuentas de Firebase (correo y contraseña). El servidor revisa el comprobante de Google y que el correo esté autorizado en `datos/config.json`, que nunca se sube a GitHub.

La versión anterior (GitHub Pages + Firebase) quedó apagada el 22 de noviembre de 2026: GitHub Pages está desactivado y la base vieja de Firebase está cerrada.
