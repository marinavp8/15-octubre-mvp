# Caso de uso: alta de usuario con bono de bienvenida

Saga de dos pasos con compensación. El front solo habla con el orquestador. Las dos APIs de dominio no se llaman entre sí.

## Servicios

| Proceso | Tecnología | Puerto | Responsabilidad |
| --- | --- | --- | --- |
| Front | Vite + React 19 + TypeScript | 5173 | Formulario de alta y consulta del resultado |
| Orquestador | Node + Express + BullMQ | 4000 | Saga, colas y respuesta al front |
| API usuarios | Python (FastAPI) + PostgreSQL | 8000 | Alta y compensación del usuario |
| API bonos | Express + MongoDB (driver nativo) | 3001 | Alta del bono de bienvenida |
| Redis | Docker `academy-redis` (infra-local), con password | 6379 | Colas BullMQ y estado de la saga |
| Postgres | Docker `academy-postgres` (infra-local), usuario `admin` | 5432 | Usuarios, base `altas` |
| Mongo | Instalado en la máquina, sin autenticación | 27017 | Bonos, base `altas` |

Postgres y Redis salen del compose de `/Users/joseviejo/2026/infra-local`. La base por defecto del contenedor es `academy_db`; la saga usa la base `altas`, creada en ese mismo Postgres. MongoDB está en el host, en `localhost:27017`, sin usuario ni password.

El orquestador no guarda negocio. Redis guarda el estado de la saga y las colas. BullMQ vive en Node, así que los workers están en el orquestador y llaman a las dos APIs por HTTP.

## Flujo feliz

1. El front envía `POST /altas` con nombre y email.
2. El orquestador crea la saga (`pendiente`) y encola `usuarios.crear`.
3. El worker llama a Python. Python inserta el usuario en Postgres con estado `activo` y devuelve el usuario.
4. El orquestador guarda `usuarioId` y encola `bonos.crear`.
5. El worker llama a Express. Express inserta el bono en Mongo y devuelve el bono.
6. La saga pasa a `completada`.
7. El front consulta `GET /altas/:sagaId` y recibe el usuario y el bono.

```mermaid
sequenceDiagram
  participant Front as Vite
  participant Orq as Orquestador
  participant Q as BullMQ
  participant Py as API usuarios
  participant Ex as API bonos

  Front->>Orq: POST /altas
  Orq->>Q: usuarios.crear
  Orq-->>Front: 202 sagaId
  Q->>Py: POST /usuarios
  Py-->>Q: usuario activo
  Q->>Ex: POST /bonos
  Ex-->>Q: bono
  Front->>Orq: GET /altas/:sagaId
  Orq-->>Front: completada, usuario y bono
```

## Compensación

La compensación deshace el alta del usuario cuando el bono no se crea.

1. `bonos.crear` agota los reintentos.
2. El orquestador encola `usuarios.compensar` con el `usuarioId` y el `sagaId`.
3. Python **elimina el registro del usuario** en Postgres, de modo que el email queda libre y la persona puede repetir el alta. El motivo `bono_no_creado` solo se anota en el log.
4. La saga pasa a `compensada`.
5. El front recibe el error y la confirmación de que el usuario quedó compensado.

Si el alta en Postgres falla, no hay nada que compensar: la saga pasa a `fallida`.

```mermaid
sequenceDiagram
  participant Q as BullMQ
  participant Py as API usuarios
  participant Ex as API bonos
  participant Front as Vite

  Q->>Py: POST /usuarios
  Py-->>Q: usuario activo
  Q->>Ex: POST /bonos
  Ex-->>Q: error
  Q->>Py: POST /usuarios/:id/compensar
  Py-->>Q: usuario compensado
  Front->>Front: GET /altas/:sagaId
  Note over Front: compensada, usuario revertido
```

## Estados de la saga

| Estado | Significado |
| --- | --- |
| `pendiente` | Saga creada, alta de usuario en curso |
| `usuario_creado` | Usuario activo en Postgres, bono en curso |
| `completada` | Usuario activo y bono creado |
| `compensando` | El bono falló y la compensación está en cola (se escribe al encolar `usuarios.compensar`) |
| `compensada` | Usuario eliminado de Postgres |
| `fallida` | El usuario no llegó a crearse |

