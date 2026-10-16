export class HttpError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status // 0 = red / timeout
  }
}

async function post(url, body, timeoutMs) {
  let res
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch {
    throw new HttpError(0, 'Servicio no disponible')
  }
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new HttpError(res.status, data.error ?? `HTTP ${res.status}`)
  return data
}

export function crearClientes({ usuariosUrl, bonosUrl, timeoutMs = 5000 }) {
  return {
    crearUsuario: (body) => post(`${usuariosUrl}/usuarios`, body, timeoutMs),
    compensarUsuario: (id, body) => post(`${usuariosUrl}/usuarios/${id}/compensar`, body, timeoutMs),
    crearBono: (body) => post(`${bonosUrl}/bonos`, body, timeoutMs),
  }
}
