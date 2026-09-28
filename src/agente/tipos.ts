import type { Mensaje } from "../llm/adapter.ts"

/** Cómo se muestra una llamada a herramienta en el chat (nombre, argumentos y resultado resumido). */
export type LlamadaVisible = { herramienta: string; argumentos: unknown; ok: boolean; resumen: string }

/** Respuesta de POST /api/chat (sección 6.4 del PRD). */
export type ResultadoTurno = {
  reply: string
  toolCalls: LlamadaVisible[]
  needsConfirmation: boolean
  error?: boolean
}

export type EntradaHistorial = {
  rol: "usuario" | "agente"
  texto: string
  ts: string
  toolCalls?: LlamadaVisible[]
  needsConfirmation?: boolean
  error?: boolean
}

/** Acción externa que espera la confirmación del usuario; `caso` limita la confirmación a ese caso. */
export type Pendiente = { caso: string | null }

export type Sesion = {
  id: string
  creada: string
  /** Transcripción completa que se le envía al modelo. */
  mensajes: Mensaje[]
  /** Lo que ve la persona en el chat. */
  historial: EntradaHistorial[]
  tokens: number
  costo: number
  pendiente: Pendiente | null
  ocupada: boolean
}
