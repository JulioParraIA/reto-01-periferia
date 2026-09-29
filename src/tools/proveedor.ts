/**
 * Herramientas del agente «Registro como proveedor».
 *
 * Cada export es una herramienta y el modelo la ve como `proveedor_<export>`.
 * Son la única fuente de valores del agente: leen fixtures/ (solo lectura) y escriben en out/.
 * Ninguna lanza excepciones: todas devuelven JSON con { ok: true, data } o { ok: false, error }.
 *
 * El archivo es autocontenido (solo depende de zod, exceljs, pdf-lib y node) para que
 * modulo/tools/proveedor.ts sea una copia exacta que otras plataformas de agentes puedan cargar.
 */
import { access, appendFile, copyFile, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { Workbook, type Worksheet } from "exceljs"
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib"
import { z } from "zod"

// ─── Tipos y constantes ──────────────────────────────────────────────────────

/** Contexto que entrega el backend. `sessionID` es el nombre que usa OpenCode. */
type Contexto = { directory: string; sessionId?: string; sessionID?: string }
type Fallo = { ok: false; error: string }
type Resultado<T> = { ok: true; data: T } | Fallo
type Valor = string | number | boolean

/** HU-2: un mapeo con confianza menor a esta requiere confirmación humana. */
const UMBRAL_CONFIANZA = 0.8
/** Por debajo de esta similitud no se propone ninguna clave y el campo queda faltante. */
const UMBRAL_CANDIDATO = 0.5
/** RN1: Periferia solo tiene NIT colombiano; así se llama el identificador en cada país. */
const IDENTIFICADOR_POR_PAIS: Record<string, string> = { CO: "NIT", EC: "RUC", PE: "RUC", PA: "RUC", HN: "RTN" }
const CLAVE_IDENTIFICADOR = "nit"
const PREFIJO_BANCARIO = "banco."
const ERROR_CONFIRMACION = "requiere confirmación explícita"
const NOMBRE_CASO = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const ZONA_HORARIA = "America/Bogota"
const PLANTILLA_POR_FORMATO: Record<string, TipoPlantilla> = { xlsx: "celdas", pdf: "campos", portal: "campos" }
const ERRORES_EN_ESPANOL = { error: z.locales.es().localeError }

// ─── Esquemas de los fixtures ────────────────────────────────────────────────

const CELDA = /^[A-Z]{1,3}[1-9][0-9]*$/

const SolicitudSchema = z.object({
  id: z.string(),
  de: z.string(),
  para: z.string(),
  asunto: z.string(),
  fecha: z.string(),
  pais: z.string(),
  cliente: z.string(),
  formato: z.string(),
  cuerpo: z.string(),
  adjuntos: z.array(z.string()),
})
const CeldasSchema = z
  .array(
    z.object({
      hoja: z.string().min(1),
      celda_etiqueta: z.string().regex(CELDA),
      etiqueta: z.string().min(1),
      celda_valor: z.string().regex(CELDA),
    }),
  )
  .min(1)
const CamposPdfSchema = z.array(z.object({ etiqueta: z.string().min(1), obligatorio: z.boolean() })).min(1)
const ExigidosSchema = z.array(z.string().min(1))
const IndiceSchema = z.array(
  z.object({
    tipo: z.string(),
    archivo: z.string(),
    vigencia_hasta: z.string().nullable(),
    pais_emisor: z.string(),
    descripcion: z.string(),
  }),
)
const GlosarioSchema = z.record(z.string(), z.string())
const MaestroSchema = z.record(z.string(), z.unknown())

/** Estado de los campos que deja proveedor_generar_formulario para el checklist (sin valores). */
const EstadoCamposSchema = z.object({
  formato: z.string(),
  archivo: z.string(),
  campos: z.array(
    z.object({
      etiqueta: z.string(),
      estado: z.enum(["lleno", "faltante", "requiere_confirmacion"]),
      obligatorio: z.boolean().nullable(),
      detalle: z.string().nullable(),
    }),
  ),
})
/**
 * Lo que deja proveedor_armar_paquete para proveedor_simular_envio. La firma la agrega la
 * persona desde la interfaz (no hay herramienta para firmar: el agente nunca firma).
 */
const EstadoPaqueteSchema = z.object({
  listo_para_firma: z.boolean(),
  fecha_referencia: z.string(),
  bloqueos: z.array(z.string()),
  para: z.string(),
  asunto: z.string(),
  adjuntos: z.array(z.string()),
  firma: z
    .object({
      firmante: z.string(),
      cargo: z.string(),
      metodo: z.enum(["dibujada", "clic"]),
      fecha: z.string(),
      codigo: z.string(),
      archivo: z.string(),
    })
    .nullish(),
})

type Solicitud = z.infer<typeof SolicitudSchema>
type Celda = z.infer<typeof CeldasSchema>[number]
type CampoPdf = z.infer<typeof CamposPdfSchema>[number]
type Soporte = z.infer<typeof IndiceSchema>[number]
type Glosario = z.infer<typeof GlosarioSchema>
type Maestro = z.infer<typeof MaestroSchema>
type EstadoCampos = z.infer<typeof EstadoCamposSchema>
type EstadoPaquete = z.infer<typeof EstadoPaqueteSchema>

type TipoPlantilla = "celdas" | "campos"
type Plantilla = { tipo: "celdas"; celdas: Celda[] } | { tipo: "campos"; campos: CampoPdf[] }
type Caso = { nombre: string; solicitud: Solicitud; plantilla: Plantilla; exigidos: string[] }

type CampoMapeado =
  | { estado: "lleno"; etiqueta: string; clave: string; valor: Valor; confianza: number }
  | { estado: "requiere_confirmacion"; etiqueta: string; clave: string; valor: Valor; confianza: number; nota: string }
  | { estado: "faltante"; etiqueta: string; motivo: string }
type Asignacion = { etiqueta: string; clave: string | null }

type EstadoSoporte = "presente" | "vencido" | "ausente"
type SoporteRevisado = {
  tipo: string
  nombre: string
  estado: EstadoSoporte
  vigencia_hasta: string | null
  archivo: string | null
}

// ─── Utilidades generales ────────────────────────────────────────────────────

function exito<T>(data: T): { ok: true; data: T } {
  return { ok: true, data }
}

function fallo(error: string): Fallo {
  return { ok: false, error }
}

function esObjeto(valor: unknown): valor is Record<string, unknown> {
  return typeof valor === "object" && valor !== null && !Array.isArray(valor)
}

async function existe(ruta: string): Promise<boolean> {
  try {
    await access(ruta)
    return true
  } catch {
    return false
  }
}

function hoyEnBogota(): string {
  const formato = { timeZone: ZONA_HORARIA, year: "numeric", month: "2-digit", day: "2-digit" } as const
  return new Intl.DateTimeFormat("en-CA", formato).format(new Date())
}

function describirProblema(error: z.ZodError): string {
  const problema = error.issues[0]
  if (!problema) return "contenido inválido"
  const donde = problema.path.length > 0 ? problema.path.join(".") : "raíz"
  return `${donde}: ${problema.message}`
}

/** Lee y valida un JSON; cualquier problema vuelve como mensaje claro, nunca como excepción. */
async function leerJson<T>(ruta: string, esquema: z.ZodType<T>, nombre: string): Promise<Resultado<T>> {
  let texto: string
  try {
    texto = await readFile(ruta, "utf8")
  } catch {
    return fallo(`No se encontró ${nombre}.`)
  }
  let json: unknown
  try {
    json = JSON.parse(texto)
  } catch {
    return fallo(`No se pudo leer ${nombre}: no es un JSON válido.`)
  }
  const validado = esquema.safeParse(json, ERRORES_EN_ESPANOL)
  if (!validado.success) return fallo(`No se pudo leer ${nombre}: no tiene el formato esperado (${describirProblema(validado.error)}).`)
  return exito(validado.data)
}

// ─── Rutas ───────────────────────────────────────────────────────────────────

function rutaFixtures(ctx: Contexto, ...partes: string[]): string {
  return path.join(ctx.directory, "fixtures", "reto-01", ...partes)
}

function rutaSalida(ctx: Contexto, caso: string, ...partes: string[]): string {
  return path.join(ctx.directory, "out", caso, ...partes)
}

/** Las rutas que se devuelven son relativas a la raíz del proyecto y con «/». */
function relativa(ctx: Contexto, ruta: string): string {
  return path.relative(ctx.directory, ruta).split(path.sep).join("/")
}

// ─── Carga de un caso ────────────────────────────────────────────────────────

async function listarCasos(ctx: Contexto): Promise<string[]> {
  try {
    const entradas = await readdir(rutaFixtures(ctx, "casos"), { withFileTypes: true })
    return entradas.filter((entrada) => entrada.isDirectory()).map((entrada) => entrada.name).sort()
  } catch {
    return []
  }
}

async function validarCaso(ctx: Contexto, caso: string): Promise<Resultado<string>> {
  if (!NOMBRE_CASO.test(caso)) {
    return fallo(`"${caso}" no es un nombre de caso válido; se usa el nombre de la carpeta, por ejemplo "co-industrias-delta".`)
  }
  const casos = await listarCasos(ctx)
  if (!casos.includes(caso)) return fallo(`El caso "${caso}" no existe. Casos disponibles: ${casos.join(", ") || "ninguno"}.`)
  return exito(caso)
}

async function cargarPlantilla(carpeta: string, caso: string, formato: string): Promise<Resultado<Plantilla>> {
  const conCeldas = await existe(path.join(carpeta, "plantilla-celdas.json"))
  const tipo = PLANTILLA_POR_FORMATO[formato] ?? (conCeldas ? "celdas" : "campos")
  if (tipo === "celdas") {
    const celdas = await leerJson(path.join(carpeta, "plantilla-celdas.json"), CeldasSchema, `la plantilla de celdas del caso ${caso}`)
    return celdas.ok ? exito({ tipo, celdas: celdas.data }) : celdas
  }
  const campos = await leerJson(path.join(carpeta, "plantilla-campos.json"), CamposPdfSchema, `la plantilla de campos del caso ${caso}`)
  return campos.ok ? exito({ tipo, campos: campos.data }) : campos
}

async function cargarCaso(ctx: Contexto, caso: string): Promise<Resultado<Caso>> {
  const valido = await validarCaso(ctx, caso)
  if (!valido.ok) return valido
  const carpeta = rutaFixtures(ctx, "casos", caso)
  const solicitud = await leerJson(path.join(carpeta, "solicitud.json"), SolicitudSchema, `la solicitud del caso ${caso}`)
  if (!solicitud.ok) return solicitud
  const plantilla = await cargarPlantilla(carpeta, caso, solicitud.data.formato)
  if (!plantilla.ok) return plantilla
  const exigidos = await leerJson(path.join(carpeta, "soportes-exigidos.json"), ExigidosSchema, `la lista de soportes del caso ${caso}`)
  if (!exigidos.ok) return exigidos
  return exito({ nombre: caso, solicitud: solicitud.data, plantilla: plantilla.data, exigidos: exigidos.data })
}

function cargarGlosario(ctx: Contexto): Promise<Resultado<Glosario>> {
  return leerJson(rutaFixtures(ctx, "glosario-campos.json"), GlosarioSchema, "el glosario de campos")
}

function cargarMaestro(ctx: Contexto): Promise<Resultado<Maestro>> {
  return leerJson(rutaFixtures(ctx, "repositorio", "maestro.json"), MaestroSchema, "el repositorio maestro")
}

function cargarIndice(ctx: Contexto): Promise<Resultado<Soporte[]>> {
  return leerJson(rutaFixtures(ctx, "repositorio", "soportes", "index.json"), IndiceSchema, "el índice de soportes")
}

function etiquetasDe(plantilla: Plantilla): string[] {
  return plantilla.tipo === "celdas" ? plantilla.celdas.map((celda) => celda.etiqueta) : plantilla.campos.map((campo) => campo.etiqueta)
}

function obligatorioDe(plantilla: Plantilla, etiqueta: string): boolean | null {
  if (plantilla.tipo === "celdas") return null
  return plantilla.campos.find((campo) => campo.etiqueta === etiqueta)?.obligatorio ?? null
}

/** P0 es xlsx y P1 es pdf; todo lo demás (P2 portal web o un formato desconocido) no se genera. */
function formatoSoportado(caso: Caso): boolean {
  const { formato } = caso.solicitud
  return (formato === "xlsx" && caso.plantilla.tipo === "celdas") || (formato === "pdf" && caso.plantilla.tipo === "campos")
}

function archivoDeFormulario(caso: Caso): string {
  if (formatoSoportado(caso)) return caso.solicitud.formato === "xlsx" ? "formulario.xlsx" : "formulario.pdf"
  return caso.solicitud.formato === "portal" ? "valores-portal.md" : "valores-para-copiar.md"
}

function avisoDeFormato(formato: string): string {
  return formato === "portal"
    ? "formato no soportado: el portal web no se automatiza; se dejan los valores listos para copiar"
    : `formato no soportado (${formato}): se dejan los valores listos para copiar`
}

// ─── Mapeo de campos (HU-2 y RN1) ────────────────────────────────────────────

const PALABRAS_VACIAS = new Set(["a", "de", "del", "el", "en", "la", "las", "los", "o", "para", "por", "y"])

/** Minúsculas, sin tildes ni signos: «Correo electrónico:» y «correo electronico» quedan iguales. */
function normalizar(texto: string): string {
  return texto
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
}

function palabras(texto: string): Set<string> {
  return new Set(normalizar(texto).split(" ").filter((palabra) => palabra.length > 0 && !PALABRAS_VACIAS.has(palabra)))
}

/** Índice de Jaccard entre las palabras con contenido de dos etiquetas: 0 si no comparten nada, 1 si son iguales. */
function similitud(a: string, b: string): number {
  const deA = palabras(a)
  const deB = palabras(b)
  if (deA.size === 0 || deB.size === 0) return 0
  let comunes = 0
  for (const palabra of deA) if (deB.has(palabra)) comunes++
  return comunes / (deA.size + deB.size - comunes)
}

type Coincidencia = { clave: string; sinonimo: string; confianza: number }

function buscarEnGlosario(etiqueta: string, glosario: Glosario): Coincidencia | null {
  let mejor: Coincidencia | null = null
  for (const [sinonimo, clave] of Object.entries(glosario)) {
    const confianza = normalizar(sinonimo) === normalizar(etiqueta) ? 1 : similitud(etiqueta, sinonimo)
    if (!mejor || confianza > mejor.confianza) mejor = { clave, sinonimo, confianza }
  }
  if (!mejor || mejor.confianza < UMBRAL_CANDIDATO) return null
  return { ...mejor, confianza: Math.round(mejor.confianza * 100) / 100 }
}

/** Sigue una ruta con puntos («banco.numero_cuenta») dentro del maestro. */
function leerRuta(maestro: Maestro, ruta: string): Valor | null {
  let actual: unknown = maestro
  for (const parte of ruta.split(".")) {
    if (!esObjeto(actual) || !Object.hasOwn(actual, parte)) return null
    actual = actual[parte]
  }
  return typeof actual === "string" || typeof actual === "number" || typeof actual === "boolean" ? actual : null
}

function notasDeIdentificador(etiqueta: string, clave: string, pais: string): string[] {
  if (clave !== CLAVE_IDENTIFICADOR) return []
  if (pais !== "CO") {
    const pide = IDENTIFICADOR_POR_PAIS[pais] ?? "su identificador tributario"
    return [`identificador extranjero: el cliente (${pais}) pide ${pide} y Periferia solo tiene NIT colombiano; se llenó con el NIT`]
  }
  if (normalizar(etiqueta) !== "nit") return ["campo ambiguo: en Colombia el identificador tributario es el NIT; se propone el NIT"]
  return []
}

/** Toma una clave del maestro para una etiqueta y decide si queda llena, faltante o por confirmar. */
function evaluarAsignacion(
  etiqueta: string,
  clave: string,
  confianza: number,
  pais: string,
  maestro: Maestro,
  notasPrevias: string[],
): CampoMapeado {
  const valor = leerRuta(maestro, clave)
  if (valor === null) return { estado: "faltante", etiqueta, motivo: `el maestro no tiene un valor en "${clave}"` }
  const notas = [...notasPrevias, ...notasDeIdentificador(etiqueta, clave, pais)]
  if (notas.length === 0) return { estado: "lleno", etiqueta, clave, valor, confianza }
  return { estado: "requiere_confirmacion", etiqueta, clave, valor, confianza, nota: notas.join("; ") }
}

function mapearCampo(etiqueta: string, pais: string, glosario: Glosario, maestro: Maestro): CampoMapeado {
  const coincidencia = buscarEnGlosario(etiqueta, glosario)
  if (!coincidencia) return { estado: "faltante", etiqueta, motivo: "no tiene equivalente en el glosario de campos" }
  const notas =
    coincidencia.confianza < UMBRAL_CONFIANZA
      ? [`mapeo aproximado a "${coincidencia.sinonimo}" (confianza ${coincidencia.confianza})`]
      : []
  return evaluarAsignacion(etiqueta, coincidencia.clave, coincidencia.confianza, pais, maestro, notas)
}

function esClaveBancaria(clave: string): boolean {
  return clave.startsWith(PREFIJO_BANCARIO)
}

/**
 * Resuelve una etiqueta de la plantilla con la clave que trae el mapeo.
 * El mapeo solo trae claves, nunca valores: el valor siempre se lee del maestro.
 */
function resolverCampo(
  etiqueta: string,
  asignaciones: Map<string, string | null>,
  pais: string,
  glosario: Glosario,
  maestro: Maestro,
): CampoMapeado {
  const clave = asignaciones.get(normalizar(etiqueta))
  if (clave === undefined) return { estado: "faltante", etiqueta, motivo: "no venía en el mapeo" }
  const automatico = mapearCampo(etiqueta, pais, glosario, maestro)
  if (clave === null) {
    return automatico.estado === "faltante" ? automatico : { estado: "faltante", etiqueta, motivo: "el mapeo lo dejó sin clave del maestro" }
  }
  if (automatico.estado !== "faltante" && automatico.clave === clave) return automatico
  const pedidoBancario = automatico.estado !== "faltante" && esClaveBancaria(automatico.clave)
  if (esClaveBancaria(clave) && !pedidoBancario) {
    return { estado: "faltante", etiqueta, motivo: "los datos bancarios solo se llenan en los campos bancarios que pide la plantilla" }
  }
  const propuesta = automatico.estado === "faltante" ? "ninguna" : `"${automatico.clave}"`
  return evaluarAsignacion(etiqueta, clave, 1, pais, maestro, [`clave elegida en la conversación (el glosario proponía ${propuesta})`])
}

function contarEstados(campos: CampoMapeado[]): { total: number; llenos: number; faltantes: number; por_confirmar: number } {
  return {
    total: campos.length,
    llenos: campos.filter((campo) => campo.estado === "lleno").length,
    faltantes: campos.filter((campo) => campo.estado === "faltante").length,
    por_confirmar: campos.filter((campo) => campo.estado === "requiere_confirmacion").length,
  }
}

function resumirCampos(campos: CampoMapeado[]): string {
  const cuenta = contarEstados(campos)
  return `${cuenta.total} campos: ${cuenta.llenos} llenos, ${cuenta.faltantes} faltantes, ${cuenta.por_confirmar} por confirmar`
}

function detalleDe(campo: CampoMapeado): string | null {
  if (campo.estado === "faltante") return campo.motivo
  if (campo.estado === "requiere_confirmacion") return campo.nota
  return null
}

// ─── Escritura de formularios (HU-3) ─────────────────────────────────────────

function textoDe(campo: CampoMapeado | undefined): string {
  return campo && campo.estado !== "faltante" ? String(campo.valor) : ""
}

/** Ensancha la columna de una celda para que su texto se lea completo (con tope de 70 caracteres). */
function ajustarAncho(hoja: Worksheet, direccion: string, texto: string): void {
  const columna = hoja.getColumn(direccion.replace(/[0-9]+$/, ""))
  columna.width = Math.max(columna.width ?? 10, Math.min(texto.length + 2, 70))
}

/** P0: escribe cada etiqueta y su valor en la hoja y celda que indica plantilla-celdas.json. */
async function escribirXlsx(destino: string, celdas: Celda[], campos: Map<string, CampoMapeado>): Promise<void> {
  const libro = new Workbook()
  libro.creator = "Agente Registro como proveedor"
  for (const celda of celdas) {
    const hoja = libro.getWorksheet(celda.hoja) ?? libro.addWorksheet(celda.hoja)
    const campo = campos.get(celda.etiqueta)
    hoja.getCell(celda.celda_etiqueta).value = celda.etiqueta
    hoja.getCell(celda.celda_etiqueta).font = { bold: true }
    hoja.getCell(celda.celda_valor).value = campo && campo.estado !== "faltante" ? campo.valor : null
    ajustarAncho(hoja, celda.celda_etiqueta, celda.etiqueta)
    ajustarAncho(hoja, celda.celda_valor, textoDe(campo))
  }
  await libro.xlsx.writeFile(destino)
}

/** Helvetica solo codifica WinAnsi: se reemplaza lo que no cabe para que pdf-lib nunca falle. */
function paraPdf(texto: string): string {
  return texto.replace(/[^\x20-\x7E\xA0-\xFF–—‘’“”•€]/g, "?")
}

function partirEnLineas(texto: string, fuente: PDFFont, tamano: number, ancho: number): string[] {
  const lineas: string[] = []
  let actual = ""
  for (const palabra of paraPdf(texto).split(" ")) {
    const candidata = actual ? `${actual} ${palabra}` : palabra
    if (actual && fuente.widthOfTextAtSize(candidata, tamano) > ancho) {
      lineas.push(actual)
      actual = palabra
    } else {
      actual = candidata
    }
  }
  return actual ? [...lineas, actual] : lineas
}

type Lienzo = { doc: PDFDocument; pagina: PDFPage; y: number; normal: PDFFont; negrita: PDFFont }

const MARGEN = 56
const ANCHO_UTIL = 595.28 - MARGEN * 2

function escribirLinea(lienzo: Lienzo, texto: string, fuente: PDFFont, tamano: number): void {
  if (lienzo.y < MARGEN + tamano) {
    lienzo.pagina = lienzo.doc.addPage([595.28, 841.89])
    lienzo.y = 841.89 - MARGEN
  }
  lienzo.pagina.drawText(texto, { x: MARGEN, y: lienzo.y, size: tamano, font: fuente, color: rgb(0.1, 0.1, 0.1) })
  lienzo.y -= tamano + 5
}

function escribirParrafo(lienzo: Lienzo, texto: string, fuente: PDFFont, tamano: number): void {
  for (const linea of partirEnLineas(texto, fuente, tamano, ANCHO_UTIL)) escribirLinea(lienzo, linea, fuente, tamano)
}

/** P1: PDF generado con cada campo (etiqueta y valor) en el orden de plantilla-campos.json. */
async function escribirPdf(destino: string, solicitud: Solicitud, campos: CampoPdf[], mapeados: Map<string, CampoMapeado>): Promise<void> {
  const doc = await PDFDocument.create()
  doc.setTitle(`Formulario de registro de proveedor - ${solicitud.cliente}`)
  doc.setCreator("Agente Registro como proveedor")
  const lienzo: Lienzo = {
    doc,
    pagina: doc.addPage([595.28, 841.89]),
    y: 841.89 - MARGEN,
    normal: await doc.embedFont(StandardFonts.Helvetica),
    negrita: await doc.embedFont(StandardFonts.HelveticaBold),
  }
  escribirParrafo(lienzo, "Formulario de registro de proveedor", lienzo.negrita, 16)
  escribirParrafo(lienzo, `Cliente: ${solicitud.cliente} · Solicitud del ${solicitud.fecha}: ${solicitud.asunto}`, lienzo.normal, 10)
  lienzo.y -= 10
  for (const campo of campos) {
    escribirParrafo(lienzo, `${campo.etiqueta}${campo.obligatorio ? " *" : ""}`, lienzo.negrita, 10)
    escribirParrafo(lienzo, textoDe(mapeados.get(campo.etiqueta)) || "______________________________", lienzo.normal, 11)
    lienzo.y -= 6
  }
  lienzo.y -= 24
  escribirParrafo(lienzo, "Firma del representante legal: ______________________________", lienzo.normal, 11)
  escribirParrafo(lienzo, "* Campo obligatorio para el cliente.", lienzo.normal, 8)
  await writeFile(destino, await doc.save())
}

function celdaMarkdown(texto: string): string {
  return texto.replace(/\|/g, "\\|").replace(/\s+/g, " ").trim()
}

function estadoLegible(campo: CampoMapeado): string {
  if (campo.estado === "lleno") return "lleno"
  if (campo.estado === "faltante") return `faltante: ${campo.motivo}`
  return `por confirmar: ${campo.nota}`
}

function urlDelPortal(cuerpo: string): string | null {
  const url = cuerpo.match(/https?:\/\/[^\s)]+/)?.[0]
  return url ? url.replace(/[.,;:]+$/, "") : null
}

