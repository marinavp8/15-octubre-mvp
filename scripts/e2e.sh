#!/usr/bin/env bash
# Pruebas de extremo a extremo con los servicios reales (Postgres, Redis y Mongo deben estar arriba).
# Reinicia usuarios, bonos y orquestador para partir de un estado conocido y los deja normales al acabar.
set -uo pipefail
RAIZ="$(cd "$(dirname "$0")/.." && pwd)"
STACK="$RAIZ/scripts/stack.sh"
LOG_ORQ="$RAIZ/.run/orquestador.log"
set -a; . "$RAIZ/.env"; set +a

PG() { psql "$POSTGRES_URL" -Atq -c "$1"; }
MONGO() { mongosh --quiet "$MONGODB_URI/$MONGODB_DB" --eval "$1"; }
# la URL redis://:pass@host:puerto lleva usuario vacío y redis-cli -u lo rechaza: se pasa la clave por entorno
REDIS() { REDISCLI_AUTH="${REDIS_URL#redis://:}"; REDISCLI_AUTH="${REDISCLI_AUTH%%@*}" redis-cli -h localhost -p 6379 --no-auth-warning "$@"; }
ORQ=$ORQUESTADOR_URL

PASS=0; FAIL=0
# Lo creado se anota en un fichero (los arrays no sobreviven a $(...)) para borrarlo al final
CREADO="$(mktemp)"
ok()  { PASS=$((PASS+1)); echo "  ✓ $1"; }
ko()  { FAIL=$((FAIL+1)); echo "  ✗ $1"; }
eq()  { [ "$2" = "$3" ] && ok "$1" || ko "$1 (esperado '$3', obtenido '$2')"; }
caso(){ echo; echo "▶ $1"; }

email() { local e="e2e-$RANDOM$RANDOM@example.com"; echo "email $e" >>"$CREADO"; echo "$e"; }
alta()  { # alta <nombre> <email> -> sagaId
  local id; id=$(curl -s -XPOST "$ORQ/altas" -H 'content-type: application/json' \
    -d "{\"nombre\":\"$1\",\"email\":\"$2\"}" | jq -r .sagaId); echo "saga $id" >>"$CREADO"; echo "$id"; }
estado() { curl -s "$ORQ/altas/$1" | jq -r .estado; }
esperar() { # esperar <sagaId> <estado1|estado2> [segundos] -> JSON final
  local fin=$((SECONDS + ${3:-30})) j
  while [ $SECONDS -lt $fin ]; do
    j=$(curl -s "$ORQ/altas/$1")
    [[ "$(jq -r .estado <<<"$j")" =~ ^($2)$ ]] && { echo "$j"; return 0; }
    sleep 0.1
  done
  echo "$j"; return 1
}
intentos() { grep -c "\[$1\] saga $2" "$LOG_ORQ" || true; }

# Conecta por WebSocket y devuelve "estado1,estado2,... codigoDeCierre"
ws_estados() {
  (cd "$RAIZ/orquestador" && node --input-type=module -e "
    import WebSocket from 'ws'
    const ws = new WebSocket(process.argv[1]); const est = []
    ws.on('message', (m) => est.push(JSON.parse(m.toString()).estado))
    ws.on('close', (c) => { console.log(est.join(',') + ' ' + c); process.exit(0) })
    setTimeout(() => { console.log(est.join(',') + ' timeout'); process.exit(1) }, 30000)
  " "ws://localhost:4000/altas/$1/ws")
}

limpiar() {
  echo; echo "▶ Limpieza"
  while read -r tipo valor; do
    case $tipo in
      email) PG "DELETE FROM usuarios WHERE email='$valor'" ;;
      saga)
        MONGO "db.bonos.deleteMany({sagaId:'$valor'})" >/dev/null
        REDIS del "saga:$valor" "bull:usuarios.crear:$valor" "bull:bonos.crear:$valor" "bull:usuarios.compensar:$valor" >/dev/null ;;
    esac
  done <"$CREADO"
  rm -f "$CREADO" /tmp/e2e_u1 /tmp/e2e_u2 /tmp/e2e_b1 /tmp/e2e_b2
  "$STACK" restart bonos orquestador >/dev/null   # estado normal (campaña abierta)
  echo "  datos de prueba borrados; servicios en estado normal"
}
trap limpiar EXIT

