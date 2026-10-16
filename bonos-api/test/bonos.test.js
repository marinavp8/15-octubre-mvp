import { randomUUID } from 'node:crypto'
import { MongoClient } from 'mongodb'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { crearApp } from '../src/app.js'

let client, bonos, cerrada = false, app

beforeAll(async () => {
  client = new MongoClient(process.env.MONGODB_URI)
  await client.connect()
  bonos = client.db('altas_test').collection('bonos')
  await bonos.createIndex({ sagaId: 1 }, { unique: true })
  app = crearApp({ bonos, campaniaCerrada: () => cerrada })
})

afterAll(async () => {
  await client.db('altas_test').dropDatabase()
  await client.close()
})

const alta = (extra = {}) => ({
  sagaId: randomUUID(), usuarioId: randomUUID(), tipo: 'bienvenida', importeCents: 1000, ...extra,
})

describe('POST /bonos', () => {
  it('crea el bono (201)', async () => {
    const body = alta()
    const r = await request(app).post('/bonos').send(body)
    expect(r.status).toBe(201)
    expect(r.body).toMatchObject(body)
    expect(r.body.id).toMatch(/^[0-9a-f]{24}$/)
  })

  it('misma saga devuelve el bono ya creado (200)', async () => {
    const body = alta()
    const a = await request(app).post('/bonos').send(body)
    const b = await request(app).post('/bonos').send(body)
    expect(b.status).toBe(200)
    expect(b.body.id).toBe(a.body.id)
  })

  it('peticiones concurrentes de la misma saga crean un solo bono', async () => {
    const body = alta()
    const rs = await Promise.all(Array.from({ length: 5 }, () => request(app).post('/bonos').send(body)))
    expect(rs.every((r) => [200, 201].includes(r.status))).toBe(true)
    expect(rs.filter((r) => r.status === 201)).toHaveLength(1)
    expect(await bonos.countDocuments({ sagaId: body.sagaId })).toBe(1)
  })

  it('rechaza datos no válidos (400)', async () => {
    for (const mal of [{ importeCents: 10.5 }, { importeCents: -1 }, { tipo: 'otro' }, { sagaId: '' }]) {
      const r = await request(app).post('/bonos').send(alta(mal))
      expect(r.status).toBe(400)
      expect(r.body.error).toBeTypeOf('string')
    }
  })

  it('campaña cerrada devuelve 409 con { error }', async () => {
    cerrada = true
    const r = await request(app).post('/bonos').send(alta())
    cerrada = false
    expect(r.status).toBe(409)
    expect(r.body).toEqual({ error: 'Campaña cerrada' })
  })

  it('Mongo no disponible devuelve 503', async () => {
    const roto = new MongoClient('mongodb://localhost:1', { serverSelectionTimeoutMS: 200 })
    const r = await request(crearApp({ bonos: roto.db('x').collection('bonos') })).post('/bonos').send(alta())
    expect(r.status).toBe(503)
    expect(r.body.error).toBeTypeOf('string')
    await roto.close()
  })
})
