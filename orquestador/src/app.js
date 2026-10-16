import { randomUUID } from 'node:crypto'
import cors from 'cors'
import express from 'express'
import { ESTADOS_FINALES } from './sagas.js'

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

// Forma pública de la saga según su estado (ver CASODEUSOMICIRO.md)
export function presentar(saga) {
  const { sagaId, estado, usuario, bono, error, motivo } = saga
  switch (estado) {
    case 'completada':
      return { sagaId, estado, usuario, bono }
    case 'compensada':
      return { sagaId, estado, error, usuario: { id: usuario.id, estado: 'compensado', motivo } }
    case 'fallida':
      return { sagaId, estado, error }
    default: // pendiente, usuario_creado, compensando
      return { sagaId, estado, ...(usuario && { usuario: { id: usuario.id, estado: usuario.estado } }) }
  }
}

export function crearApp({ sagas, iniciarAlta, origenFront = 'http://localhost:5173' }) {
  const app = express()
  app.use(cors({ origin: origenFront }))
  app.use(express.json())

  app.get('/health', (_req, res) => res.json({ ok: true }))

  app.post('/altas', async (req, res, next) => {
    try {
      const { nombre, email } = req.body ?? {}
      if (typeof nombre !== 'string' || !nombre.trim()) return res.status(400).json({ error: 'nombre obligatorio' })
      if (typeof email !== 'string' || !EMAIL.test(email)) return res.status(400).json({ error: 'email no válido' })

      const sagaId = randomUUID()
      await sagas.crear({ sagaId, nombre: nombre.trim(), email: email.trim() })
      await iniciarAlta(sagaId)
      res.status(202).json({ sagaId, estado: 'pendiente' })
    } catch (err) {
      next(err)
    }
  })

  app.get('/altas/:sagaId', async (req, res, next) => {
    try {
      const saga = await sagas.obtener(req.params.sagaId)
      if (!saga) return res.status(404).json({ error: 'Saga no encontrada' })
      res.json(presentar(saga))
    } catch (err) {
      next(err)
    }
  })

  app.use((err, _req, res, _next) => {
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'JSON no válido' })
    console.error(err)
    res.status(500).json({ error: 'Error interno' })
  })

  return app
}

export { ESTADOS_FINALES }
