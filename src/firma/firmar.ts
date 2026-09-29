/**
 * Firma del representante legal. Es una acción humana: solo se dispara desde la interfaz
 * (POST /api/casos/:caso/firma) y no existe como herramienta, así que el agente nunca firma.
 *
 * Toma el formulario del paquete y le agrega una hoja de firma (página nueva en el PDF,
 * hoja «Firma» en el Excel) con la firma dibujada o un sello de firma electrónica simple con
 * un clic, el firmante del repositorio maestro, la fecha y un código de verificación (SHA-256
 * del formulario sin firmar). No es una firma digital con certificado.
 */
import { createHash } from "node:crypto"
import { readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { Workbook } from "exceljs"
import { PDFDocument, StandardFonts, rgb } from "pdf-lib"
import { z } from "zod"
import { existeCaso } from "../casos.ts"

export type Resultado<T> = { ok: true; data: T } | { ok: false; error: string }

const DatosFirmaSchema = z.object({
  caso: z.string(),
  firmante: z.string(),
  cargo: z.string(),
  metodo: z.enum(["dibujada", "clic"]),
  fecha: z.string(),
  fechaIso: z.string(),
  /** Primeros 16 caracteres del SHA-256 del formulario sin firmar, en grupos de 4. */
  codigo: z.string(),
  sha256Original: z.string(),
  sha256Firmado: z.string(),
  archivo: z.string(),
  sesion: z.string().nullable(),
})

export type DatosFirma = z.infer<typeof DatosFirmaSchema>
export type MetodoFirma = DatosFirma["metodo"]
type Constancia = Omit<DatosFirma, "sha256Firmado" | "archivo">

export type EstadoFirma = {
  firmante: string | null
  cargo: string | null
  /** Se puede firmar: paquete armado, listo para firma y con formulario (el portal no tiene). */
  disponible: boolean
  motivo: string | null
  firma: DatosFirma | null
}

const MAX_BYTES_IMAGEN = 400_000
const FIRMA_PNG = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/
const CABECERA_PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const ZONA_HORARIA = "America/Bogota"

const EstadoPaqueteSchema = z.looseObject({
  listo_para_firma: z.boolean(),
  bloqueos: z.array(z.string()),
  adjuntos: z.array(z.string()),
})
const RepresentanteSchema = z.object({ representante_legal: z.object({ nombre: z.string(), cargo: z.string() }) })

function carpetaPaquete(raiz: string, caso: string): string {
  return path.join(raiz, "out", caso, "paquete")
}

async function leerJson(ruta: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(ruta, "utf8"))
  } catch {
    return null
  }
}

async function representante(raiz: string): Promise<{ nombre: string; cargo: string } | null> {
  const leido = RepresentanteSchema.safeParse(await leerJson(path.join(raiz, "fixtures", "reto-01", "repositorio", "maestro.json")))
  return leido.success ? leido.data.representante_legal : null
}

/** El formulario que se firma: formulario.pdf o formulario.xlsx dentro del paquete. */
function formularioDe(adjuntos: string[]): string | null {
  return adjuntos.find((archivo) => /^formulario(-firmado)?\.(pdf|xlsx)$/.test(archivo))?.replace("-firmado", "") ?? null
}

async function leerEstadoPaquete(raiz: string, caso: string) {
  return EstadoPaqueteSchema.safeParse(await leerJson(path.join(raiz, "out", caso, "estado-paquete.json")))
}

export async function consultarFirma(raiz: string, caso: string): Promise<EstadoFirma> {
  const firmante = await representante(raiz)
  const base = { firmante: firmante?.nombre ?? null, cargo: firmante?.cargo ?? null }
  if (!(await existeCaso(raiz, caso))) return { ...base, disponible: false, motivo: "El caso no existe.", firma: null }
  const estado = await leerEstadoPaquete(raiz, caso)
  if (!estado.success) return { ...base, disponible: false, motivo: "Primero hay que armar el paquete.", firma: null }
  const guardada = DatosFirmaSchema.safeParse(await leerJson(path.join(carpetaPaquete(raiz, caso), "firma.json")))
  const firmaGuardada = guardada.success ? guardada.data : null
  if (!estado.data.listo_para_firma) {
    return { ...base, disponible: false, motivo: `El paquete no está listo para firma: ${estado.data.bloqueos.join("; ")}.`, firma: null }
  }
  if (!formularioDe(estado.data.adjuntos)) {
    return { ...base, disponible: false, motivo: "Este formato no tiene formulario para firmar: el registro se hace en el portal del cliente.", firma: null }
  }
  return { ...base, disponible: true, motivo: null, firma: firmaGuardada }
}