/** P2: el portal web (o un formato desconocido) no se genera; se dejan los valores listos para copiar. */
async function escribirValores(destino: string, solicitud: Solicitud, campos: CampoMapeado[]): Promise<void> {
  const esPortal = solicitud.formato === "portal"
  const filas = campos.map((campo) => `| ${celdaMarkdown(campo.etiqueta)} | ${celdaMarkdown(textoDe(campo)) || "—"} | ${celdaMarkdown(estadoLegible(campo))} |`)
  const lineas = [
    esPortal ? `# Valores para el portal de ${solicitud.cliente}` : `# Valores para copiar: ${solicitud.cliente}`,
    "",
    esPortal
      ? "> Formato no soportado: el registro en portal web no se automatiza. Una persona entra con las credenciales que el cliente envió al representante legal, copia estos valores, carga los soportes y hace clic en «Enviar»."
      : `> Formato no soportado (${solicitud.formato}): copia estos valores en el formato que envió el cliente.`,
    "",
    ...(esPortal ? [`- Portal: ${urlDelPortal(solicitud.cuerpo) ?? "no viene en la solicitud"}`] : []),
    `- Solicitud: ${solicitud.asunto} (${solicitud.fecha})`,
    "",
    "| Campo | Valor | Estado |",
    "|---|---|---|",
    ...filas,
    "",
  ]
  await writeFile(destino, lineas.join("\n"), "utf8")
}

