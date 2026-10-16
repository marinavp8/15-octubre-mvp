import uuid

import pytest
from fastapi.testclient import TestClient

from app.db import pool
from app.main import app


@pytest.fixture(scope="module")
def client():
    with TestClient(app) as c:
        yield c
        with pool.connection() as conn:
            conn.execute("DELETE FROM usuarios WHERE email LIKE %s", ("%@example.com",))


def alta(saga=None, email=None):
    return {
        "sagaId": str(saga or uuid.uuid4()),
        "nombre": "Ana Ruiz",
        "email": email or f"{uuid.uuid4().hex[:8]}@example.com",
    }


def test_alta_crea_usuario_activo(client):
    r = client.post("/usuarios", json=alta())
    assert r.status_code == 201
    assert r.json()["estado"] == "activo"


def test_alta_repetida_misma_saga_devuelve_200(client):
    body = alta()
    primero = client.post("/usuarios", json=body)
    segundo = client.post("/usuarios", json=body)
    assert segundo.status_code == 200
    assert segundo.json()["id"] == primero.json()["id"]


def test_email_duplicado_otra_saga_409(client):
    body = alta()
    client.post("/usuarios", json=body)
    r = client.post("/usuarios", json=alta(email=body["email"]))
    assert r.status_code == 409
    assert "error" in r.json()


def test_validacion_400(client):
    r = client.post("/usuarios", json={"sagaId": "x", "nombre": "", "email": "no"})
    assert r.status_code == 400


def test_compensar_borra_el_registro_y_es_idempotente(client):
    u = client.post("/usuarios", json=alta()).json()
    datos = {"sagaId": u["sagaId"], "motivo": "bono_no_creado"}
    r1 = client.post(f"/usuarios/{u['id']}/compensar", json=datos)
    r2 = client.post(f"/usuarios/{u['id']}/compensar", json=datos)
    assert r1.status_code == r2.status_code == 200
    assert r1.json() == r2.json()
    assert r1.json()["estado"] == "compensado"
    assert r1.json()["motivo"] == "bono_no_creado"
    with pool.connection() as conn:
        assert conn.execute("SELECT count(*) AS n FROM usuarios WHERE id = %s", (u["id"],)).fetchone()["n"] == 0


def test_tras_compensar_se_puede_repetir_el_alta_con_el_mismo_email(client):
    primero = alta()
    u = client.post("/usuarios", json=primero).json()
    client.post(f"/usuarios/{u['id']}/compensar", json={"sagaId": u["sagaId"], "motivo": "bono_no_creado"})
    segundo = client.post("/usuarios", json=alta(email=primero["email"]))
    assert segundo.status_code == 201
    assert segundo.json()["estado"] == "activo"
    assert segundo.json()["id"] != u["id"]


def test_compensar_con_otra_saga_409_y_no_borra(client):
    u = client.post("/usuarios", json=alta()).json()
    r = client.post(f"/usuarios/{u['id']}/compensar", json={"sagaId": str(uuid.uuid4()), "motivo": "x"})
    assert r.status_code == 409
    again = client.post("/usuarios", json={"sagaId": u["sagaId"], "nombre": "x", "email": u["email"]})
    assert again.status_code == 200  # sigue existiendo
