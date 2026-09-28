/** Utilidades de prueba: cada prueba trabaja sobre una copia temporal de fixtures/ y nunca toca out/ del proyecto. */
import { cp, mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { z } from "zod"

export const RAIZ = path.resolve(import.meta.dir, "..")

export async function proyectoTemporal(): Promise<string> {
  const directorio = await mkdtemp(path.join(os.tmpdir(), "reto01-"))
  await cp(path.join(RAIZ, "fixtures"), path.join(directorio, "fixtures"), { recursive: true })
  return directorio
}

export function borrar(directorio: string): Promise<void> {
  return rm(directorio, { recursive: true, force: true })
}

/** Lee la respuesta JSON de una herramienta y valida `data` con el esquema dado (falla la prueba si no es ok). */
export function datos<T>(texto: string, esquema: z.ZodType<T>): T {
  const respuesta = z.object({ ok: z.literal(true), data: esquema }).safeParse(JSON.parse(texto))
  if (!respuesta.success) throw new Error(`Se esperaba { ok: true } con otra forma y llegó: ${texto}`)
  return respuesta.data.data
}

/** Lee una respuesta de error de una herramienta y devuelve el mensaje. */
export function error(texto: string): string {
  const respuesta = z.object({ ok: z.literal(false), error: z.string() }).safeParse(JSON.parse(texto))
  if (!respuesta.success) throw new Error(`Se esperaba { ok: false } y llegó: ${texto}`)
  return respuesta.data.error
}

export const LecturaSchema = z.object({ pais: z.string(), cliente: z.string(), formato: z.string(), campos: z.array(z.string()), soportes: z.array(z.string()) })
export const CampoSchema = z.object({ etiqueta: z.string(), clave: z.string().optional(), nota: z.string().optional(), motivo: z.string().optional() })
export const MapeoSchema = z.object({
  llenos: z.array(CampoSchema),
  faltantes: z.array(CampoSchema),
  requiere_confirmacion: z.array(CampoSchema),
  mapeo: z.array(z.object({ etiqueta: z.string(), clave: z.string().nullable() })),
})
export const FormularioSchema = z.object({ ruta: z.string(), formato: z.string(), soportado: z.boolean() })
export const PaqueteSchema = z.object({
  ruta: z.string(),
  listo_para_firma: z.boolean(),
  checklist: z.object({ bloqueos: z.array(z.string()), soportes: z.array(z.object({ tipo: z.string(), estado: z.string() })) }),
})