async function escribirFormulario(destino: string, caso: Caso, mapeados: CampoMapeado[]): Promise<void> {
  const porEtiqueta = new Map(mapeados.map((campo) => [campo.etiqueta, campo]))
  const { plantilla, solicitud } = caso
  if (solicitud.formato === "xlsx" && plantilla.tipo === "celdas") return escribirXlsx(destino, plantilla.celdas, porEtiqueta)
  if (solicitud.formato === "pdf" && plantilla.tipo === "campos") return escribirPdf(destino, solicitud, plantilla.campos, porEtiqueta)
  return escribirValores(destino, solicitud, mapeados)
}

// ─── Soportes y paquete (HU-4, RN2 y RN3) ────────────────────────────────────

function nombreDeSoporte(tipo: string, indice: Soporte[]): string {
  const descripcion = indice.find((soporte) => soporte.tipo === tipo)?.descripcion
  if (descripcion) return descripcion
  const legible = tipo.replace(/_/g, " ")
  return legible.charAt(0).toUpperCase() + legible.slice(1)
}

/** RN3: vencido si vigencia_hasta es anterior a la fecha de referencia; ausente si no está en el repositorio. */
async function revisarSoporte(ctx: Contexto, tipo: string, indice: Soporte[], fecha: string): Promise<SoporteRevisado> {
  const nombre = nombreDeSoporte(tipo, indice)
  const soporte = indice.find((candidato) => candidato.tipo === tipo)
  const disponible = soporte && (await existe(rutaFixtures(ctx, "repositorio", "soportes", soporte.archivo)))
  if (!soporte || !disponible) return { tipo, nombre, estado: "ausente", vigencia_hasta: null, archivo: null }
  const vencido = soporte.vigencia_hasta !== null && soporte.vigencia_hasta < fecha
  return { tipo, nombre, estado: vencido ? "vencido" : "presente", vigencia_hasta: soporte.vigencia_hasta, archivo: soporte.archivo }
}

