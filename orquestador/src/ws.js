import { WebSocketServer } from 'ws'
import { presentar } from './app.js'
import { ESTADOS_FINALES } from './sagas.js'

const RUTA = /^\/altas\/([^/]+)\/ws$/
const LATIDO_MS = 30_000

// WebSocket /altas/:sagaId/ws: envía el estado actual al conectar y cada cambio después.
// Al llegar a un estado final envía el resultado y cierra. Mensajes = mismo JSON que GET /altas/:sagaId.
export function adjuntarWebSocket({ server, sagas, subscriber, canal, origenFront }) {
  const wss = new WebSocketServer({ noServer: true })
  const oyentes = new Map() // sagaId -> Set<WebSocket>

  const enviarEstado = async (ws, sagaId) => {
    const saga = await sagas.obtener(sagaId)
    if (!saga || ws.readyState !== ws.OPEN || ws.ultimoEstado === saga.estado) return
    ws.ultimoEstado = saga.estado
    ws.send(JSON.stringify(presentar(saga)))
    if (ESTADOS_FINALES.includes(saga.estado)) ws.close(1000, 'saga terminada')
  }

  subscriber.subscribe(canal)
  subscriber.on('message', (_canal, sagaId) => {
    for (const ws of oyentes.get(sagaId) ?? []) enviarEstado(ws, sagaId).catch(() => ws.terminate())
  })

  wss.on('connection', async (ws, req, sagaId) => {
    // se registra antes de leer: así no se pierde ningún cambio entre la lectura y la suscripción
    if (!oyentes.has(sagaId)) oyentes.set(sagaId, new Set())
    oyentes.get(sagaId).add(ws)
    ws.on('close', () => {
      oyentes.get(sagaId)?.delete(ws)
      if (!oyentes.get(sagaId)?.size) oyentes.delete(sagaId)
    })
    ws.on('pong', () => { ws.viva = true })
    ws.viva = true

    try {
      if (!(await sagas.obtener(sagaId))) return ws.close(4404, 'Saga no encontrada')
      await enviarEstado(ws, sagaId)
    } catch {
      ws.terminate()
    }
  })

  server.on('upgrade', (req, socket, head) => {
    const sagaId = RUTA.exec(new URL(req.url, 'http://x').pathname)?.[1]
    if (!sagaId) return socket.destroy()
    // los navegadores envían Origin; se rechaza si no es el front (clientes sin Origin, como curl, pasan)
    if (origenFront && req.headers.origin && req.headers.origin !== origenFront) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
      return socket.destroy()
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req, sagaId))
  })

  // detecta conexiones muertas
  const latido = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.viva) { ws.terminate(); continue }
      ws.viva = false
      ws.ping()
    }
  }, LATIDO_MS)

  return {
    cerrar() {
      clearInterval(latido)
      for (const ws of wss.clients) ws.terminate()
      wss.close()
    },
  }
}