function leerImagen(imagen: string | undefined): Resultado<Buffer> {
  const coincidencia = imagen?.match(FIRMA_PNG)
  if (!coincidencia?.[1]) return { ok: false, error: "La firma dibujada debe llegar como imagen PNG." }
  const bytes = Buffer.from(coincidencia[1], "base64")
  if (bytes.length > MAX_BYTES_IMAGEN) return { ok: false, error: "La imagen de la firma es demasiado grande." }
  if (!bytes.subarray(0, 8).equals(CABECERA_PNG)) return { ok: false, error: "La firma dibujada no es un PNG válido." }
  return { ok: true, data: bytes }
}

function sha256(bytes: Buffer | Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex")
}

function codigoDe(hash: string): string {
  return (hash.slice(0, 16).toUpperCase().match(/.{4}/g) ?? []).join("-")
}

function paraPdf(texto: string): string {
  return texto.replace(/[^\x20-\x7E\xA0-\xFF–—‘’“”•€]/g, "?")
}

/** Constancia de la firma: lo principal en tamaño normal y el hash completo y la aclaración, en letra pequeña. */
function constancia(datos: Constancia): { principal: string[]; pie: string[] } {
  return {
    principal: [
      `Firmante: ${datos.firmante}`,
      `Cargo: ${datos.cargo}`,
      `Método: ${datos.metodo === "dibujada" ? "firma dibujada en pantalla" : "firma electrónica con un clic"}`,
      `Fecha: ${datos.fecha} (hora de Bogotá)`,
      `Código de verificación: ${datos.codigo}`,
    ],
    pie: [
      `SHA-256 del formulario sin firmar: ${datos.sha256Original}`,
      "Firma electrónica simple generada para el reto; no es una firma digital con certificado.",
    ],
  }
}

/** PDF: se agrega una página «Hoja de firma» al final del formulario. */
async function firmarPdf(original: Buffer, datos: Constancia, imagen: Buffer | null): Promise<Uint8Array> {
  const doc = await PDFDocument.load(original)
  const pagina = doc.addPage([595.28, 841.89])
  const normal = await doc.embedFont(StandardFonts.Helvetica)
  const negrita = await doc.embedFont(StandardFonts.HelveticaBold)
  const cursiva = await doc.embedFont(StandardFonts.TimesRomanItalic)
  const tinta = rgb(0.1, 0.1, 0.1)
  pagina.drawText("Hoja de firma", { x: 56, y: 780, size: 18, font: negrita, color: tinta })
  pagina.drawText(paraPdf(`Formulario de registro de proveedor · caso ${datos.caso}`), { x: 56, y: 758, size: 10, font: normal, color: tinta })
  if (imagen) {
    const png = await doc.embedPng(imagen)
    const escala = Math.min(300 / png.width, 110 / png.height, 1)
    pagina.drawImage(png, { x: 56, y: 600, width: png.width * escala, height: png.height * escala })
  } else {
    pagina.drawText(paraPdf(datos.firmante), { x: 56, y: 640, size: 30, font: cursiva, color: rgb(0.07, 0.2, 0.45) })
    pagina.drawRectangle({ x: 50, y: 600, width: 330, height: 80, borderColor: rgb(0.07, 0.2, 0.45), borderWidth: 1 })
    pagina.drawText("FIRMADO ELECTRÓNICAMENTE", { x: 56, y: 608, size: 9, font: negrita, color: rgb(0.07, 0.2, 0.45) })
  }
  pagina.drawLine({ start: { x: 56, y: 592 }, end: { x: 380, y: 592 }, thickness: 0.8, color: tinta })
  const { principal, pie } = constancia(datos)
  principal.forEach((linea, indice) => {
    pagina.drawText(paraPdf(linea), { x: 56, y: 570 - indice * 16, size: 10, font: normal, color: tinta })
  })
  pie.forEach((linea, indice) => {
    pagina.drawText(paraPdf(linea), { x: 56, y: 480 - indice * 12, size: 7.5, font: normal, color: rgb(0.35, 0.35, 0.35) })
  })
  return doc.save()
}

