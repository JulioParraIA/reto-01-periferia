/**
 * Rutas HTTP: la API del chat (sección 6.4 del PRD) y las que usa la interfaz para mostrar el
 * expediente de cada caso (casos, archivos generados, vista del Excel y firma). Se arma con sus
 * dependencias para poder probarla sin levantar un servidor.
 */
import { timingSafeEqual } from "node:crypto"
import path from "node:path"
import { z } from "zod"
import { procesarTurno, type DependenciasCiclo } from "../agente/ciclo.ts"
import type { Sesiones } from "../agente/sesiones.ts"
import type { Sesion } from "../agente/tipos.ts"
import { listarArchivos, resolverRutaSegura, vistaExcel } from "../archivos.ts"
import { existeCaso, listarCasos } from "../casos.ts"
import { consultarFirma, firmar, type DatosFirma } from "../firma/firmar.ts"

export type OpcionesApp = {
  raiz: string
  /** Si no está vacía, toda la API (menos /api/health) exige la cabecera x-clave-acceso. */
  claveAcceso: string
  promptSistema: string
  sesiones: Sesiones
  ciclo: DependenciasCiclo
}

type Manejador = (peticion: Request, parametro: string) => Promise<Response> | Response

const CABECERAS = { "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" }
const CSP =
  "default-src 'self'; img-src 'self' data: blob:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-src 'self' blob:; object-src 'none'; base-uri 'none'"
const ID_SESION = /^[A-Za-z0-9_-]{8,64}$/
const ARCHIVO_WEB = /^\/([a-z]+\.(?:js|css))$/

const ChatSchema = z.object({
  sessionId: z.string().regex(ID_SESION),
  message: z.string().trim().min(1).max(4000),
  /** true cuando la persona pulsa «Confirmar envío» en el chat. */
  confirmar: z.boolean().optional(),
})
const FirmaSchema = z.object({
  metodo: z.enum(["dibujada", "clic"]),
  /** PNG en data URL, solo para la firma dibujada. */
  imagen: z.string().max(600_000).optional(),
  sessionId: z.string().regex(ID_SESION).optional(),
})

function json(datos: unknown, estado = 200): Response {
  return Response.json(datos, { status: estado, headers: CABECERAS })
}

function error(mensaje: string, estado: number): Response {
  return json({ error: mensaje }, estado)
}

function eventoDeFirma(firma: DatosFirma): string {
  const metodo = firma.metodo === "dibujada" ? "con firma dibujada" : "con firma electrónica de un clic"
  return `Firmaste el formulario de ${firma.caso} ${metodo} como ${firma.firmante} (${firma.cargo}); archivo ${firma.archivo}, código ${firma.codigo}.`
}

