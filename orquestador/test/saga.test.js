import { randomUUID } from 'node:crypto'
import express from 'express'
import request from 'supertest'
import WebSocket from 'ws'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { crearOrquestador } from '../src/orquestador.js'

// ---- APIs simuladas: cada endpoint consume una secuencia de status y luego usa el valor por defecto
const stub = {}
function reiniciarStub() {
  stub.llamadas = { usuarios: 0, bonos: 0, compensar: 0 }
  stub.status = { usuarios: [], bonos: [], compensar: [] }
}
const siguiente = (clave, def) => (stub.status[clave].length ? stub.status[clave].shift() : def)

function levantarStub() {
  const app = express()
  app.use(express.json())
  app.post('/usuarios', (req, res) => {
    stub.llamadas.usuarios++
    const s = siguiente('usuarios', 201)
    if (s >= 400) return res.status(s).json({ error: s === 409 ? 'El email ya está registrado' : 'fallo' })
    res.status(s).json({ id: 'u-1', sagaId: req.body.sagaId, nombre: req.body.nombre, email: req.body.email, estado: 'activo' })
  })
  app.post('/usuarios/:id/compensar', (req, res) => {
    stub.llamadas.compensar++
    const s = siguiente('compensar', 200)
    if (s >= 400) return res.status(s).json({ error: 'fallo' })
    res.json({ id: req.params.id, estado: 'compensado', motivo: req.body.motivo })
  })
  app.post('/bonos', (req, res) => {
    stub.llamadas.bonos++
    const s = siguiente('bonos', 201)
    if (s >= 400) return res.status(s).json({ error: 'fallo' })
    res.status(s).json({ id: 'b-1', ...req.body })
  })
  return new Promise((ok) => {
    const server = app.listen(0, () => ok({ server, url: `http://localhost:${server.address().port}` }))
  })
}

let orq, api, puerto
const prefix = `test-${randomUUID().slice(0, 8)}`

beforeAll(async () => {
  api = await levantarStub()
  orq = crearOrquestador({
    redisUrl: process.env.REDIS_URL,
    usuariosUrl: api.url,
    bonosUrl: api.url,
    prefix,
    backoffMs: 20,
    timeoutMs: 1000,
    log: {},
  })
  puerto = (await orq.listen(0)).address().port
})

afterAll(async () => {
  const claves = await orq.redis.keys(`${prefix}*`)
  if (claves.length) await orq.redis.del(claves)
  await orq.close()
  api.server.close()
})

beforeEach(reiniciarStub)

const FINALES = ['completada', 'compensada', 'fallida']
async function alta(datos = { nombre: 'Ana Ruiz', email: 'ana@example.com' }) {
  const r = await request(orq.app).post('/altas').send(datos)
  expect(r.status).toBe(202)
  expect(r.body.estado).toBe('pendiente')
  const limite = Date.now() + 5000
  while (Date.now() < limite) {
    const g = await request(orq.app).get(`/altas/${r.body.sagaId}`)
    if (FINALES.includes(g.body.estado)) return g.body
    await new Promise((ok) => setTimeout(ok, 30))
  }
  throw new Error('La saga no terminó a tiempo')
}

describe('flujo feliz', () => {
  it('completa la saga con usuario y bono', async () => {
    const r = await alta()
    expect(r.estado).toBe('completada')
    expect(r.usuario).toMatchObject({ id: 'u-1', nombre: 'Ana Ruiz', email: 'ana@example.com', estado: 'activo' })
    expect(r.bono).toEqual({ id: 'b-1', tipo: 'bienvenida', importeCents: 1000 })
    expect(stub.llamadas).toEqual({ usuarios: 1, bonos: 1, compensar: 0 })
  })
})

describe('compensación', () => {
  it('bono falla siempre: 3 intentos y compensa', async () => {
    stub.status.bonos = [503, 503, 503]
    const r = await alta()
    expect(r).toMatchObject({
      estado: 'compensada',
      error: 'No se pudo crear el bono',
      usuario: { id: 'u-1', estado: 'compensado', motivo: 'bono_no_creado' },
    })
    expect(r.bono).toBeUndefined()
    expect(stub.llamadas).toEqual({ usuarios: 1, bonos: 3, compensar: 1 })
  })

  it('campaña cerrada (409) también agota reintentos y compensa', async () => {
    stub.status.bonos = [409, 409, 409]
    const r = await alta()
    expect(r.estado).toBe('compensada')
    expect(stub.llamadas.bonos).toBe(3)
  })

  it('bono con 400 compensa sin reintentar', async () => {
    stub.status.bonos = [400]
    const r = await alta()
    expect(r.estado).toBe('compensada')
    expect(stub.llamadas.bonos).toBe(1)
  })

  it('un fallo transitorio del bono se recupera sin compensar', async () => {
    stub.status.bonos = [503, 503]
    const r = await alta()
    expect(r.estado).toBe('completada')
    expect(stub.llamadas).toEqual({ usuarios: 1, bonos: 3, compensar: 0 })
  })

  it('la compensación reintenta hasta lograrlo', async () => {
    stub.status.bonos = [400]
    stub.status.compensar = [503, 503, 503]
    const r = await alta()
    expect(r.estado).toBe('compensada')
    expect(stub.llamadas.compensar).toBe(4)
  })
})

