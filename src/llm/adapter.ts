/**
 * Interfaz propia con el proveedor del modelo (sección 6.1 del PRD).
 * El ciclo del agente solo conoce estos tipos: cambiar de proveedor es escribir otra
 * implementación de `AdaptadorLLM`, sin tocar el ciclo.
 */

export type LlamadaHerramienta = {
  id: string
  nombre: string
  /** Argumentos tal como los escribió el modelo (texto JSON sin validar). */
  argumentos: string
}

export type Mensaje =
  | { rol: "system"; contenido: string }
  | { rol: "user"; contenido: string }
  | {
      rol: "assistant"
      contenido: string
      llamadas: LlamadaHerramienta[]
      /** Datos que el proveedor exige devolver tal cual en la siguiente vuelta (por ejemplo, el razonamiento). */
      datosProveedor?: unknown
    }
  | { rol: "tool"; idLlamada: string; contenido: string }

export type EsquemaHerramienta = {
  nombre: string
  descripcion: string
  /** JSON Schema de los argumentos. */
  parametros: Record<string, unknown>
}

export type RespuestaModelo = {
  texto: string
  llamadas: LlamadaHerramienta[]
  /** Tokens de entrada (de ellos, cuántos salieron de la caché), de salida y costo en dólares si el proveedor lo informa. */
  uso: { entrada: number; entradaEnCache: number; salida: number; costo: number | null }
  datosProveedor?: unknown
}

export type OpcionesEnvio = {
  /** Obliga al modelo a responder con texto, sin pedir herramientas (por ejemplo, al llegar al tope de iteraciones). */
  sinHerramientas?: boolean
}

export interface AdaptadorLLM {
  readonly proveedor: string
  readonly modelo: string
  enviar(mensajes: Mensaje[], herramientas: EsquemaHerramienta[], opciones?: OpcionesEnvio): Promise<RespuestaModelo>
}

export type CausaErrorLLM = "configuracion" | "timeout" | "red" | "proveedor" | "respuesta"

/** Error del proveedor con un mensaje apto para mostrar en el chat. */
export class ErrorLLM extends Error {
  constructor(
    mensaje: string,
    readonly causa: CausaErrorLLM,
  ) {
    super(mensaje)
    this.name = "ErrorLLM"
  }
}
