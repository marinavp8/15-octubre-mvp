import { useEffect, useState, type FormEvent } from 'react'
import { esFinal, solicitarAlta, suscribirAlta, type Saga } from './api'
import { formatearCents } from './format'

const PROGRESO: Record<string, string> = {
  pendiente: 'Creando tu usuario…',
  usuario_creado: 'Usuario creado, asignando tu bono…',
  compensando: 'No se pudo crear el bono, revirtiendo el alta…',
}

type Fase =
  | { tipo: 'formulario'; error?: string }
  | { tipo: 'enviando' }
  | { tipo: 'esperando'; sagaId: string; estado: string }
  | { tipo: 'resultado'; saga: Saga }

export function App() {
  const [fase, setFase] = useState<Fase>({ tipo: 'formulario' })
  const [nombre, setNombre] = useState('')
  const [email, setEmail] = useState('')

  // El orquestador empuja cada cambio de estado por WebSocket hasta el estado final
  const sagaId = fase.tipo === 'esperando' ? fase.sagaId : null
  useEffect(() => {
    if (!sagaId) return
    return suscribirAlta(sagaId, {
      onSaga: (saga) =>
        setFase(esFinal(saga) ? { tipo: 'resultado', saga } : { tipo: 'esperando', sagaId, estado: saga.estado }),
      onFallo: (mensaje) => setFase({ tipo: 'formulario', error: mensaje }),
    })
  }, [sagaId])

  const enviar = async (e: FormEvent) => {
    e.preventDefault()
    setFase({ tipo: 'enviando' })
    try {
      const { sagaId } = await solicitarAlta(nombre.trim(), email.trim())
      setFase({ tipo: 'esperando', sagaId, estado: 'pendiente' })
    } catch (err) {
      setFase({ tipo: 'formulario', error: (err as Error).message })
    }
  }

  const nueva = () => {
    setNombre('')
    setEmail('')
    setFase({ tipo: 'formulario' })
  }

  const ocupado = fase.tipo === 'enviando' || fase.tipo === 'esperando'

  return (
    <main>
      <h1>Alta de usuario</h1>
      <p className="sub">Te registramos y te damos un bono de bienvenida.</p>

      {(fase.tipo === 'formulario' || ocupado) && (
        <form onSubmit={enviar}>
          <label>
            Nombre
            <input value={nombre} onChange={(e) => setNombre(e.target.value)} required disabled={ocupado} autoComplete="name" />
          </label>
          <label>
            Email
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required disabled={ocupado} autoComplete="email" />
          </label>
          <button type="submit" disabled={ocupado}>
            {ocupado ? 'Procesando…' : 'Dar de alta'}
          </button>
          {fase.tipo === 'formulario' && fase.error && <p className="aviso error" role="alert">{fase.error}</p>}
          {fase.tipo === 'enviando' && <p className="aviso" role="status">Enviando tu alta…</p>}
          {fase.tipo === 'esperando' && <p className="aviso" role="status">{PROGRESO[fase.estado] ?? 'Procesando tu alta…'}</p>}
        </form>
      )}

      {fase.tipo === 'resultado' && <Resultado saga={fase.saga} onNueva={nueva} />}
    </main>
  )
}

function Resultado({ saga, onNueva }: { saga: Saga; onNueva: () => void }) {
  return (
    <section className={`tarjeta ${saga.estado}`} role="status">
      {saga.estado === 'completada' && (
        <>
          <h2>¡Alta completada!</h2>
          <dl>
            <dt>Usuario</dt>
            <dd>{saga.usuario.nombre} · {saga.usuario.email}</dd>
            <dt>Estado</dt>
            <dd>{saga.usuario.estado}</dd>
            <dt>Bono de {saga.bono.tipo}</dt>
            <dd>{formatearCents(saga.bono.importeCents)}</dd>
          </dl>
        </>
      )}
      {saga.estado === 'compensada' && (
        <>
          <h2>El alta se ha revertido</h2>
          <p>{saga.error}. Por eso hemos revertido el alta: tu usuario ha quedado como <strong>{saga.usuario.estado}</strong>.</p>
        </>
      )}
      {saga.estado === 'fallida' && (
        <>
          <h2>No se pudo dar de alta</h2>
          <p>{saga.error}. No se ha creado ningún usuario activo.</p>
        </>
      )}
      <button type="button" onClick={onNueva}>Nueva alta</button>
    </section>
  )
}
