#!/usr/bin/env bash
# Gestiona los 4 procesos del caso de uso. El puerto es la fuente de verdad (no hay pid files).
#   scripts/stack.sh start|stop|restart|status [usuarios|bonos|orquestador|front ...]
# Las variables de entorno se heredan: CAMPANIA_CERRADA=true scripts/stack.sh restart bonos
set -uo pipefail
RAIZ="$(cd "$(dirname "$0")/.." && pwd)"
RUN="$RAIZ/.run"
mkdir -p "$RUN"

TODOS=(usuarios bonos orquestador front)
puerto() { case $1 in usuarios) echo 8000;; bonos) echo 3001;; orquestador) echo 4000;; front) echo 5173;; *) echo 0;; esac; }

en_marcha() { lsof -ti :"$(puerto "$1")" -sTCP:LISTEN >/dev/null 2>&1; }

arrancar() {
  local s=$1
  if en_marcha "$s"; then echo "$s: ya arrancado (:$(puerto "$s"))"; return 0; fi
  case $s in
    usuarios)
      (cd "$RAIZ/usuarios-api" && set -a && . ../.env && set +a && exec .venv/bin/uvicorn app.main:app --port 8000) >"$RUN/$s.log" 2>&1 & ;;
    bonos)
      (cd "$RAIZ/bonos-api" && exec node --env-file=../.env src/index.js) >"$RUN/$s.log" 2>&1 & ;;
    orquestador)
      (cd "$RAIZ/orquestador" && exec node --env-file=../.env src/index.js) >"$RUN/$s.log" 2>&1 & ;;
    front)
      (cd "$RAIZ/front" && exec node_modules/.bin/vite) >"$RUN/$s.log" 2>&1 & ;;
    *) echo "servicio desconocido: $s" >&2; return 1 ;;
  esac
  for _ in $(seq 1 50); do
    en_marcha "$s" && { echo "$s: arrancado (:$(puerto "$s"))"; return 0; }
    sleep 0.2
  done
  echo "$s: NO arrancó, mira $RUN/$s.log" >&2
  return 1
}

parar() {
  local s=$1 pids
  pids=$(lsof -ti :"$(puerto "$s")" -sTCP:LISTEN 2>/dev/null || true)
  [ -z "$pids" ] && { echo "$s: ya parado"; return 0; }
  kill $pids 2>/dev/null
  for _ in $(seq 1 25); do en_marcha "$s" || { echo "$s: parado"; return 0; }; sleep 0.2; done
  kill -9 $pids 2>/dev/null; echo "$s: parado (kill -9)"
}

accion=${1:-status}; shift || true
servicios=("$@"); [ ${#servicios[@]} -eq 0 ] && servicios=("${TODOS[@]}")

rc=0
for s in "${servicios[@]}"; do
  case $accion in
    start) arrancar "$s" || rc=1 ;;
    stop) parar "$s" ;;
    restart) parar "$s" >/dev/null; arrancar "$s" || rc=1 ;;
    status) en_marcha "$s" && echo "$s: arriba (:$(puerto "$s"))" || echo "$s: caído" ;;
    *) echo "uso: $0 start|stop|restart|status [servicio...]" >&2; exit 2 ;;
  esac
done
exit $rc