function bloqueosDe(soportes: SoporteRevisado[], campos: EstadoCampos | null): string[] {
  const bloqueos = campos ? [] : ["el formulario no se ha generado"]
  for (const soporte of soportes) {
    if (soporte.estado === "vencido") bloqueos.push(`${soporte.nombre}: vencido desde ${soporte.vigencia_hasta}`)
    if (soporte.estado === "ausente") bloqueos.push(`${soporte.nombre}: no está en el repositorio`)
  }
  return bloqueos
}

function checklistMarkdown(caso: Caso, fecha: string, soportes: SoporteRevisado[], campos: EstadoCampos | null, bloqueos: string[]): string {
  const vigencia = (soporte: SoporteRevisado) => (soporte.estado === "ausente" ? "—" : (soporte.vigencia_hasta ?? "sin vencimiento"))
  const filasSoportes = soportes.map(
    (soporte) => `| ${celdaMarkdown(soporte.nombre)} | ${soporte.estado} | ${vigencia(soporte)} | ${soporte.archivo ?? "—"} |`,
  )
  const lista = (estado: string) =>
    (campos?.campos ?? [])
      .filter((campo) => campo.estado === estado)
      .map((campo) => `- ${campo.etiqueta}${campo.obligatorio === false ? " (opcional)" : ""}: ${campo.detalle ?? ""}`)
  const faltantes = lista("faltante")
  const porConfirmar = lista("requiere_confirmacion")
  return [
    `# Checklist del paquete para firma: ${caso.solicitud.cliente}`,
    "",
    `- Caso: ${caso.nombre}`,
    `- Fecha de referencia para vigencias: ${fecha}`,
    `- Estado: ${bloqueos.length === 0 ? "LISTO PARA FIRMA" : "NO LISTO PARA FIRMA"}`,
    ...bloqueos.map((bloqueo) => `- Bloquea: ${bloqueo}`),
    "",
    "## Formulario",
    "",
    campos ? `- ${campos.archivo} (formato ${campos.formato}), ${campos.campos.length} campos` : "- No se ha generado",
    "",
    "## Soportes exigidos",
    "",
    "| Soporte | Estado | Vigencia hasta | Archivo |",
    "|---|---|---|---|",
    ...filasSoportes,
    "",
    "## Campos faltantes (no bloquean la firma)",
    "",
    ...(faltantes.length > 0 ? faltantes : ["- Ninguno"]),
    "",
    "## Campos por confirmar antes de firmar",
    "",
    ...(porConfirmar.length > 0 ? porConfirmar : ["- Ninguno"]),
    "",
  ].join("\n")
}