## Colas BullMQ

Tres colas. Cada job lleva `sagaId` como `jobId` para que un reintento no duplique el trabajo.

| Cola | Job | Éxito | Fallo |
| --- | --- | --- | --- |
| `usuarios.crear` | Alta en Python | Encola `bonos.crear` | Saga `fallida` |
| `bonos.crear` | Alta en Express | Saga `completada` | Encola `usuarios.compensar` |
| `usuarios.compensar` | Compensa en Python | Saga `compensada` | Reintenta con backoff |

Errores no reintentables: en `usuarios.crear`, un `409` (email duplicado) o un `400` (validación) no se reintentan; el job falla de inmediato (`UnrecoverableError` en BullMQ) y la saga pasa a `fallida` con un mensaje claro, sin compensar. En `bonos.crear`, un `400` va directo a compensación; cualquier otro fallo agota los reintentos y compensa.

Reintentos de `bonos.crear`: 3 intentos, backoff exponencial (1s, 2s, 4s). La compensación tiene 5 intentos. Un worker caído a mitad de saga se recupera al rearrancar: la saga sigue en Redis y el job pendiente sigue en la cola.

## API usuarios (Python + Postgres)

Base `altas`. Tabla `usuarios`.

| Campo | Tipo |
| --- | --- |
| `id` | uuid, clave primaria |
| `saga_id` | uuid, único |
| `nombre` | text |
| `email` | text, único |
| `estado` | `activo` (un usuario compensado se elimina, no se marca) |
| `creado_en` | timestamptz |

`POST /usuarios`

```json
{
  "sagaId": "7c9e6679-7425-40de-944b-e07fc1f90ae7",
  "nombre": "Ana Ruiz",
  "email": "ana@example.com"
}
```

Respuesta `201`:

```json
{
  "id": "3f1c2a44-1b0e-4c3a-9a11-0e5b6c7d8e9f",
  "sagaId": "7c9e6679-7425-40de-944b-e07fc1f90ae7",
  "nombre": "Ana Ruiz",
  "email": "ana@example.com",
  "estado": "activo"
}
```

`POST /usuarios/:id/compensar`

```json
{
  "sagaId": "7c9e6679-7425-40de-944b-e07fc1f90ae7",
  "motivo": "bono_no_creado"
}
```

Borra el registro. Respuesta `200` con `{ id, sagaId, estado: "compensado", motivo }`. Es idempotente: si el usuario ya no existe, responde lo mismo. Si el usuario existe pero es de otra saga, `409` y no se borra.

Idempotencia: `saga_id` único. Un segundo alta con la misma saga devuelve el usuario ya creado (`200`).

## API bonos (Express + Mongo)

Base `altas`, colección `bonos`. El importe se guarda en céntimos.

| Campo | Tipo |
| --- | --- |
| `_id` | ObjectId |
| `sagaId` | string, índice único |
| `usuarioId` | string |
| `tipo` | `"bienvenida"` |
| `importeCents` | int (`1000` = 10,00 €) |
| `creadoEn` | Date |

`POST /bonos`

```json
{
  "sagaId": "7c9e6679-7425-40de-944b-e07fc1f90ae7",
  "usuarioId": "3f1c2a44-1b0e-4c3a-9a11-0e5b6c7d8e9f",
  "tipo": "bienvenida",
  "importeCents": 1000
}
```

Respuesta `201`:

```json
{
  "id": "66f1a0c2b3d4e5f678901234",
  "sagaId": "7c9e6679-7425-40de-944b-e07fc1f90ae7",
  "usuarioId": "3f1c2a44-1b0e-4c3a-9a11-0e5b6c7d8e9f",
  "tipo": "bienvenida",
  "importeCents": 1000
}
```

Idempotencia: índice único en `sagaId`. Un segundo alta con la misma saga devuelve el bono ya creado (`200`).

Fallo de negocio que dispara compensación: campaña cerrada o Mongo no disponible. El cuerpo de error es `{ "error": "..." }` con el status HTTP que corresponda.

## Orquestador

`POST /altas`

```json
{ "nombre": "Ana Ruiz", "email": "ana@example.com" }
```