echo "Preparando: reiniciando usuarios, bonos y orquestador"
"$STACK" restart usuarios bonos orquestador || { echo "no arrancó el stack"; exit 1; }

# ───────────────────────────────────────────────────────────────
caso "1. Flujo feliz"
E=$(email); S=$(alta "Ana Ruiz" "$E")
J=$(esperar "$S" completada 15)
eq "saga completada" "$(jq -r .estado <<<"$J")" completada
eq "usuario activo en la respuesta" "$(jq -r .usuario.estado <<<"$J")" activo
eq "bono de 1000 céntimos" "$(jq -r .bono.importeCents <<<"$J")" 1000
eq "una fila en Postgres, activa" "$(PG "SELECT count(*)||estado FROM usuarios WHERE email='$E' GROUP BY estado")" "1activo"
eq "un bono en Mongo" "$(MONGO "db.bonos.countDocuments({sagaId:'$S'})")" 1

# ───────────────────────────────────────────────────────────────
caso "2. Email duplicado → fallida, sin compensar"
S2=$(alta "Otra Persona" "$E")
J=$(esperar "$S2" fallida 15)
eq "saga fallida" "$(jq -r .estado <<<"$J")" fallida
eq "mensaje de error" "$(jq -r .error <<<"$J")" "El email ya está registrado"
eq "sin reintentos (1 intento)" "$(intentos usuarios.crear "$S2")" 1
eq "sin bono en Mongo" "$(MONGO "db.bonos.countDocuments({sagaId:'$S2'})")" 0
eq "el usuario original sigue activo" "$(PG "SELECT estado FROM usuarios WHERE email='$E'")" activo

# ───────────────────────────────────────────────────────────────
caso "3. Campaña cerrada → 3 reintentos, compensación (el usuario se borra y puede repetir el alta)"
CAMPANIA_CERRADA=true "$STACK" restart bonos >/dev/null
E=$(email); S=$(alta "Luis Gil" "$E")
J=$(esperar "$S" compensada 30)
eq "saga compensada" "$(jq -r .estado <<<"$J")" compensada
eq "error legible" "$(jq -r .error <<<"$J")" "No se pudo crear el bono"
eq "usuario compensado con motivo" "$(jq -r '.usuario.estado+"/"+.usuario.motivo' <<<"$J")" "compensado/bono_no_creado"
eq "3 intentos de bonos.crear" "$(intentos bonos.crear "$S")" 3
eq "Postgres: el registro se ha borrado" "$(PG "SELECT count(*) FROM usuarios WHERE email='$E'")" 0
eq "sin bono en Mongo" "$(MONGO "db.bonos.countDocuments({sagaId:'$S'})")" 0
"$STACK" restart bonos >/dev/null                   # campaña abierta otra vez
S3=$(alta "Luis Gil" "$E")                          # mismo email: ahora sí se puede
J=$(esperar "$S3" "completada|fallida|compensada" 15)
eq "repetir el alta con el mismo email completa" "$(jq -r .estado <<<"$J")" completada
eq "y recibe su bono" "$(jq -r .bono.importeCents <<<"$J")" 1000
eq "una fila activa en Postgres" "$(PG "SELECT count(*)||estado FROM usuarios WHERE email='$E' GROUP BY estado")" "1activo"

