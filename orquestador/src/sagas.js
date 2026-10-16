// Estado de la saga en Redis (clave `saga:{sagaId}`). Un solo job activo por saga, así que
// leer-modificar-escribir es seguro; las transiciones inválidas se rechazan.
const TRANSICIONES = {
  pendiente: ['usuario_creado', 'fallida'],
  usuario_creado: ['completada', 'compensando'],
  compensando: ['compensada'],
  completada: [],
  compensada: [],
  fallida: [],
}

export const ESTADOS_FINALES = ['completada', 'compensada', 'fallida']

export const canalEventos = (prefix = '') => `${prefix}sagas:eventos`

export function crearSagas(redis, prefix = '') {
  const clave = (id) => `${prefix}saga:${id}`
  // Cada cambio se publica en Redis (solo el sagaId): quien esté suscrito vuelve a leer la saga
  const notificar = (sagaId) => redis.publish(canalEventos(prefix), sagaId)

  const obtener = async (sagaId) => {
    const raw = await redis.get(clave(sagaId))
    return raw ? JSON.parse(raw) : null
  }

  return {
    obtener,

    async crear({ sagaId, nombre, email }) {
      const saga = { sagaId, estado: 'pendiente', nombre, email, usuario: null, bono: null, error: null }
      await redis.set(clave(sagaId), JSON.stringify(saga))
      await notificar(sagaId)
      return saga
    },

    // Idempotente: si la saga ya está en `estado`, no hace nada.
    async transicionar(sagaId, estado, parche = {}) {
      const saga = await obtener(sagaId)
      if (!saga) throw new Error(`Saga ${sagaId} no existe`)
      if (saga.estado === estado) return saga
      if (!TRANSICIONES[saga.estado].includes(estado)) {
        throw new Error(`Transición no válida: ${saga.estado} -> ${estado}`)
      }
      const nueva = { ...saga, ...parche, estado }
      await redis.set(clave(sagaId), JSON.stringify(nueva))
      await notificar(sagaId)
      return nueva
    },
  }
}
