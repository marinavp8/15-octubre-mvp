import os
from pathlib import Path

from psycopg.rows import dict_row
from psycopg_pool import ConnectionPool

SCHEMA = """
CREATE TABLE IF NOT EXISTS usuarios (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  saga_id uuid NOT NULL UNIQUE,
  nombre text NOT NULL,
  email text NOT NULL UNIQUE,
  estado text NOT NULL DEFAULT 'activo' CHECK (estado = 'activo'),
  creado_en timestamptz NOT NULL DEFAULT now()
)
"""


def _load_env() -> None:
    env = Path(__file__).resolve().parents[2] / ".env"
    if not env.exists():
        return
    for line in env.read_text().splitlines():
        if "=" in line and not line.lstrip().startswith("#"):
            k, v = line.split("=", 1)
            os.environ.setdefault(k.strip(), v.strip())


_load_env()
pool = ConnectionPool(
    os.environ["POSTGRES_URL"],
    min_size=1,
    max_size=10,
    open=False,
    kwargs={"row_factory": dict_row},
)


# La compensación borra el registro: ya no hay estado `compensado` ni motivo guardado.
MIGRACION = [
    "DELETE FROM usuarios WHERE estado = 'compensado'",  # restos del modelo anterior: liberan el email
    "ALTER TABLE usuarios DROP COLUMN IF EXISTS motivo_compensacion",
    "ALTER TABLE usuarios DROP CONSTRAINT IF EXISTS usuarios_estado_check",
    "ALTER TABLE usuarios ADD CONSTRAINT usuarios_estado_check CHECK (estado = 'activo')",
]


def init_schema() -> None:
    with pool.connection() as conn:
        conn.execute(SCHEMA)
        for sentencia in MIGRACION:
            conn.execute(sentencia)
