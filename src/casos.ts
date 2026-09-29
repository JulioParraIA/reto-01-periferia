/** Lista de casos de fixtures/ para la interfaz (solo lectura; no pasa por el agente ni deja registro). */
import { readdir, readFile } from "node:fs/promises"
import path from "node:path"
import { z } from "zod"

const NOMBRE_CASO = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

const ResumenSchema = z.object({
  cliente: z.string(),
  pais: z.string(),
  formato: z.string(),
  asunto: z.string(),
  fecha: z.string(),
  de: z.string(),
})

export type ResumenCaso = { caso: string } & z.infer<typeof ResumenSchema>

function carpetaCasos(raiz: string): string {
  return path.join(raiz, "fixtures", "reto-01", "casos")
}

async function nombresDeCasos(raiz: string): Promise<string[]> {
  try {
    const entradas = await readdir(carpetaCasos(raiz), { withFileTypes: true })
    return entradas.filter((entrada) => entrada.isDirectory() && NOMBRE_CASO.test(entrada.name)).map((entrada) => entrada.name).sort()
  } catch {
    return []
  }
}

export async function existeCaso(raiz: string, caso: string): Promise<boolean> {
  return NOMBRE_CASO.test(caso) && (await nombresDeCasos(raiz)).includes(caso)
}

async function resumir(raiz: string, caso: string): Promise<ResumenCaso | null> {
  try {
    const texto = await readFile(path.join(carpetaCasos(raiz), caso, "solicitud.json"), "utf8")
    const leido = ResumenSchema.safeParse(JSON.parse(texto))
    return leido.success ? { caso, ...leido.data } : null
  } catch {
    return null
  }
}

/** Los casos con una solicitud legible; uno dañado se omite en la lista y el agente lo reporta al procesarlo. */
export async function listarCasos(raiz: string): Promise<ResumenCaso[]> {
  const resumenes = await Promise.all((await nombresDeCasos(raiz)).map((caso) => resumir(raiz, caso)))
  return resumenes.filter((resumen) => resumen !== null)
}