/** RN2: el borrador se arma solo con datos de la solicitud y nombres de documentos; nunca con datos bancarios. */
function borradorMarkdown(caso: Caso, razonSocial: string, adjuntos: string[], soportes: SoporteRevisado[], listo: boolean): string {
  const { solicitud } = caso
  const enviados = soportes.filter((soporte) => soporte.estado !== "ausente").map((soporte) => `- ${soporte.nombre}`)
  const cuerpo =
    solicitud.formato === "portal"
      ? `Les confirmamos que diligenciamos el registro de ${razonSocial} en su portal de proveedores y cargamos los soportes solicitados:`
      : `En respuesta a su solicitud del ${solicitud.fecha}, adjuntamos el formulario de registro de ${razonSocial} firmado por el representante legal, junto con los soportes solicitados:`
  return [
    ...(listo ? [] : ["> Nota interna: el paquete aún no está listo para firma (ver checklist.md). Quita esta nota antes de enviar.", ""]),
    `**Para:** ${solicitud.de}`,
    `**Asunto:** RE: ${solicitud.asunto}`,
    `**Adjuntos:** ${adjuntos.join(", ")}`,
    "",
    "Buenos días,",
    "",
    cuerpo,
    "",
    ...enviados,
    "",
    "Quedamos atentos a cualquier inquietud.",
    "",
    "Cordialmente,",
    "",
    "Área Administrativa",
    razonSocial,
    "",
  ].join("\n")
}

