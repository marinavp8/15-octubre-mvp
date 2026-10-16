import { MongoClient } from 'mongodb'
import { crearApp } from './app.js'

const client = new MongoClient(process.env.MONGODB_URI)
await client.connect()
const bonos = client.db(process.env.MONGODB_DB).collection('bonos')
await bonos.createIndex({ sagaId: 1 }, { unique: true })

const port = Number(process.env.PORT ?? new URL(process.env.BONOS_API_URL).port ?? 3001)
crearApp({ bonos }).listen(port, () => console.log(`API bonos en :${port}`))
