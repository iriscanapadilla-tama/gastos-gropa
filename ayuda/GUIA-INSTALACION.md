# Gastos familiares: guía de instalación en gropa-server

Esta guía deja la app de gastos en su servidor `gropa-server`, igual que Ikasgela: el código vive en GitHub, el servidor lo descarga de ahí y Tailscale la publica solo para sus dispositivos. No necesitan dominio ni abrir puertos en el router.

**Qué cambia frente a la versión anterior:**

- Los datos ya no están en Firebase. Viven en el servidor, en `~/gastos/datos/gastos.json`, con un respaldo automático cada día.
- Cada uno entra con su correo y contraseña. Si usan el mismo proyecto de Firebase que Ikasgela (recomendado), son **las mismas cuentas y contraseñas** de Ikasgela. Firebase solo confirma la contraseña; no guarda ningún gasto.
- La sesión dura un año en cada dispositivo. Ya no hay que tocar "Iris" o "Sebas" cada vez.

**Qué necesitan:** acceso por SSH al servidor (`ssh sebastian@gropa-server`), Tailscale en cada celular y computadora, e Ikasgela ya instalada (de ahí se toman los datos de Firebase).

## Paso 1. Descargar el código en el servidor (una sola vez)

El repositorio `gastos-gropa` es público, así que no hace falta llave. En el servidor:

```bash
git clone https://github.com/iriscanapadilla-tama/gastos-gropa.git ~/gastos-repo
```

Si algún día lo hacen privado, repitan el paso 6 de la guía de Ikasgela con este repositorio (otra llave, otro alias en `~/.ssh/config`).

## Paso 2. Revisar que el puerto esté libre

La app usará el puerto `8097` dentro de la laptop (Ikasgela usa el `8096`). Revisen que nadie más lo use:

```bash
sudo ss -ltnp | grep ':8097 ' || echo "Libre"
```

Debe decir **Libre**. Si aparece algo, avísenme y lo cambio en `servidor/docker-compose.yml` y en `servidor/actualizar.sh`.

## Paso 3. Instalar y levantar la app

```bash
bash ~/gastos-repo/servidor/actualizar.sh
```

Este comando crea la carpeta `~/gastos` con:

- `app`: el código.
- `datos`: los gastos (`gastos.json`), los respaldos diarios (`respaldos/`) y la configuración (`config.json`).
- `docker-compose.yml`: el contenedor `gastos`, que arranca solo cuando la laptop se enciende y también aparece en Portainer.

Al final debe decir **"Listo: Gastos familiares responde en el servidor"**. La primera vez también dice que falta completar `config.json`: es el paso 4.

## Paso 4. Completar la configuración

```bash
nano ~/gastos/datos/config.json
```

1. En `usuarios`, reemplacen `CORREO_DE_IRIS@gmail.com` y `CORREO_DE_SEBAS@gmail.com` por los correos con los que entran a Ikasgela. Dejen las comillas. Solo estos correos podrán entrar.
2. Revisen el bloque `firebase`. Si el paso 3 dijo "se copió la configuración de Firebase de Ikasgela", ya está completo. Si dice `PEGA_AQUI`, copien los valores de `apiKey`, `authDomain`, `projectId` y `appId` del archivo `~/ikasgela/sitio/js/firebase-config.js`.
3. No toquen `proyectoFirebaseAnterior`: es el proyecto viejo de donde se traen los gastos (paso 7).
4. Guarden con Ctrl + O y Enter, y salgan con Ctrl + X. No hace falta reiniciar nada.

**¿Por qué no está en GitHub?** El repositorio es público. Así sus correos nunca quedan publicados, y el script del paso 3 nunca vuelve a tocar este archivo.

## Paso 5. Publicarla con Tailscale

Primero vean qué números están ocupados:

```bash
sudo tailscale serve status
```

Elijan uno que **no** aparezca. Según la guía de Ikasgela, hoy están ocupados 443, 8443, 8444, 8445, 8446 y 10000, así que propongo el **8447**:

```bash
sudo tailscale serve --bg --https=8447 http://127.0.0.1:8097
sudo tailscale serve status
```

Debe aparecer este bloque nuevo, y las demás aplicaciones deben seguir igual:

```
https://gropa-server.tail4bb30e.ts.net:8447 (tailnet only)
|-- / proxy http://127.0.0.1:8097
```

La dirección de la app es **https://gropa-server.tail4bb30e.ts.net:8447**.

## Paso 6. Firebase

Si usan las cuentas de Ikasgela, **no hay que hacer nada**: la dirección `gropa-server.tail4bb30e.ts.net` ya está autorizada.

Solo si usan otro proyecto de Firebase: en ese proyecto, **Authentication** → **Método de acceso** (Sign-in method) → activen **Correo electrónico/contraseña**; luego **Usuarios** → **Agregar usuario** para cada uno; y en **Configuración** (Settings) → **Dominios autorizados** (Authorized domains) agreguen `gropa-server.tail4bb30e.ts.net`, sin `https://` ni número de puerto.

## Paso 7. Primer ingreso y traer los gastos de la versión anterior

1. Con Tailscale activo, abran la dirección del paso 5 y entren con su correo y contraseña.
2. Vayan a la pestaña **Datos** → **Traer datos de Firebase**. Debe decir cuántos gastos y categorías encontró y cuántos agregó.
3. Comparen el **Resumen** de este período con la app vieja: los montos deben coincidir.
4. Si lo presionan dos veces no pasa nada: no duplica.