describe('alta de usuario fallida', () => {
  it('email duplicado (409): fallida, sin reintentos ni compensación', async () => {
    stub.status.usuarios = [409]
    const r = await alta()
    expect(r).toEqual({ sagaId: expect.any(String), estado: 'fallida', error: 'El email ya está registrado' })
    expect(stub.llamadas).toEqual({ usuarios: 1, bonos: 0, compensar: 0 })
  })

  it('usuarios caído: 3 intentos y fallida', async () => {
    stub.status.usuarios = [503, 503, 503]
    const r = await alta()
    expect(r).toMatchObject({ estado: 'fallida', error: 'No se pudo crear el usuario' })
    expect(stub.llamadas).toEqual({ usuarios: 3, bonos: 0, compensar: 0 })
  })

  it('fallo transitorio de usuarios se recupera', async () => {
    stub.status.usuarios = [503]
    expect((await alta()).estado).toBe('completada')
  })
})

describe('API', () => {
  it('valida el alta (400)', async () => {
    for (const mal of [{}, { nombre: '', email: 'a@b.co' }, { nombre: 'Ana', email: 'no' }]) {
      const r = await request(orq.app).post('/altas').send(mal)
      expect(r.status).toBe(400)
      expect(r.body.error).toBeTypeOf('string')
    }
  })

  it('saga inexistente: 404', async () => {
    expect((await request(orq.app).get(`/altas/${randomUUID()}`)).status).toBe(404)
  })

  it('permite el origen del front por CORS', async () => {
    const r = await request(orq.app).get('/health').set('Origin', 'http://localhost:5173')
    expect(r.headers['access-control-allow-origin']).toBe('http://localhost:5173')
  })

  it('estados intermedios no exponen bono', async () => {
    const { sagaId } = await orq.sagas.crear({ sagaId: randomUUID(), nombre: 'x', email: 'x@y.co' })
    await orq.sagas.transicionar(sagaId, 'usuario_creado', { usuario: { id: 'u-9', nombre: 'x', email: 'x@y.co', estado: 'activo' } })
    const r = await request(orq.app).get(`/altas/${sagaId}`)
    expect(r.body).toEqual({ sagaId, estado: 'usuario_creado', usuario: { id: 'u-9', estado: 'activo' } })
  })
})

// ---- WebSocket: el orquestador empuja los cambios de estado
const abrirWs = (sagaId, opciones) => {
  const ws = new WebSocket(`ws://localhost:${puerto}/altas/${sagaId}/ws`, opciones)
  const mensajes = []
  const cierre = new Promise((ok, fallo) => {
    ws.on('message', (m) => mensajes.push(JSON.parse(m.toString())))
    ws.on('close', (codigo) => ok(codigo))
    ws.on('error', fallo)
  })
  return { ws, mensajes, cierre }
}

describe('WebSocket /altas/:sagaId/ws', () => {
  it('empuja los estados hasta el final y cierra', async () => {
    const r = await request(orq.app).post('/altas').send({ nombre: 'Ana Ruiz', email: 'ana@example.com' })
    const { mensajes, cierre } = abrirWs(r.body.sagaId)
    expect(await cierre).toBe(1000)
    const estados = mensajes.map((m) => m.estado)
    expect(estados.at(-1)).toBe('completada')
    expect(new Set(estados).size).toBe(estados.length) // sin estados repetidos
    expect(mensajes.at(-1).bono).toEqual({ id: 'b-1', tipo: 'bienvenida', importeCents: 1000 })
  })

  it('con compensación termina en compensada', async () => {
    stub.status.bonos = [400]
    const r = await request(orq.app).post('/altas').send({ nombre: 'Luis', email: 'luis@example.com' })
    const { mensajes, cierre } = abrirWs(r.body.sagaId)
    expect(await cierre).toBe(1000)
    expect(mensajes.at(-1)).toMatchObject({ estado: 'compensada', usuario: { estado: 'compensado', motivo: 'bono_no_creado' } })
  })

  it('al conectar tras el final recibe el resultado enseguida', async () => {
    const final = await alta()
    const { mensajes, cierre } = abrirWs(final.sagaId)
    expect(await cierre).toBe(1000)
    expect(mensajes).toEqual([final])
  })

  it('saga inexistente: cierra con 4404', async () => {
    const { mensajes, cierre } = abrirWs(randomUUID())
    expect(await cierre).toBe(4404)
    expect(mensajes).toEqual([])
  })

  it('rechaza un Origin que no es el front (403)', async () => {
    const { cierre } = abrirWs(randomUUID(), { headers: { Origin: 'http://malo.example' } })
    await expect(cierre).rejects.toThrow(/403/)
  })

  it('acepta el Origin del front', async () => {
    const final = await alta()
    const { cierre } = abrirWs(final.sagaId, { headers: { Origin: 'http://localhost:5173' } })
    expect(await cierre).toBe(1000)
  })

  it('rutas WebSocket desconocidas se descartan', async () => {
    const ws = new WebSocket(`ws://localhost:${puerto}/otra`)
    await expect(new Promise((ok, fallo) => { ws.on('open', ok); ws.on('error', fallo) })).rejects.toThrow()
  })
})
