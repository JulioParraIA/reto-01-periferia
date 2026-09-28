/**
 * Verificación sin modelo (sección 6.6 del PRD): procesa todos los casos llamando
 * directamente a las herramientas e imprime un resumen por caso. No usa ninguna clave.
 *
 *   bun install && bun run demo.ts
 */
import { readdir, rm } from "node:fs/promises"
import path from "node:path"
import { z } from "zod"
import * as proveedor from "./src/tools/proveedor.ts"

/** Fecha fija para que la demo dé siempre lo mismo: la de los PRD del reto (versión 2.0 del 2026-09-03). */
const FECHA_REFERENCIA = "2026-09-03"
const ctx = { directory: import.meta.dir, sessionId: "demo" }

const LecturaSchema = z.object({ cliente: z.string(), pais: z.string(), formato: z.string(), campos: z.array(z.string()) })
const MapeoSchema = z.object({
  llenos: z.array(z.object({ etiqueta: z.string() })),
  faltantes: z.array(z.object({ etiqueta: z.string(), motivo: z.string() })),
  requiere_confirmacion: z.array(z.object({ etiqueta: z.string(), nota: z.string() })),
  mapeo: z.array(z.object({ etiqueta: z.string(), clave: z.string().nullable() })),
})
const FormularioSchema = z.object({ ruta: z.string(), soportado: z.boolean(), aviso: z.string().optional() })
const PaqueteSchema = z.object({
  ruta: z.string(),
  listo_para_firma: z.boolean(),
  checklist: z.object({ soportes: z.array(z.object({ nombre: z.string(), estado: z.string() })), bloqueos: z.array(z.string()) }),
})
const EnvioSchema = z.object({ ruta: z.string() })

type Respuesta<T> = { ok: true; data: T } | { ok: false; error: string }

/** Las herramientas devuelven texto JSON; aquí se valida la parte que la demo imprime. */
async function llamar<T>(salida: Promise<string>, esquema: z.ZodType<T>): Promise<Respuesta<T>> {
  const respuesta = z
    .union([z.object({ ok: z.literal(true), data: esquema }), z.object({ ok: z.literal(false), error: z.string() })])
    .safeParse(JSON.parse(await salida))
  return respuesta.success ? respuesta.data : { ok: false, error: `respuesta inesperada: ${respuesta.error.message}` }
}

function contar(soportes: { estado: string }[], estado: string): number {
  return soportes.filter((soporte) => soporte.estado === estado).length
}

async function procesar(caso: string): Promise<void> {
  console.log(`\n■ ${caso}`)
  const lectura = await llamar(proveedor.leer_solicitud.execute({ caso }, ctx), LecturaSchema)
  if (!lectura.ok) return console.log(`  Error: ${lectura.error}`)
  const { cliente, pais, formato, campos } = lectura.data
  console.log(`  ${cliente} (${pais}), formato ${formato}`)

  const mapeo = await llamar(proveedor.mapear_campos.execute({ caso, campos }, ctx), MapeoSchema)
  if (!mapeo.ok) return console.log(`  Error: ${mapeo.error}`)
  const { llenos, faltantes, requiere_confirmacion } = mapeo.data
  console.log(`  Campos: ${campos.length} · llenos ${llenos.length} · faltantes ${faltantes.length} · por confirmar ${requiere_confirmacion.length}`)
  for (const campo of faltantes) console.log(`    faltante: ${campo.etiqueta} (${campo.motivo})`)
  for (const campo of requiere_confirmacion) console.log(`    por confirmar: ${campo.etiqueta} (${campo.nota})`)

  const formulario = await llamar(proveedor.generar_formulario.execute({ caso, mapeo: mapeo.data.mapeo }, ctx), FormularioSchema)
  if (!formulario.ok) return console.log(`  Error: ${formulario.error}`)
  console.log(`  Formulario: ${formulario.data.ruta}${formulario.data.aviso ? ` (${formulario.data.aviso})` : ""}`)

  const paquete = await llamar(proveedor.armar_paquete.execute({ caso, fecha_referencia: FECHA_REFERENCIA }, ctx), PaqueteSchema)
  if (!paquete.ok) return console.log(`  Error: ${paquete.error}`)
  const { soportes, bloqueos } = paquete.data.checklist
  console.log(`  Soportes: ${contar(soportes, "presente")} presentes · ${contar(soportes, "vencido")} vencidos · ${contar(soportes, "ausente")} ausentes`)
  console.log(`  Paquete: ${paquete.data.listo_para_firma ? "LISTO PARA FIRMA" : "NO LISTO PARA FIRMA"} → ${paquete.data.ruta}`)
  for (const bloqueo of bloqueos) console.log(`    bloquea: ${bloqueo}`)
}

async function demostrarEnvio(caso: string): Promise<void> {
  console.log(`\n■ Envío simulado de ${caso} (proveedor_simular_envio)`)
  const sinConfirmar = await llamar(proveedor.simular_envio.execute({ caso, confirmado: false }, ctx), EnvioSchema)
  console.log(`  Sin confirmación: ${sinConfirmar.ok ? sinConfirmar.data.ruta : `rechazado → "${sinConfirmar.error}"`}`)
  const confirmado = await llamar(proveedor.simular_envio.execute({ caso, confirmado: true }, ctx), EnvioSchema)
  console.log(`  Con confirmación: ${confirmado.ok ? confirmado.data.ruta : `error → ${confirmado.error}`}`)
}

async function main(): Promise<void> {
  await rm(path.join(ctx.directory, "out"), { recursive: true, force: true })
  const carpeta = path.join(ctx.directory, "fixtures", "reto-01", "casos")
  const casos = (await readdir(carpeta, { withFileTypes: true })).filter((entrada) => entrada.isDirectory()).map((entrada) => entrada.name).sort()
  console.log(`Demo reto 01: herramientas sin modelo · fecha de referencia ${FECHA_REFERENCIA} · ${casos.length} casos`)
  for (const caso of casos) await procesar(caso)
  await demostrarEnvio("co-industrias-delta")
  console.log("\n■ Caso que no existe (el error no detiene la demo)")
  await procesar("xx-caso-inexistente")
  console.log("\nArchivos generados en out/. Registro por caso en out/<caso>/log.jsonl.")
}

await main()