async function leerEstadoCampos(ctx: Contexto, caso: string): Promise<EstadoCampos | null> {
  const estado = await leerJson(rutaSalida(ctx, caso, "campos.json"), EstadoCamposSchema, "el estado del formulario")
  return estado.ok ? estado.data : null
}

// ─── Registro por caso (RN5) ─────────────────────────────────────────────────

async function registrarEnCaso(ctx: Contexto, caso: string, herramienta: string, resultado: Resultado<{ resumen: string }>): Promise<void> {
  try {
    if (!NOMBRE_CASO.test(caso) || !(await listarCasos(ctx)).includes(caso)) return
    const linea = { ts: new Date().toISOString(), herramienta, ok: resultado.ok, resumen: resultado.ok ? resultado.data.resumen : resultado.error }
    await mkdir(rutaSalida(ctx, caso), { recursive: true })
    await appendFile(rutaSalida(ctx, caso, "log.jsonl"), `${JSON.stringify(linea)}\n`, "utf8")
  } catch {
    // Un fallo al escribir el registro no debe tumbar la herramienta.
  }
}

/** Envuelve cada herramienta: nunca lanza, siempre deja registro y siempre devuelve JSON. */
async function ejecutar<T extends { resumen: string }>(
  ctx: Contexto,
  caso: string,
  herramienta: string,
  trabajo: () => Promise<Resultado<T>>,
): Promise<string> {
  let resultado: Resultado<T>
  try {
    resultado = await trabajo()
  } catch (error) {
    const detalle = error instanceof Error ? error.message : String(error)
    resultado = fallo(`Error inesperado en ${herramienta}: ${detalle.split(ctx.directory).join(".")}`)
  }
  await registrarEnCaso(ctx, caso, herramienta, resultado)
  return JSON.stringify(resultado)
}

// ─── Lógica de cada herramienta ──────────────────────────────────────────────

async function leerSolicitud(ctx: Contexto, caso: string) {
  const cargado = await cargarCaso(ctx, caso)
  if (!cargado.ok) return cargado
  const { solicitud, plantilla, exigidos } = cargado.data
  const campos = etiquetasDe(plantilla)
  const soportado = formatoSoportado(cargado.data)
  return exito({
    caso,
    cliente: solicitud.cliente,
    pais: solicitud.pais,
    formato: solicitud.formato,
    soportado,
    ...(soportado ? {} : { aviso: avisoDeFormato(solicitud.formato) }),
    campos,
    soportes: exigidos,
    correo: { de: solicitud.de, asunto: solicitud.asunto, fecha: solicitud.fecha, cuerpo: solicitud.cuerpo },
    resumen: `${solicitud.cliente} (${solicitud.pais}), formato ${solicitud.formato}: ${campos.length} campos y ${exigidos.length} soportes exigidos`,
  })
}

