# Alta de usuario con bono de bienvenida

Saga de dos pasos con compensación. Especificación completa en [`CASODEUSOMICIRO.md`](CASODEUSOMICIRO.md).

```
Front :5173 ──▶ Orquestador :4000 ──▶ API usuarios :8000 ──▶ Postgres (altas)
                 │  BullMQ + Redis  └─▶ API bonos    :3001 ──▶ Mongo    (altas)
```

| Carpeta | Qué es | Tests |
| --- | --- | --- |
| `usuarios-api/` | FastAPI + Postgres | `.venv/bin/python -m pytest` (7) |
| `bonos-api/` | Express + Mongo | `npm test` (6, usa la base `altas_test`) |
| `orquestador/` | Express + BullMQ | `npm test` (20, Redis real + APIs simuladas) |
| `front/` | Vite + React 19 + TS | `npm test` (formato de euros) |
| `scripts/` | Arranque del stack y pruebas e2e | `scripts/e2e.sh` (37 comprobaciones) |

## Requisitos

- Postgres y Redis de `infra-local` arriba (`academy-postgres`, `academy-redis`) y Mongo en `localhost:27017`.
- Base `altas` creada en Postgres: `CREATE DATABASE altas;` (las tablas y los índices se crean al arrancar).
- Node 24 (usa `node --env-file`), Python 3.10 y `uv`.
- `.env` en la raíz, copiado de `.env.example` con las credenciales reales. No se sube al repo.

## Instalación

```
(cd usuarios-api && uv venv --python 3.10 .venv && uv pip install -r requirements.txt --python .venv/bin/python)
for d in bonos-api orquestador front; do (cd $d && npm install); done
```

## Arranque

```
scripts/stack.sh start            # los cuatro servicios; logs en .run/
scripts/stack.sh status
scripts/stack.sh restart bonos    # uno solo
scripts/stack.sh stop
```

Abre http://localhost:5173. Cada servicio también se puede arrancar a mano (ver `scripts/stack.sh`).

## Forzar la compensación

La API de bonos cierra la campaña con una variable de entorno:

```
CAMPANIA_CERRADA=true scripts/stack.sh restart bonos   # el alta termina en "compensada"
scripts/stack.sh restart bonos                         # vuelve a la normalidad
```

## Pruebas e2e

```
scripts/e2e.sh
```

Reinicia usuarios, bonos y orquestador, y comprueba contra Postgres, Mongo y Redis reales:

1. Flujo feliz.
2. Email duplicado: `fallida`, un solo intento, sin compensar.
3. Campaña cerrada: 3 intentos de `bonos.crear`, compensación (el registro se borra, sin bono) y repetir el alta con el mismo email completa y recibe su bono.
4. Idempotencia de ambas APIs (201 y luego 200, un solo registro) y compensación repetida.
5. Caída brusca del orquestador (`kill -9`) a mitad de saga: al volver, la saga se retoma y se completa sin duplicados.
6. WebSocket: el servidor empuja los estados (incluido el intermedio `usuario_creado`), cierra con 1000 al terminar y con 4404 si la saga no existe.

Al terminar borra lo que creó (solo emails `e2e-*`) y deja los servicios en estado normal. Sale con código distinto de 0 si algo falla.

## Decisiones que complementan el documento

- Errores `400` y `409` de usuarios no se reintentan: la saga pasa a `fallida`. Un `400` de bonos compensa sin reintentar.
- Con 3 intentos, el backoff exponencial desde 1 s solo produce dos esperas (1 s y 2 s).
- Si la compensación agota sus 5 intentos, la saga se queda en `compensando` (job fallido en BullMQ y aviso en el log).
- El front no hace polling: abre un WebSocket `ws://localhost:4000/altas/:sagaId/ws`. Al conectar recibe el estado actual y luego cada cambio (mismo JSON que `GET /altas/:sagaId`); al llegar a un estado final el servidor cierra con 1000. Si se corta, el front reconecta (hasta 5 fallos seguidos) y recibe de nuevo el estado actual. Cada cambio de saga se publica en Redis (pub/sub), así que funcionaría con varias instancias. `GET /altas/:sagaId` se mantiene para clientes sin WebSocket.
- El WebSocket rechaza (403) un `Origin` distinto del front; los clientes sin `Origin` (curl, scripts) pasan.
- Compensar **borra** el registro del usuario (así el email queda libre para repetir el alta); la saga sigue mostrando `usuario.estado: compensado` y el motivo, que solo se guarda en Redis y en el log.
- Como el registro desaparece, `saga_id` único ya no impide recrear el usuario; lo evita el orquestador, que solo procesa cada job si la saga está en la fase esperada.
- La respuesta de una saga compensada incluye `id`, `estado` y `motivo` del usuario, sin `nombre` ni `email`.
- Caso no cubierto: si Python crea el usuario pero la respuesta se pierde por un timeout, la saga acaba `fallida` con un usuario activo huérfano.
- Los emails se guardan en minúsculas.
- Mongo local no tiene autenticación: solo vale para desarrollo.