# ───────────────────────────────────────────────────────────────
caso "4. Idempotencia en las APIs de dominio"
SG=$(uuidgen | tr A-Z a-z); echo "saga $SG" >>"$CREADO"; E=$(email)
U='{"sagaId":"'$SG'","nombre":"Idem","email":"'$E'"}'
c1=$(curl -s -o /tmp/e2e_u1 -w '%{http_code}' -XPOST "$USUARIOS_API_URL/usuarios" -H 'content-type: application/json' -d "$U")
c2=$(curl -s -o /tmp/e2e_u2 -w '%{http_code}' -XPOST "$USUARIOS_API_URL/usuarios" -H 'content-type: application/json' -d "$U")
eq "usuarios: 201 y luego 200" "$c1/$c2" "201/200"
eq "usuarios: mismo id" "$(jq -r .id /tmp/e2e_u1)" "$(jq -r .id /tmp/e2e_u2)"
eq "usuarios: una sola fila" "$(PG "SELECT count(*) FROM usuarios WHERE saga_id='$SG'")" 1
UID_=$(jq -r .id /tmp/e2e_u1)
B='{"sagaId":"'$SG'","usuarioId":"'$UID_'","tipo":"bienvenida","importeCents":1000}'
b1=$(curl -s -o /tmp/e2e_b1 -w '%{http_code}' -XPOST "$BONOS_API_URL/bonos" -H 'content-type: application/json' -d "$B")
b2=$(curl -s -o /tmp/e2e_b2 -w '%{http_code}' -XPOST "$BONOS_API_URL/bonos" -H 'content-type: application/json' -d "$B")
eq "bonos: 201 y luego 200" "$b1/$b2" "201/200"
eq "bonos: mismo id" "$(jq -r .id /tmp/e2e_b1)" "$(jq -r .id /tmp/e2e_b2)"
eq "bonos: un solo documento" "$(MONGO "db.bonos.countDocuments({sagaId:'$SG'})")" 1
K='{"sagaId":"'$SG'","motivo":"bono_no_creado"}'
k1=$(curl -s -XPOST "$USUARIOS_API_URL/usuarios/$UID_/compensar" -H 'content-type: application/json' -d "$K")
k2=$(curl -s -XPOST "$USUARIOS_API_URL/usuarios/$UID_/compensar" -H 'content-type: application/json' -d "$K")
eq "compensar repetido devuelve lo mismo" "$k1" "$k2"
eq "compensar borra el registro" "$(PG "SELECT count(*) FROM usuarios WHERE saga_id='$SG'")" 0

# ───────────────────────────────────────────────────────────────
caso "5. Recuperación: el orquestador cae a mitad de saga"
"$STACK" stop bonos >/dev/null                      # el bono no puede crearse → saga en usuario_creado
E=$(email); S=$(alta "Eva Mora" "$E")
esperar "$S" usuario_creado 15 >/dev/null
eq "saga a mitad: usuario_creado" "$(estado "$S")" usuario_creado
kill -9 "$(lsof -ti :4000 -sTCP:LISTEN)"; sleep 0.3  # caída brusca, sin cierre ordenado
lsof -ti :4000 -sTCP:LISTEN >/dev/null && ko "el orquestador sigue vivo" || ok "orquestador caído (kill -9)"
eq "el estado sobrevive en Redis" "$(REDIS get "saga:$S" | jq -r .estado)" usuario_creado
"$STACK" start bonos orquestador >/dev/null          # vuelven los dos
J=$(esperar "$S" "completada|compensada" 90)
eq "la saga se retoma y completa" "$(jq -r .estado <<<"$J")" completada
eq "sin usuarios duplicados" "$(PG "SELECT count(*) FROM usuarios WHERE email='$E'")" 1
eq "un solo bono" "$(MONGO "db.bonos.countDocuments({sagaId:'$S'})")" 1

# ───────────────────────────────────────────────────────────────
caso "6. WebSocket: el servidor empuja los estados (sin polling)"
E=$(email); S=$(alta "Ines Lopez" "$E")
R=$(ws_estados "$S")
eq "alta feliz: último estado y cierre limpio" "$(awk '{n=split($1,a,","); print a[n]" "$2}' <<<"$R")" "completada 1000"
CAMPANIA_CERRADA=true "$STACK" restart bonos >/dev/null
E=$(email); S=$(alta "Pablo Sanz" "$E")
R=$(ws_estados "$S")
[[ "$R" == *usuario_creado* ]] && ok "se ve el estado intermedio usuario_creado" || ko "falta usuario_creado en: $R"
eq "alta compensada: último estado y cierre limpio" "$(awk '{n=split($1,a,","); print a[n]" "$2}' <<<"$R")" "compensada 1000"
eq "saga inexistente: cierre 4404" "$(ws_estados "$(uuidgen | tr A-Z a-z)")" " 4404"
"$STACK" restart bonos >/dev/null

# ───────────────────────────────────────────────────────────────
echo; echo "Resultado: $PASS correctas, $FAIL fallidas"
[ $FAIL -eq 0 ]
