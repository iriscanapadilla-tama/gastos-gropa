#!/usr/bin/env bash
# Instala o actualiza Gastos familiares en el servidor.
# Uso (en el servidor):
#   cd ~/gastos-repo && git pull && bash servidor/actualizar.sh
#
# Qué hace:
# 1. Copia el código del repositorio a ~/gastos/app.
# 2. La primera vez crea ~/gastos/datos/config.json. Si encuentra la
#    configuración de Firebase de Ikasgela, la reutiliza (mismas cuentas).
#    Después nunca vuelve a tocar config.json ni los datos.
# 3. Levanta o reinicia el contenedor "gastos".
set -euo pipefail

ORIGEN="$(cd "$(dirname "$0")/.." && pwd)"
DESTINO="$HOME/gastos"
CONFIG="$DESTINO/datos/config.json"
IKASGELA_CONFIG="$HOME/ikasgela/sitio/js/firebase-config.js"
PUERTO=8097

echo "Origen:  $ORIGEN"
echo "Destino: $DESTINO"
mkdir -p "$DESTINO/app" "$DESTINO/datos/respaldos"

# 1. Código de la app.
rsync -a --delete "$ORIGEN/server.js" "$ORIGEN/package.json" "$ORIGEN/lib" "$ORIGEN/public" "$DESTINO/app/"

# 2. Configuración: solo la primera vez.
if [ ! -f "$CONFIG" ]; then
  cp "$ORIGEN/servidor/config.ejemplo.json" "$CONFIG"
  if [ -f "$IKASGELA_CONFIG" ] && ! grep -q 'apiKey: "PEGA_AQUI"' "$IKASGELA_CONFIG"; then
    python3 - "$IKASGELA_CONFIG" "$CONFIG" <<'PY'
import json, re, sys
js = open(sys.argv[1], encoding='utf-8').read()
cfg = json.load(open(sys.argv[2], encoding='utf-8'))
for k in ('apiKey', 'authDomain', 'projectId', 'appId'):
    m = re.search(k + r'\s*:\s*"([^"]+)"', js)
    if m:
        cfg['firebase'][k] = m.group(1)
json.dump(cfg, open(sys.argv[2], 'w', encoding='utf-8'), indent=2, ensure_ascii=False)
PY
    echo "Primera instalación: se copió la configuración de Firebase de Ikasgela (mismas cuentas)."
  else
    echo "Primera instalación: se creó config.json sin completar."
  fi
fi

# 3. Contenedor (corre con su usuario, así los respaldos son suyos).
printf 'UID_GASTOS=%s\nGID_GASTOS=%s\n' "$(id -u)" "$(id -g)" > "$DESTINO/.env"
cp "$ORIGEN/servidor/docker-compose.yml" "$DESTINO/"
cd "$DESTINO"
sudo docker compose up -d --force-recreate

sleep 3
if curl -fsS "http://127.0.0.1:$PUERTO/api/estado" >/dev/null; then
  echo "Listo: Gastos familiares responde en el servidor (127.0.0.1:$PUERTO)."
else
  echo "Atención: el contenedor no responde todavía. Revisen con: sudo docker logs gastos"
fi
if grep -q 'PEGA_AQUI\|CORREO_DE_' "$CONFIG"; then
  echo "Falta completar $CONFIG (paso 4 de la guía)."
fi
