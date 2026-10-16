import logging
from contextlib import asynccontextmanager
from uuid import UUID

from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from psycopg.errors import UniqueViolation
from pydantic import BaseModel, EmailStr, Field

from .db import init_schema, pool


@asynccontextmanager
async def lifespan(_: FastAPI):
    pool.open()
    init_schema()
    yield
    pool.close()


log = logging.getLogger("uvicorn.error")
app = FastAPI(title="API usuarios", lifespan=lifespan)


@app.exception_handler(RequestValidationError)
async def validation_error(_: Request, exc: RequestValidationError):
    return JSONResponse(status_code=400, content={"error": "Datos no válidos", "detalle": jsonable(exc)})


def jsonable(exc: RequestValidationError):
    return [{"campo": ".".join(str(p) for p in e["loc"][1:]), "msg": e["msg"]} for e in exc.errors()]


class AltaUsuario(BaseModel):
    sagaId: UUID
    nombre: str = Field(min_length=1)
    email: EmailStr


class Compensacion(BaseModel):
    sagaId: UUID
    motivo: str = Field(min_length=1)


def serializar(row: dict) -> dict:
    return {
        "id": str(row["id"]),
        "sagaId": str(row["saga_id"]),
        "nombre": row["nombre"],
        "email": row["email"],
        "estado": row["estado"],
    }


@app.post("/usuarios", status_code=201)
def crear_usuario(body: AltaUsuario, response: Response):
    email = body.email.lower()
    try:
        with pool.connection() as conn:
            row = conn.execute(
                """INSERT INTO usuarios (saga_id, nombre, email) VALUES (%s, %s, %s)
                   ON CONFLICT (saga_id) DO NOTHING RETURNING *""",
                (body.sagaId, body.nombre, email),
            ).fetchone()
            if row is None:
                # misma saga: idempotente, devolvemos el usuario ya creado
                row = conn.execute("SELECT * FROM usuarios WHERE saga_id = %s", (body.sagaId,)).fetchone()
                response.status_code = 200
    except UniqueViolation:
        raise HTTPException(status_code=409, detail="El email ya está registrado")
    return serializar(row)


@app.post("/usuarios/{usuario_id}/compensar")
def compensar_usuario(usuario_id: UUID, body: Compensacion):
    """Compensar = borrar el registro, para que el email quede libre y se pueda repetir el alta.

    Idempotente: si el usuario ya no existe, el estado final deseado ya se alcanzó y se responde igual.
    """
    with pool.connection() as conn:
        row = conn.execute("SELECT saga_id FROM usuarios WHERE id = %s FOR UPDATE", (usuario_id,)).fetchone()
        if row is not None:
            if row["saga_id"] != body.sagaId:
                raise HTTPException(status_code=409, detail="El usuario no pertenece a esa saga")
            conn.execute("DELETE FROM usuarios WHERE id = %s", (usuario_id,))
            log.info("usuario %s eliminado por compensación de la saga %s (%s)", usuario_id, body.sagaId, body.motivo)
    return {"id": str(usuario_id), "sagaId": str(body.sagaId), "estado": "compensado", "motivo": body.motivo}


@app.get("/health")
def health():
    return {"ok": True}


@app.exception_handler(HTTPException)
async def http_error(_: Request, exc: HTTPException):
    # formato de error uniforme: { "error": "..." }
    return JSONResponse(status_code=exc.status_code, content={"error": exc.detail})
