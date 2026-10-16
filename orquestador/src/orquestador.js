import { createServer } from 'node:http'
import { Queue, UnrecoverableError, Worker } from 'bullmq'
import IORedis from 'ioredis'
import { crearApp } from './app.js'
import { crearClientes, HttpError } from './clientes.js'
import { canalEventos, crearSagas } from './sagas.js'
import { adjuntarWebSocket } from './ws.js'

const BONO_BIENVENIDA_CENTS = 1000

// 400/409 no se arreglan reintentando
const noReintentable = (e) => e instanceof HttpError && [400, 409].includes(e.status)
const ultimoIntento = (job) => job.attemptsMade + 1 >= (job.opts.attempts ?? 1)

export function crearOrquestador({
  redisUrl,
  usuariosUrl,
  bonosUrl,
  prefix = 'bull',
  backoffMs = 1000,
  timeoutMs = 5000,
  origenFront = 'http://localhost:5173',
  log = console,
}) {
  const redis = new IORedis(redisUrl, { maxRetriesPerRequest: null })
  const sagas = crearSagas(redis, prefix === 'bull' ? '' : `${prefix}:`)
  const clientes = crearClientes({ usuariosUrl, bonosUrl, timeoutMs })

  const opcionesCola = (attempts) => ({
    prefix,
    connection: redis,
    defaultJobOptions: {
      attempts,
      backoff: { type: 'exponential', delay: backoffMs },
      removeOnComplete: { count: 1000 },
      removeOnFail: { count: 1000 },
    },
  })
  const colas = {
    usuariosCrear: new Queue('usuarios.crear', opcionesCola(3)),
    bonosCrear: new Queue('bonos.crear', opcionesCola(3)),
    usuariosCompensar: new Queue('usuarios.compensar', opcionesCola(5)),
  }

  // jobId = sagaId: reencolar la misma saga no duplica el trabajo
  const encolar = (cola, sagaId) => cola.add(cola.name, { sagaId }, { jobId: sagaId })

  const iniciarCompensacion = async (sagaId) => {
    await sagas.transicionar(sagaId, 'compensando', { error: 'No se pudo crear el bono', motivo: 'bono_no_creado' })
    await encolar(colas.usuariosCompensar, sagaId)
  }

  // Cada procesador es idempotente por fase: si el worker cae y el job se reintenta,
  // retoma desde el estado guardado en Redis.
  const procesadores = {
    async 'usuarios.crear'(job) {
      const { sagaId } = job.data
      let saga = await sagas.obtener(sagaId)
      if (!saga) throw new UnrecoverableError(`Saga ${sagaId} no existe`)

      if (saga.estado === 'pendiente') {
        let usuario
        try {
          usuario = await clientes.crearUsuario({ sagaId, nombre: saga.nombre, email: saga.email })
        } catch (e) {
          if (noReintentable(e) || ultimoIntento(job)) {
            await sagas.transicionar(sagaId, 'fallida', {
              error: noReintentable(e) ? e.message : 'No se pudo crear el usuario',
            })
            throw new UnrecoverableError(e.message)
          }
          throw e
        }
        saga = await sagas.transicionar(sagaId, 'usuario_creado', {
          usuario: { id: usuario.id, nombre: usuario.nombre, email: usuario.email, estado: usuario.estado },
        })
      }
      if (saga.estado === 'usuario_creado') await encolar(colas.bonosCrear, sagaId)
    },

    async 'bonos.crear'(job) {
      const { sagaId } = job.data
      const saga = await sagas.obtener(sagaId)
      if (!saga) throw new UnrecoverableError(`Saga ${sagaId} no existe`)

      if (saga.estado === 'usuario_creado') {
        let bono
        try {
          bono = await clientes.crearBono({
            sagaId,
            usuarioId: saga.usuario.id,
            tipo: 'bienvenida',
            importeCents: BONO_BIENVENIDA_CENTS,
          })
        } catch (e) {
          if (e instanceof HttpError && e.status === 400) {
            await iniciarCompensacion(sagaId)
            throw new UnrecoverableError(e.message)
          }
          if (ultimoIntento(job)) {
            await iniciarCompensacion(sagaId)
            throw new UnrecoverableError(e.message)
          }
          throw e
        }
        await sagas.transicionar(sagaId, 'completada', {
          bono: { id: bono.id, tipo: bono.tipo, importeCents: bono.importeCents },
        })
      } else if (saga.estado === 'compensando') {
        await encolar(colas.usuariosCompensar, sagaId) // caída entre cambiar de estado y encolar
      }
    },

    async 'usuarios.compensar'(job) {
      const { sagaId } = job.data
      const saga = await sagas.obtener(sagaId)
      if (!saga) throw new UnrecoverableError(`Saga ${sagaId} no existe`)
      if (saga.estado !== 'compensando') return

      await clientes.compensarUsuario(saga.usuario.id, { sagaId, motivo: saga.motivo })
      await sagas.transicionar(sagaId, 'compensada', { usuario: { ...saga.usuario, estado: 'compensado' } })
    },
  }

  const workers = Object.entries(procesadores).map(([nombre, fn]) => {
    const w = new Worker(nombre, fn, { prefix, connection: redis, concurrency: 5 })
    w.on('failed', (job, err) =>
      log.warn?.(`[${nombre}] saga ${job?.data?.sagaId} intento ${job?.attemptsMade}: ${err.message}`),
    )
    w.on('error', (err) => log.error?.(`[${nombre}] ${err.message}`))
    return w
  })

  const app = crearApp({
    sagas,
    origenFront,
    iniciarAlta: (sagaId) => encolar(colas.usuariosCrear, sagaId),
  })

  // subscriber propio: una conexión en modo suscripción no puede ejecutar otros comandos
  const subscriber = redis.duplicate()
  let servidor = null
  let ws = null

  return {
    app,
    sagas,
    redis,
    // Servidor HTTP con WebSocket (/altas/:sagaId/ws). Devuelve el http.Server ya escuchando.
    listen(puerto) {
      servidor = createServer(app)
      ws = adjuntarWebSocket({
        server: servidor,
        sagas,
        subscriber,
        canal: canalEventos(prefix === 'bull' ? '' : `${prefix}:`),
        origenFront,
      })
      return new Promise((ok) => servidor.listen(puerto, () => ok(servidor)))
    },
    async close() {
      ws?.cerrar()
      if (servidor) await new Promise((ok) => servidor.close(ok))
      await Promise.all(workers.map((w) => w.close()))
      await Promise.all(Object.values(colas).map((c) => c.close()))
      await subscriber.quit()
      await redis.quit()
    },
  }
}
