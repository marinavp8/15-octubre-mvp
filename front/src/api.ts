const BASE = import.meta.env.VITE_ORQUESTADOR_URL ?? 'http://localhost:4000'

export type Usuario = { id: string; nombre?: string; email?: string; estado: 'activo' | 'compensado'; motivo?: string }
export type Bono = { id: string; tipo: string; importeCents: number }

export type Saga =
  | { sagaId: string; estado: 'pendiente' | 'usuario_creado' | 'compensando'; usuario?: Usuario }
  | { sagaId: string; estado: 'completada'; usuario: Usuario; bono: Bono }
  | { sagaId: string; estado: 'compensada'; error: string; usuario: Usuario }
  | { sagaId: string; estado: 'fallida'; error: string }

export const esFinal = (s: Saga) => s.estado === 'completada' || s.estado === 'compensada' || s.estado === 'fallida'

async function pedir<T>(ruta: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${ruta}`, init)
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error ?? `Error ${res.status}`)
  return data as T
}

export const solicitarAlta = (nombre: string, email: string) =>
  pedir<{ sagaId: string; estado: string }>('/altas', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ nombre, email }),
  })

const WS_BASE = BASE.replace(/^http/, 'ws')
const MAX_FALLOS_SEGUIDOS = 5
const ESPERA_RECONEXION_MS = 1000

type Oyentes = { onSaga: (saga: Saga) => void; onFallo: (mensaje: string) => void }

// Recibe por WebSocket cada cambio de estado de la saga. Al conectar el servidor envía el estado
// actual, así que reconectar nunca pierde información. Devuelve la función para cancelar.
export function suscribirAlta(sagaId: string, { onSaga, onFallo }: Oyentes): () => void {
  let cancelado = false
  let terminada = false
  let fallos = 0
  let ws: WebSocket | null = null
  let timer: ReturnType<typeof setTimeout> | undefined

  const conectar = () => {
    const socket = new WebSocket(`${WS_BASE}/altas/${sagaId}/ws`)
    ws = socket
    socket.onmessage = (ev) => {
      if (cancelado) return
      fallos = 0
      const saga = JSON.parse(ev.data) as Saga
      if (esFinal(saga)) terminada = true
      onSaga(saga)
    }
    socket.onclose = (ev) => {
      if (cancelado || terminada) return
      if (ev.code === 4404) return onFallo('El alta no existe')
      if (++fallos >= MAX_FALLOS_SEGUIDOS) return onFallo('Se perdió la conexión con el servidor')
      timer = setTimeout(conectar, ESPERA_RECONEXION_MS)
    }
  }
  conectar()

  return () => {
    cancelado = true
    clearTimeout(timer)
    // cerrar un socket que aún conecta lanza un aviso en consola: se cierra en cuanto abra
    if (ws?.readyState === WebSocket.CONNECTING) ws.onopen = () => ws?.close()
    else ws?.close()
  }
}
