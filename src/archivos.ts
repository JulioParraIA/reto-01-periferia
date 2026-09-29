/**
 * Archivos que generan las herramientas en out/<caso>/, para verlos o descargarlos desde la interfaz.
 * Toda ruta pedida se valida para que nunca salga de out/.
 */
import { readdir, stat } from "node:fs/promises"
import path from "node:path"
import { Workbook } from "exceljs"

export type ArchivoGenerado = {
  /** Ruta relativa a la raíz del proyecto, con «/», por ejemplo out/co-industrias-delta/paquete/checklist.md. */
  ruta: string
  nombre: string
  carpeta: "caso" | "paquete"
  bytes: number
  /** Archivos de trabajo del sistema (estado y registros), que la interfaz muestra aparte. */
  interno: boolean
}

export type HojaExcel = { nombre: string; filas: { numero: number; celdas: { columna: string; valor: string }[] }[] }

const INTERNOS = new Set(["campos.json", "estado-paquete.json", "log.jsonl", "firma.json"])

async function archivosDe(carpeta: string): Promise<{ nombre: string; bytes: number }[]> {
  try {
    const entradas = await readdir(carpeta, { withFileTypes: true })
    const archivos = entradas.filter((entrada) => entrada.isFile())
    return Promise.all(archivos.map(async (entrada) => ({ nombre: entrada.name, bytes: (await stat(path.join(carpeta, entrada.name))).size })))
  } catch {
    return []
  }
}

export async function listarArchivos(raiz: string, caso: string): Promise<ArchivoGenerado[]> {
  const base = path.join(raiz, "out", caso)
  const delCaso = (await archivosDe(base)).map((archivo) => ({ ...archivo, carpeta: "caso" as const, ruta: `out/${caso}/${archivo.nombre}` }))
  const delPaquete = (await archivosDe(path.join(base, "paquete"))).map((archivo) => ({
    ...archivo,
    carpeta: "paquete" as const,
    ruta: `out/${caso}/paquete/${archivo.nombre}`,
  }))
  return [...delCaso, ...delPaquete]
    .map((archivo) => ({ ...archivo, interno: INTERNOS.has(archivo.nombre) }))
    .sort((a, b) => a.ruta.localeCompare(b.ruta))
}

/** Devuelve la ruta absoluta solo si queda dentro de out/; cualquier intento de salir devuelve null. */
export function resolverRutaSegura(raiz: string, ruta: string): string | null {
  if (!ruta.startsWith("out/") || ruta.includes("\0")) return null
  const salida = path.resolve(raiz, "out")
  const absoluta = path.resolve(raiz, ruta)
  return absoluta.startsWith(salida + path.sep) ? absoluta : null
}

function textoDeCelda(valor: unknown): string {
  if (valor === null || valor === undefined) return ""
  if (typeof valor === "object" && "richText" in valor && Array.isArray(valor.richText)) {
    return valor.richText.map((parte: { text?: string }) => parte.text ?? "").join("")
  }
  return String(valor)
}

/** Lee un .xlsx generado y lo devuelve como tabla, para ver en pantalla exactamente lo que quedó escrito. */
export async function vistaExcel(absoluta: string): Promise<HojaExcel[]> {
  const libro = new Workbook()
  await libro.xlsx.readFile(absoluta)
  return libro.worksheets.map((hoja) => {
    const filas: HojaExcel["filas"] = []
    hoja.eachRow((fila, numero) => {
      const celdas: { columna: string; valor: string }[] = []
      fila.eachCell((celda) => celdas.push({ columna: celda.address.replace(/[0-9]+$/, ""), valor: textoDeCelda(celda.value) }))
      filas.push({ numero, celdas })
    })
    return { nombre: hoja.name, filas }
  })
}
