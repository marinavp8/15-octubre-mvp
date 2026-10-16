import express from 'express'

const TIPOS = ['bienvenida']

const serializar = (doc) => ({
  id: doc._id.toString(),
  sagaId: doc.sagaId,
  usuarioId: doc.usuarioId,
  tipo: doc.tipo,
  importeCents: doc.importeCents,
})

const esErrorDeConexion = (err) =>
  ['MongoServerSelectionError', 'MongoNetworkError', 'MongoNotConnectedError'].includes(err?.name)

const validar = (b = {}) => {
  if (typeof b.sagaId !== 'string' || !b.sagaId) return 'sagaId obligatorio'
  if (typeof b.usuarioId !== 'string' || !b.usuarioId) return 'usuarioId obligatorio'
  if (!TIPOS.includes(b.tipo)) return `tipo debe ser uno de: ${TIPOS.join(', ')}`
  if (!Number.isInteger(b.importeCents) || b.importeCents <= 0) return 'importeCents debe ser un entero positivo (céntimos)'
  return null
}

// campaniaCerrada es una función para poder cambiarla en caliente (pruebas de compensación)
export function crearApp({ bonos, campaniaCerrada = () => process.env.CAMPANIA_CERRADA === 'true' }) {
  const app = express()
  app.use(express.json())

  app.get('/health', (_req, res) => res.json({ ok: true }))

  app.post('/bonos', async (req, res) => {
    const error = validar(req.body)
    if (error) return res.status(400).json({ error })

    const { sagaId, usuarioId, tipo, importeCents } = req.body
    try {
      // idempotencia: si la saga ya tiene bono se devuelve tal cual, aunque la campaña se cierre después
      const existente = await bonos.findOne({ sagaId })
      if (existente) return res.status(200).json(serializar(existente))

      if (campaniaCerrada()) return res.status(409).json({ error: 'Campaña cerrada' })

      const doc = { sagaId, usuarioId, tipo, importeCents, creadoEn: new Date() }
      try {
        const { insertedId } = await bonos.insertOne(doc)
        return res.status(201).json(serializar({ ...doc, _id: insertedId }))
      } catch (err) {
        if (err.code !== 11000) throw err
        // carrera con otra petición de la misma saga
        return res.status(200).json(serializar(await bonos.findOne({ sagaId })))
      }
    } catch (err) {
      if (esErrorDeConexion(err)) return res.status(503).json({ error: 'Mongo no disponible' })
      console.error(err)
      return res.status(500).json({ error: 'Error interno' })
    }
  })

  app.use((err, _req, res, _next) => {
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'JSON no válido' })
    console.error(err)
    res.status(500).json({ error: 'Error interno' })
  })

  return app
}