Respuesta `202`:

```json
{ "sagaId": "7c9e6679-7425-40de-944b-e07fc1f90ae7", "estado": "pendiente" }
```

`GET /altas/:sagaId` cuando termina bien:

```json
{
  "sagaId": "7c9e6679-7425-40de-944b-e07fc1f90ae7",
  "estado": "completada",
  "usuario": {
    "id": "3f1c2a44-1b0e-4c3a-9a11-0e5b6c7d8e9f",
    "nombre": "Ana Ruiz",
    "email": "ana@example.com",
    "estado": "activo"
  },
  "bono": {
    "id": "66f1a0c2b3d4e5f678901234",
    "tipo": "bienvenida",
    "importeCents": 1000
  }
}
```

Mientras la saga no es final (`pendiente`, `usuario_creado`, `compensando`), el `GET` devuelve `sagaId`, `estado` y `usuario` si ya existe (sin `bono`). El front sigue consultando.

```json
{
  "sagaId": "7c9e6679-7425-40de-944b-e07fc1f90ae7",
  "estado": "usuario_creado",
  "usuario": { "id": "3f1c2a44-1b0e-4c3a-9a11-0e5b6c7d8e9f", "estado": "activo" }
}
```

Cuando termina en `fallida`:

```json
{
  "sagaId": "7c9e6679-7425-40de-944b-e07fc1f90ae7",
  "estado": "fallida",
  "error": "El email ya está registrado"
}
```

Cuando se compensa:

```json
{
  "sagaId": "7c9e6679-7425-40de-944b-e07fc1f90ae7",
  "estado": "compensada",
  "error": "No se pudo crear el bono",
  "usuario": {
    "id": "3f1c2a44-1b0e-4c3a-9a11-0e5b6c7d8e9f",
    "estado": "compensado",
    "motivo": "bono_no_creado"
  }
}
```

Documento de saga en Redis (clave `saga:{sagaId}`):

```json
{
  "sagaId": "...",
  "estado": "usuario_creado",
  "nombre": "Ana Ruiz",
  "email": "ana@example.com",
  "usuario": { "id": "3f1c2a44-1b0e-4c3a-9a11-0e5b6c7d8e9f", "estado": "activo" },
  "bono": null,
  "error": null
}
```

`usuario` es `null` solo en `pendiente` y `fallida`; desde `usuario_creado` siempre está relleno.

## Front (Vite)

Pantalla única, fondo claro y texto oscuro.

1. Formulario: nombre y email. Botón "Dar de alta".
2. Tras el `202`, el front abre un WebSocket `ws://localhost:4000/altas/:sagaId/ws` y el orquestador le empuja cada cambio de estado, sin polling. Al conectar recibe el estado actual; al llegar a un estado final el servidor envía el resultado y cierra (código 1000; `4404` si la saga no existe). Cada mensaje tiene el mismo JSON que `GET /altas/:sagaId`. Si la conexión se corta, el front reconecta y recibe de nuevo el estado actual.
3. `completada`: muestra el usuario y el bono formateado como `10,00 €`.
4. `compensada`: muestra que el alta se revirtió porque el bono no se creó.
5. `fallida`: muestra el error de alta, sin usuario activo.

El front formatea céntimos solo al pintar. Las APIs nunca reciben ni devuelven importes en euros.

## Variables de entorno

Credenciales de Postgres y Redis tomadas de `/Users/joseviejo/2026/infra-local/.env`. MongoDB local, sin auth.

```
POSTGRES_URL=postgres://admin:PASSWORD@localhost:5432/altas
MONGODB_URI=mongodb://localhost:27017
MONGODB_DB=altas
REDIS_URL=redis://:PASSWORD@localhost:6379
USUARIOS_API_URL=http://localhost:8000
BONOS_API_URL=http://localhost:3001
ORQUESTADOR_URL=http://localhost:4000
```

| Servicio | Usuario | Password | Base |
| --- | --- | --- | --- |
| Postgres (`academy-postgres`) | `admin` | `PASSWORD` | `altas` |
| Redis (`academy-redis`) | — | `PASSWORD` | db `0` |
| MongoDB (host) | — | — | `altas` |
