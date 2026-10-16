import { crearOrquestador } from './orquestador.js'

const orq = crearOrquestador({
  redisUrl: process.env.REDIS_URL,
  usuariosUrl: process.env.USUARIOS_API_URL,
  bonosUrl: process.env.BONOS_API_URL,
})

const port = Number(new URL(process.env.ORQUESTADOR_URL).port || 4000)
await orq.listen(port)
console.log(`Orquestador en :${port} (HTTP + WebSocket)`)

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    await orq.close()
    process.exit(0)
  })
}
