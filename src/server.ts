/**
 * Servidor HTTP: API del chat (sección 6.4 del PRD) y el front de web/, con un solo comando.
 *   bun run dev   →   http://localhost:3000
 */
import { timingSafeEqual } from "node:crypto"
import path from "node:path"
import { z } from "zod"
import { procesarTurno, type DependenciasCiclo } from "./agente/ciclo.ts"
import { HERRAMIENTAS } from "./agente/herramientas.ts"
import { cargarPromptSistema } from "./agente/prompt.ts"
import { Sesiones } from "./agente/sesiones.ts"
import { leerConfig } from "./config.ts"
import { AdaptadorOpenRouter } from "./llm/openrouter.ts"

const RAIZ = path.resolve(import.meta.dir, "..")
const config = leerConfig()
const llm = new AdaptadorOpenRouter({
  clave: config.claveModelo,
  modelo: config.modelo,
  maxTokens: config.maxTokensRespuesta,
  timeoutMs: config.timeoutMs,
  esfuerzo: config.esfuerzo,
})
const deps: DependenciasCiclo = {
  llm,
  herramientas: HERRAMIENTAS,
  directorio: RAIZ,
  maxIteraciones: config.maxIteraciones,
  maxTokensSesion: config.maxTokensSesion,
}
const promptSistema = await cargarPromptSistema(RAIZ)
const sesiones = new Sesiones()

const ARCHIVOS_WEB: Record<string, string> = { "/": "index.html", "/app.js": "app.js", "/estilos.css": "estilos.css" }
const CABECERAS = { "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" }
const CSP = "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'"
const ID_SESION = /^[A-Za-z0-9_-]{8,64}$/

const ChatSchema = z.object({
  sessionId: z.string().regex(ID_SESION),
  message: z.string().trim().min(1).max(4000),
  /** true cuando la persona pulsa «Confirmar» en el chat. */
  confirmar: z.boolean().optional(),
})

function json(datos: unknown, estado = 200): Response {
  return Response.json(datos, { status: estado, headers: CABECERAS })
}

/** Si CLAVE_ACCESO está definida, la API la exige en la cabecera x-clave-acceso. */
function autorizado(peticion: Request): boolean {
  if (!config.claveAcceso) return true
  const recibida = Buffer.from(peticion.headers.get("x-clave-acceso") ?? "")
  const esperada = Buffer.from(config.claveAcceso)
  return recibida.length === esperada.length && timingSafeEqual(recibida, esperada)
}

async function chat(peticion: Request): Promise<Response> {
  if (!autorizado(peticion)) return json({ error: "Clave de acceso inválida." }, 401)
  const cuerpo = ChatSchema.safeParse(await peticion.json().catch(() => null))
  if (!cuerpo.success) return json({ error: "Petición inválida: se espera { sessionId, message }." }, 400)
  const sesion = sesiones.obtenerOCrear(cuerpo.data.sessionId, promptSistema)
  if (sesion.ocupada) return json({ error: "La sesión todavía está respondiendo el mensaje anterior." }, 409)
  sesion.ocupada = true
  try {
    return json(await procesarTurno(sesion, cuerpo.data.message, cuerpo.data.confirmar ?? false, deps))
  } finally {
    sesion.ocupada = false
  }
}

function historial(peticion: Request, id: string): Response {
  if (!autorizado(peticion)) return json({ error: "Clave de acceso inválida." }, 401)
  const sesion = sesiones.obtener(id)
  if (!sesion) return json({ error: "No existe esa sesión." }, 404)
  return json({ sessionId: sesion.id, creada: sesion.creada, historial: sesion.historial, tokens: sesion.tokens, costo: sesion.costo })
}

function salud(): Response {
  return json({ ok: true, provider: llm.proveedor, model: llm.modelo, acceso: config.claveAcceso ? "con_clave" : "abierto" })
}

function archivoWeb(ruta: string): Response | null {
  const archivo = ARCHIVOS_WEB[ruta]
  if (!archivo) return null
  return new Response(Bun.file(path.join(RAIZ, "web", archivo)), { headers: { ...CABECERAS, "Content-Security-Policy": CSP } })
}

async function enrutar(peticion: Request): Promise<Response> {
  const { pathname } = new URL(peticion.url)
  if (peticion.method === "GET" && pathname === "/api/health") return salud()
  if (peticion.method === "POST" && pathname === "/api/chat") return chat(peticion)
  const sesion = pathname.match(/^\/api\/sessions\/([^/]+)$/)
  if (peticion.method === "GET" && sesion?.[1]) return historial(peticion, sesion[1])
  if (peticion.method === "GET") return archivoWeb(pathname) ?? json({ error: "No encontrado." }, 404)
  return json({ error: "Método no permitido." }, 405)
}

const servidor = Bun.serve({
  port: config.puerto,
  hostname: "0.0.0.0",
  // Un turno con varias herramientas puede tardar; Bun corta a los 10 s por defecto.
  idleTimeout: 255,
  fetch: enrutar,
  error(error) {
    console.error("Error no controlado:", error)
    return json({ error: "Error interno del servidor." }, 500)
  },
})

console.log(`Agente de registro como proveedor en http://localhost:${servidor.port} · ${llm.proveedor} ${llm.modelo}`)
if (!config.claveModelo) console.log("Aviso: falta OPENROUTER_API_KEY; el chat responderá con un error hasta configurarla.")