## Paso 8. Instalarla en el celular

Hay que entrar **una vez** dentro de la app instalada, porque el celular la guarda aparte del navegador.

- **Android (Chrome):** abran la dirección → menú ⋮ → **Instalar aplicación** (o **Agregar a la pantalla principal**).
- **iPhone (Safari):** abran la dirección → botón **Compartir** → **Agregar a inicio**.

Aparece el ícono verde con la **Q**. Al abrirla, se ve sin barra del navegador y entra directo a **Registrar gasto**.

## Paso 9. Apagar la versión anterior (cuando ya confirmaron todo)

Háganlo solo después del paso 7, porque la importación lee de Firebase.

1. **GitHub Pages:** en el repositorio `gastos-gropa` → **Settings** → **Pages** → en **Source** elijan **None** (o **Unpublish site**). Así la app vieja deja de estar en internet.
2. **Datos viejos en Firebase:** hoy cualquiera con la dirección del proyecto `gastos-gropa` puede leerlos o borrarlos, porque la base quedó abierta. En la consola de Firebase, proyecto **gastos-gropa** → **Firestore Database** → **Reglas** (Rules), reemplacen todo por esto y toquen **Publicar**:

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} { allow read, write: if false; }
  }
}
```

3. Avísenme y borro el `index.html` viejo del repositorio.

## Cómo actualizar la app

Cuando haya cambios nuevos en GitHub:

```bash
cd ~/gastos-repo && git pull && bash servidor/actualizar.sh
```

Sus gastos y su `config.json` no se tocan.

## Respaldos

- **Automático:** cada día se guarda una copia en `~/gastos/datos/respaldos/` (por ejemplo `gastos-2026-11-15.json`). Se conservan los últimos 30 días.
- **Manual:** en la app, pestaña **Datos** → **Descargar copia completa**.
- **Para restaurar uno:**

```bash
cd ~/gastos && sudo docker compose stop
cp datos/gastos.json datos/gastos-antes-de-restaurar.json
cp datos/respaldos/gastos-AAAA-MM-DD.json datos/gastos.json
sudo docker compose start
```

Cambien `AAAA-MM-DD` por la fecha que quieren recuperar. Al restaurar se cierran las sesiones abiertas: hay que volver a entrar.

## Cómo pedir cambios

Abran una sesión de Claude con el repositorio `gastos-gropa` conectado y pidan el cambio (por ejemplo, "agrega una categoría de método de pago"). Yo lo pruebo y lo subo a GitHub para que lo revisen. Cuando lo aprueben, corran el comando de **Cómo actualizar la app**.

## Problemas frecuentes

| Lo que ven | Qué hacer |
| --- | --- |
| La página no abre | Revisen que Tailscale esté activo en ese dispositivo. Si lo está, en el servidor: `sudo docker ps --filter name=gastos` debe decir "Up". Si no aparece: `cd ~/gastos && sudo docker compose up -d`. |
| No abre después de un apagón | Esperen 2 o 3 minutos a que la laptop arranque y Tailscale se reconecte. Si sigue igual, usen los comandos de la fila anterior y revisen `sudo tailscale serve status`. |
| Abre en la laptop, pero no en otros dispositivos | Confirmen que el otro dispositivo está en la misma red de Tailscale. Si las otras apps abren y esta no: `sudo ufw allow in on tailscale0 to any port 8447 proto tcp`. |
| El script dice "port is already allocated" | Otra aplicación ya usa el 8097. Avísenme y cambio el número. |
| La app dice "Falta completar los datos de Firebase" o "no tiene correos autorizados" | Repitan el paso 4. |
| "config.json tiene un error de formato" | Casi siempre es una coma o unas comillas que faltan. Abran el archivo con `nano`, comparen con `~/gastos-repo/servidor/config.ejemplo.json` y corrijan. |
| "La cuenta … no tiene acceso a esta app" | Ese correo no está en `usuarios` de `config.json` o tiene un error de escritura (paso 4). |
| "El correo o la contraseña no coinciden" | Usen la misma contraseña de Ikasgela, o toquen **¿Olvidaste tu contraseña?** para recibir un enlace por correo. |
| "Esta dirección no está autorizada en Firebase" | Falta el paso 6 (solo si usan otro proyecto de Firebase). |
| Dice "Sin conexión con el servidor" | El celular perdió la conexión con Tailscale o el contenedor se detuvo. Revisen la primera fila. |
| "Traer datos de Firebase" da error | Revisen que la laptop tenga internet y que **no** hayan hecho todavía el punto 2 del paso 9. |
| El exportador a Excel no funciona | El dispositivo necesita internet para cargarlo. Recarguen la página. |
| Los cambios no se ven después de actualizar | Cierren la app del celular y vuelvan a abrirla. En la computadora, Ctrl + F5. |

## Probar la app en una computadora (opcional)

Con Node.js 20 o más reciente, desde la carpeta del repositorio:

```bash
GASTOS_MODO_PRUEBA=1 DATA_DIR=./datos-prueba node server.js
```

En Windows (PowerShell):

```powershell
$env:GASTOS_MODO_PRUEBA="1"; $env:DATA_DIR="datos-prueba"; node server.js
```

Abran http://localhost:8080 y entren con `iris@prueba.com` o `sebas@prueba.com`, sin contraseña. Es solo para probar: nunca usen el modo de prueba en el servidor.