async function mapearCampos(ctx: Contexto, caso: string, campos: string[]) {
  const cargado = await cargarCaso(ctx, caso)
  if (!cargado.ok) return cargado
  const glosario = await cargarGlosario(ctx)
  if (!glosario.ok) return glosario
  const maestro = await cargarMaestro(ctx)
  if (!maestro.ok) return maestro
  const etiquetas = [...new Set(campos.map((campo) => campo.trim()).filter((campo) => campo.length > 0))]
  const mapeados = etiquetas.map((etiqueta) => mapearCampo(etiqueta, cargado.data.solicitud.pais, glosario.data, maestro.data))
  const mapeo: Asignacion[] = mapeados.map((campo) => ({ etiqueta: campo.etiqueta, clave: campo.estado === "faltante" ? null : campo.clave }))
  return exito({
    pais: cargado.data.solicitud.pais,
    llenos: mapeados.filter((campo) => campo.estado === "lleno"),
    faltantes: mapeados.filter((campo) => campo.estado === "faltante"),
    requiere_confirmacion: mapeados.filter((campo) => campo.estado === "requiere_confirmacion"),
    mapeo,
    resumen: resumirCampos(mapeados),
  })
}

async function generarFormulario(ctx: Contexto, caso: string, mapeo: Asignacion[]) {
  const cargado = await cargarCaso(ctx, caso)
  if (!cargado.ok) return cargado
  const glosario = await cargarGlosario(ctx)
  if (!glosario.ok) return glosario
  const maestro = await cargarMaestro(ctx)
  if (!maestro.ok) return maestro
  const { solicitud, plantilla } = cargado.data
  const asignaciones = new Map(mapeo.map((asignacion) => [normalizar(asignacion.etiqueta), asignacion.clave]))
  const mapeados = etiquetasDe(plantilla).map((etiqueta) => resolverCampo(etiqueta, asignaciones, solicitud.pais, glosario.data, maestro.data))
  const archivo = archivoDeFormulario(cargado.data)
  const destino = rutaSalida(ctx, caso, archivo)
  await mkdir(rutaSalida(ctx, caso), { recursive: true })
  await escribirFormulario(destino, cargado.data, mapeados)
  const estado: EstadoCampos = {
    formato: solicitud.formato,
    archivo,
    campos: mapeados.map((campo) => ({ etiqueta: campo.etiqueta, estado: campo.estado, obligatorio: obligatorioDe(plantilla, campo.etiqueta), detalle: detalleDe(campo) })),
  }
  await writeFile(rutaSalida(ctx, caso, "campos.json"), `${JSON.stringify(estado, null, 2)}\n`, "utf8")
  const soportado = formatoSoportado(cargado.data)
  return exito({
    ruta: relativa(ctx, destino),
    formato: solicitud.formato,
    soportado,
    ...(soportado ? {} : { aviso: avisoDeFormato(solicitud.formato) }),
    campos: contarEstados(mapeados),
    resumen: `${relativa(ctx, destino)} con ${resumirCampos(mapeados)}`,
  })
}

async function armarPaquete(ctx: Contexto, caso: string, fechaReferencia: string | undefined) {
  const cargado = await cargarCaso(ctx, caso)
  if (!cargado.ok) return cargado
  const indice = await cargarIndice(ctx)
  if (!indice.ok) return indice
  const maestro = await cargarMaestro(ctx)
  if (!maestro.ok) return maestro
  const fecha = fechaReferencia ?? hoyEnBogota()
  const campos = await leerEstadoCampos(ctx, caso)
  const soportes = await Promise.all(cargado.data.exigidos.map((tipo) => revisarSoporte(ctx, tipo, indice.data, fecha)))
  const bloqueos = bloqueosDe(soportes, campos)
  const listo = bloqueos.length === 0
  const carpeta = rutaSalida(ctx, caso, "paquete")
  await rm(carpeta, { recursive: true, force: true })
  await mkdir(carpeta, { recursive: true })
  const adjuntos: string[] = []
  if (campos && (await existe(rutaSalida(ctx, caso, campos.archivo)))) {
    await copyFile(rutaSalida(ctx, caso, campos.archivo), path.join(carpeta, campos.archivo))
    adjuntos.push(campos.archivo)
  }
  for (const soporte of soportes) {
    if (!soporte.archivo) continue
    await copyFile(rutaFixtures(ctx, "repositorio", "soportes", soporte.archivo), path.join(carpeta, soporte.archivo))
    adjuntos.push(soporte.archivo)
  }
  const razonSocial = String(leerRuta(maestro.data, "razon_social") ?? "Periferia IT Group S.A.S.")
  await writeFile(path.join(carpeta, "checklist.md"), checklistMarkdown(cargado.data, fecha, soportes, campos, bloqueos), "utf8")
  await writeFile(path.join(carpeta, "borrador-correo.md"), borradorMarkdown(cargado.data, razonSocial, adjuntos, soportes, listo), "utf8")
  const estado: EstadoPaquete = {
    listo_para_firma: listo,
    fecha_referencia: fecha,
    bloqueos,
    para: cargado.data.solicitud.de,
    asunto: `RE: ${cargado.data.solicitud.asunto}`,
    adjuntos,
  }
  await writeFile(rutaSalida(ctx, caso, "estado-paquete.json"), `${JSON.stringify(estado, null, 2)}\n`, "utf8")
  const faltantes = (campos?.campos ?? []).filter((campo) => campo.estado === "faltante").map((campo) => campo.etiqueta)
  const porConfirmar = (campos?.campos ?? []).filter((campo) => campo.estado === "requiere_confirmacion").map((campo) => campo.etiqueta)
  return exito({
    ruta: relativa(ctx, carpeta),
    listo_para_firma: listo,
    fecha_referencia: fecha,
    checklist: { soportes, bloqueos, campos_faltantes: faltantes, campos_por_confirmar: porConfirmar },
    confirmacion_pendiente: { herramienta: "proveedor_simular_envio", accion: `enviar el paquete a ${cargado.data.solicitud.de}` },
    resumen: `${relativa(ctx, carpeta)}: ${listo ? "listo para firma" : `no listo (${bloqueos.join("; ")})`}`,
  })
}