export function crearManejador(opciones: OpcionesApp): (peticion: Request) => Promise<Response> {
  const { raiz, sesiones, ciclo } = opciones

  function autorizado(peticion: Request): boolean {
    if (!opciones.claveAcceso) return true
    const recibida = Buffer.from(peticion.headers.get("x-clave-acceso") ?? "")
    const esperada = Buffer.from(opciones.claveAcceso)
    return recibida.length === esperada.length && timingSafeEqual(recibida, esperada)
  }

  async function chat(peticion: Request): Promise<Response> {
    const cuerpo = ChatSchema.safeParse(await peticion.json().catch(() => null))
    if (!cuerpo.success) return error("Petición inválida: se espera { sessionId, message }.", 400)
    const sesion = sesiones.obtenerOCrear(cuerpo.data.sessionId, opciones.promptSistema)
    if (sesion.ocupada) return error("La sesión todavía está respondiendo el mensaje anterior.", 409)
    sesion.ocupada = true
    try {
      return json(await procesarTurno(sesion, cuerpo.data.message, cuerpo.data.confirmar ?? false, ciclo))
    } finally {
      sesion.ocupada = false
    }
  }

  function historial(_peticion: Request, id: string): Response {
    const sesion = sesiones.obtener(id)
    if (!sesion) return error("No existe esa sesión.", 404)
    const { creada, historial: entradas, tokens, tokensEnCache, costo } = sesion
    return json({ sessionId: sesion.id, creada, historial: entradas, tokens, tokensEnCache, costo })
  }

  async function archivos(_peticion: Request, caso: string): Promise<Response> {
    if (!(await existeCaso(raiz, caso))) return error("El caso no existe.", 404)
    return json({ archivos: await listarArchivos(raiz, caso) })
  }

  async function archivo(peticion: Request): Promise<Response> {
    const absoluta = resolverRutaSegura(raiz, new URL(peticion.url).searchParams.get("ruta") ?? "")
    if (!absoluta) return error("Ruta no permitida: solo se sirven archivos de out/.", 400)
    const contenido = Bun.file(absoluta)
    if (!(await contenido.exists())) return error("El archivo no existe.", 404)
    const nombre = path.basename(absoluta).replace(/[^\w.-]/g, "_")
    const tipo = nombre.endsWith(".md") || nombre.endsWith(".jsonl") ? "text/plain; charset=utf-8" : contenido.type
    return new Response(contenido, { headers: { ...CABECERAS, "Content-Type": tipo, "Content-Disposition": `inline; filename="${nombre}"` } })
  }

  async function excel(peticion: Request): Promise<Response> {
    const absoluta = resolverRutaSegura(raiz, new URL(peticion.url).searchParams.get("ruta") ?? "")
    if (!absoluta?.endsWith(".xlsx")) return error("Solo se puede ver un .xlsx de out/.", 400)
    if (!(await Bun.file(absoluta).exists())) return error("El archivo no existe.", 404)
    return json({ hojas: await vistaExcel(absoluta) })
  }

  function registrarEvento(sesion: Sesion | undefined, texto: string): void {
    if (!sesion) return
    // Para que el agente sepa lo que hizo la persona fuera del chat.
    sesion.mensajes.push({ rol: "user", contenido: `[Evento de la interfaz] ${texto}` })
    sesion.historial.push({ rol: "evento", texto, ts: new Date().toISOString() })
  }

  async function firmarCaso(peticion: Request, caso: string): Promise<Response> {
    const cuerpo = FirmaSchema.safeParse(await peticion.json().catch(() => null))
    if (!cuerpo.success) return error("Petición inválida: se espera { metodo: 'dibujada' | 'clic', imagen? }.", 400)
    const sesion = cuerpo.data.sessionId ? sesiones.obtener(cuerpo.data.sessionId) : undefined
    if (sesion?.ocupada) return error("Espera a que el agente termine de responder para firmar.", 409)
    const resultado = await firmar(raiz, caso, cuerpo.data.metodo, cuerpo.data.imagen, sesion?.id ?? null)
    if (!resultado.ok) return error(resultado.error, 409)
    registrarEvento(sesion, eventoDeFirma(resultado.data))
    return json({ firma: resultado.data })
  }

  const rutas: [string, RegExp, Manejador][] = [
    ["POST", /^\/api\/chat$/, chat],
    ["GET", /^\/api\/sessions\/([^/]+)$/, historial],
    ["GET", /^\/api\/casos$/, async () => json({ casos: await listarCasos(raiz) })],
    ["GET", /^\/api\/casos\/([^/]+)\/archivos$/, archivos],
    ["GET", /^\/api\/casos\/([^/]+)\/firma$/, async (_peticion, caso) => json(await consultarFirma(raiz, caso))],
    ["POST", /^\/api\/casos\/([^/]+)\/firma$/, firmarCaso],
    ["GET", /^\/api\/archivo$/, archivo],
    ["GET", /^\/api\/excel$/, excel],
  ]

  function salud(): Response {
    return json({ ok: true, provider: ciclo.llm.proveedor, model: ciclo.llm.modelo, acceso: opciones.claveAcceso ? "con_clave" : "abierto" })
  }

  async function estatico(pathname: string): Promise<Response> {
    const nombre = pathname === "/" ? "index.html" : pathname.match(ARCHIVO_WEB)?.[1]
    const contenido = nombre ? Bun.file(path.join(raiz, "web", nombre)) : null
    if (!contenido || !(await contenido.exists())) return error("No encontrado.", 404)
    return new Response(contenido, { headers: { ...CABECERAS, "Content-Security-Policy": CSP } })
  }

  return async function enrutar(peticion: Request): Promise<Response> {
    const { pathname } = new URL(peticion.url)
    if (peticion.method === "GET" && pathname === "/api/health") return salud()
    if (pathname.startsWith("/api/")) {
      if (!autorizado(peticion)) return error("Clave de acceso inválida.", 401)
      for (const [metodo, patron, manejar] of rutas) {
        const coincidencia = pathname.match(patron)
        if (coincidencia && peticion.method === metodo) return manejar(peticion, decodeURIComponent(coincidencia[1] ?? ""))
      }
      return error("No encontrado.", 404)
    }
    if (peticion.method === "GET") return estatico(pathname)
    return error("Método no permitido.", 405)
  }
}