/** Los tipos de exceljs piden ArrayBuffer; se copia (los archivos son pequeños). */
function aArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return new Uint8Array(bytes).buffer
}

/** Excel: se agrega una hoja «Firma» con la constancia y, si la hay, la imagen de la firma. */
async function firmarExcel(original: Buffer, datos: Constancia, imagen: Buffer | null): Promise<Buffer> {
  const libro = new Workbook()
  await libro.xlsx.load(aArrayBuffer(original))
  const hoja = libro.addWorksheet("Firma")
  hoja.getColumn("A").width = 90
  hoja.getCell("A1").value = "Hoja de firma del representante legal"
  hoja.getCell("A1").font = { bold: true, size: 14 }
  const { principal, pie } = constancia(datos)
  ;[...principal, ...pie].forEach((linea, indice) => {
    hoja.getCell(`A${indice + 3}`).value = linea
  })
  if (imagen) {
    const id = libro.addImage({ buffer: aArrayBuffer(imagen), extension: "png" })
    hoja.addImage(id, { tl: { col: 0, row: 11 }, ext: { width: 300, height: 110 } })
  } else {
    hoja.getCell("A12").value = `Firmado electrónicamente por ${datos.firmante}`
    hoja.getCell("A12").font = { italic: true, size: 16, color: { argb: "FF12337A" } }
  }
  return Buffer.from(await libro.xlsx.writeBuffer())
}

/** En estado-paquete.json queda la firma y el formulario firmado reemplaza al original entre los adjuntos. */
async function actualizarEstadoPaquete(raiz: string, datos: DatosFirma, original: string): Promise<void> {
  const ruta = path.join(raiz, "out", datos.caso, "estado-paquete.json")
  const estado = EstadoPaqueteSchema.safeParse(await leerJson(ruta))
  if (!estado.success) return
  const firma = { firmante: datos.firmante, cargo: datos.cargo, metodo: datos.metodo, fecha: datos.fecha, codigo: datos.codigo, archivo: datos.archivo }
  const adjuntos = estado.data.adjuntos.map((adjunto) => (adjunto === original ? datos.archivo : adjunto))
  await writeFile(ruta, `${JSON.stringify({ ...estado.data, adjuntos, firma }, null, 2)}\n`, "utf8")
}

export async function firmar(raiz: string, caso: string, metodo: MetodoFirma, imagen: string | undefined, sesion: string | null): Promise<Resultado<DatosFirma>> {
  const estado = await consultarFirma(raiz, caso)
  if (!estado.disponible || !estado.firmante || !estado.cargo) return { ok: false, error: estado.motivo ?? "No se puede firmar este caso." }
  const paquete = await leerEstadoPaquete(raiz, caso)
  const original = paquete.success ? formularioDe(paquete.data.adjuntos) : null
  if (!original) return { ok: false, error: "No se encontró el formulario del paquete." }
  const imagenLeida = metodo === "dibujada" ? leerImagen(imagen) : null
  if (imagenLeida && !imagenLeida.ok) return imagenLeida
  const bytes = await readFile(path.join(carpetaPaquete(raiz, caso), original))
  const ahora = new Date()
  const hashOriginal = sha256(bytes)
  const base: Constancia = {
    caso,
    firmante: estado.firmante,
    cargo: estado.cargo,
    metodo,
    fecha: new Intl.DateTimeFormat("es-CO", { timeZone: ZONA_HORARIA, dateStyle: "long", timeStyle: "short" }).format(ahora),
    fechaIso: ahora.toISOString(),
    codigo: codigoDe(hashOriginal),
    sha256Original: hashOriginal,
    sesion,
  }
  const png = imagenLeida?.ok ? imagenLeida.data : null
  const firmado = original.endsWith(".pdf") ? await firmarPdf(bytes, base, png) : await firmarExcel(bytes, base, png)
  const archivo = original.replace(/^formulario\./, "formulario-firmado.")
  await writeFile(path.join(carpetaPaquete(raiz, caso), archivo), firmado)
  const datos: DatosFirma = { ...base, sha256Firmado: sha256(firmado), archivo }
  await writeFile(path.join(carpetaPaquete(raiz, caso), "firma.json"), `${JSON.stringify(datos, null, 2)}\n`, "utf8")
  await actualizarEstadoPaquete(raiz, datos, original)
  return { ok: true, data: datos }
}