async function simularEnvio(ctx: Contexto, caso: string, confirmado: boolean) {
  const valido = await validarCaso(ctx, caso)
  if (!valido.ok) return valido
  if (!confirmado) return fallo(ERROR_CONFIRMACION)
  const estado = await leerJson(rutaSalida(ctx, caso, "estado-paquete.json"), EstadoPaqueteSchema, "el paquete del caso")
  if (!estado.ok) return fallo(`Primero hay que armar el paquete del caso ${caso} con proveedor_armar_paquete.`)
  const paquete = estado.data
  const ahora = new Intl.DateTimeFormat("es-CO", { timeZone: ZONA_HORARIA, dateStyle: "long", timeStyle: "short" }).format(new Date())
  const contenido = [
    `# Envío simulado del caso ${caso}`,
    "",
    `- Fecha: ${ahora} (hora de Bogotá)`,
    `- Confirmado por la usuaria en la sesión: ${ctx.sessionId ?? ctx.sessionID ?? "sin sesión"}`,
    `- Para: ${paquete.para}`,
    `- Asunto: ${paquete.asunto}`,
    `- Adjuntos: ${paquete.adjuntos.join(", ") || "ninguno"}`,
    `- Estado del paquete: ${paquete.listo_para_firma ? "listo para firma" : `NO listo para firma (${paquete.bloqueos.join("; ")})`}`,
    `- Firma del representante legal: ${describirFirma(paquete)}`,
    "",
    "No se envió ningún correo. En este reto «enviar» solo escribe este archivo; la firma y el envío real son decisiones humanas.",
    "",
  ].join("\n")
  const destino = rutaSalida(ctx, caso, "ENVIO-SIMULADO.md")
  await writeFile(destino, contenido, "utf8")
  const firmado = Boolean(paquete.firma)
  return exito({
    ruta: relativa(ctx, destino),
    listo_para_firma: paquete.listo_para_firma,
    firmado,
    resumen: `envío simulado en ${relativa(ctx, destino)}${firmado ? " con el formulario firmado" : " sin firma"}`,
  })
}

function describirFirma(paquete: EstadoPaquete): string {
  const { firma } = paquete
  if (!firma) return "sin firmar"
  const metodo = firma.metodo === "dibujada" ? "firma dibujada" : "firma electrónica con un clic"
  return `${firma.firmante} (${firma.cargo}), ${metodo}, el ${firma.fecha}; código de verificación ${firma.codigo}`
}

// ─── Herramientas (contrato de la sección 6.2 del PRD) ───────────────────────

const argCaso = z.string().describe("Nombre de la carpeta del caso en fixtures/reto-01/casos/, por ejemplo co-industrias-delta")

export const leer_solicitud = {
  description:
    "Lee la solicitud de registro de un caso y devuelve el país, el cliente, el formato de salida, los campos que pide la plantilla y los soportes exigidos.",
  args: { caso: argCaso },
  async execute(args: { caso: string }, ctx: Contexto): Promise<string> {
    return ejecutar(ctx, args.caso, "proveedor_leer_solicitud", () => leerSolicitud(ctx, args.caso))
  },
}

export const mapear_campos = {
  description:
    "Cruza cada campo pedido con el repositorio maestro y lo clasifica como lleno, faltante o requiere_confirmacion; también devuelve el mapeo que se pasa tal cual a proveedor_generar_formulario.",
  args: {
    caso: argCaso,
    campos: z.array(z.string()).min(1).describe("Etiquetas de los campos tal como las devolvió proveedor_leer_solicitud"),
  },
  async execute(args: { caso: string; campos: string[] }, ctx: Contexto): Promise<string> {
    return ejecutar(ctx, args.caso, "proveedor_mapear_campos", () => mapearCampos(ctx, args.caso, args.campos))
  },
}

export const generar_formulario = {
  description:
    "Genera el formulario del caso en el formato que pidió el cliente (xlsx o pdf; si es portal web, deja los valores listos para copiar) leyendo del maestro cada valor según el mapeo.",
  args: {
    caso: argCaso,
    mapeo: z
      .array(
        z.object({
          etiqueta: z.string().min(1).describe("Etiqueta del campo en la plantilla"),
          clave: z.string().min(1).nullable().describe("Ruta del dato en el maestro, o null si el campo es faltante"),
        }),
      )
      .min(1)
      .describe("El mapeo que devolvió proveedor_mapear_campos, tal cual; solo lleva claves, nunca valores"),
  },
  async execute(args: { caso: string; mapeo: Asignacion[] }, ctx: Contexto): Promise<string> {
    return ejecutar(ctx, args.caso, "proveedor_generar_formulario", () => generarFormulario(ctx, args.caso, args.mapeo))
  },
}

export const armar_paquete = {
  description:
    "Arma el paquete para firma del caso (formulario, soportes, checklist y borrador de correo) y dice si queda listo para firma según la vigencia de los soportes.",
  args: {
    caso: argCaso,
    fecha_referencia: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional()
      .describe("Fecha AAAA-MM-DD contra la que se revisa la vigencia de los soportes; si se omite, es la fecha de hoy en Bogotá"),
  },
  async execute(args: { caso: string; fecha_referencia?: string }, ctx: Contexto): Promise<string> {
    return ejecutar(ctx, args.caso, "proveedor_armar_paquete", () => armarPaquete(ctx, args.caso, args.fecha_referencia))
  },
}

export const simular_envio = {
  description:
    "Simula el envío del paquete al cliente escribiendo out/<caso>/ENVIO-SIMULADO.md; solo funciona con la confirmación explícita del usuario.",
  args: {
    caso: argCaso,
    confirmado: z.boolean().describe("true solo si el usuario confirmó el envío de forma explícita en su último mensaje"),
  },
  async execute(args: { caso: string; confirmado: boolean }, ctx: Contexto): Promise<string> {
    return ejecutar(ctx, args.caso, "proveedor_simular_envio", () => simularEnvio(ctx, args.caso, args.confirmado))
  },
}
