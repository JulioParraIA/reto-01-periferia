/**
 * Pruebas del ciclo del agente con un modelo de guion (sin red ni clave): confirmación
 * humana, tope de iteraciones, argumentos inválidos y errores del proveedor.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import path from "node:path"
import { procesarTurno, type DependenciasCiclo } from "../src/agente/ciclo.ts"
import { esAfirmativo } from "../src/agente/confirmacion.ts"
import { HERRAMIENTAS } from "../src/agente/herramientas.ts"
import { Sesiones } from "../src/agente/sesiones.ts"
import type { Sesion } from "../src/agente/tipos.ts"
import {
  ErrorLLM,
  type AdaptadorLLM,
  type EsquemaHerramienta,
  type Mensaje,
  type OpcionesEnvio,
  type RespuestaModelo,
} from "../src/llm/adapter.ts"
import { MapeoSchema, LecturaSchema, borrar, datos, proyectoTemporal } from "./apoyo.ts"

type Paso = (mensajes: Mensaje[], opciones: OpcionesEnvio) => RespuestaModelo

const USO = { entrada: 100, entradaEnCache: 0, salida: 20, costo: 0.001 }

/** Modelo falso: responde cada vuelta con el siguiente paso del guion. */
class ModeloDeGuion implements AdaptadorLLM {
  readonly proveedor = "guion"
  readonly modelo = "guion"
  readonly opcionesRecibidas: OpcionesEnvio[] = []

  constructor(private readonly pasos: Paso[]) {}

  async enviar(mensajes: Mensaje[], _herramientas: EsquemaHerramienta[], opciones: OpcionesEnvio = {}): Promise<RespuestaModelo> {
    this.opcionesRecibidas.push(opciones)
    const paso = this.pasos.shift()
    if (!paso) throw new Error("El guion se quedó sin pasos")
    return paso(mensajes, opciones)
  }
}

let contador = 0
function llamar(nombre: string, argumentos: unknown): Paso {
  return () => ({ texto: "", llamadas: [{ id: `llamada-${++contador}`, nombre, argumentos: JSON.stringify(argumentos) }], uso: USO })
}

function llamarCon(nombre: string, argumentos: (anterior: string) => unknown): Paso {
  return (mensajes) => llamar(nombre, argumentos(ultimoResultado(mensajes)))(mensajes, {})
}

function decir(texto: string): Paso {
  return () => ({ texto, llamadas: [], uso: USO })
}

function ultimoResultado(mensajes: Mensaje[]): string {
  const ultimo = mensajes.at(-1)
  if (ultimo?.rol !== "tool") throw new Error("Se esperaba el resultado de una herramienta")
  return ultimo.contenido
}

/** Guion del caso completo hasta armar el paquete, como lo haría el modelo real. */
function procesarCaso(caso: string): Paso[] {
  return [
    llamar("proveedor_leer_solicitud", { caso }),
    llamarCon("proveedor_mapear_campos", (anterior) => ({ caso, campos: datos(anterior, LecturaSchema).campos })),
    llamarCon("proveedor_generar_formulario", (anterior) => ({ caso, mapeo: datos(anterior, MapeoSchema).mapeo })),
    llamar("proveedor_armar_paquete", { caso, fecha_referencia: "2026-09-03" }),
    decir("Resumen del caso. ¿Quieres que lo envíe?"),
  ]
}

let directorio = ""
let sesion: Sesion

function dependencias(llm: AdaptadorLLM, cambios: Partial<DependenciasCiclo> = {}): DependenciasCiclo {
  return { llm, herramientas: HERRAMIENTAS, directorio, maxIteraciones: 25, maxTokensSesion: 1_000_000, ...cambios }
}

function turno(mensaje: string, llm: AdaptadorLLM, cambios: Partial<DependenciasCiclo> = {}, confirmar = false) {
  return procesarTurno(sesion, mensaje, confirmar, dependencias(llm, cambios))
}

async function existeEnvio(caso: string): Promise<boolean> {
  return Bun.file(path.join(directorio, "out", caso, "ENVIO-SIMULADO.md")).exists()
}

beforeEach(async () => {
  directorio = await proyectoTemporal()
  sesion = new Sesiones().obtenerOCrear("sesion-de-prueba", "prompt de prueba")
})
afterEach(() => borrar(directorio))

describe("flujo con confirmación (CA3 y RN4)", () => {
  test("el turno que arma el paquete queda esperando confirmación y el «envía» siguiente envía", async () => {
    const primero = await turno("Procesa ec-corp-andina. No envíes nada todavía.", new ModeloDeGuion(procesarCaso("ec-corp-andina")))
    expect(primero.toolCalls.map((llamada) => llamada.herramienta)).toEqual([
      "proveedor_leer_solicitud",
      "proveedor_mapear_campos",
      "proveedor_generar_formulario",
      "proveedor_armar_paquete",
    ])
    expect(primero.toolCalls.every((llamada) => llamada.ok)).toBe(true)
    expect(primero.needsConfirmation).toBe(true)
    expect(await existeEnvio("ec-corp-andina")).toBe(false)

    // El modelo manda confirmado: false por descuido: el backend lo fija en true porque el usuario confirmó.
    const segundo = await turno("envía", new ModeloDeGuion([llamar("proveedor_simular_envio", { caso: "ec-corp-andina", confirmado: false }), decir("Listo, enviado.")]))
    expect(segundo.toolCalls[0]).toMatchObject({ herramienta: "proveedor_simular_envio", ok: true, argumentos: { confirmado: true } })
    expect(segundo.needsConfirmation).toBe(false)
    expect(await existeEnvio("ec-corp-andina")).toBe(true)
  })

  test("el modelo no puede confirmar por el usuario", async () => {
    await turno("Procesa co-industrias-delta", new ModeloDeGuion(procesarCaso("co-industrias-delta")))
    const intento = await turno("¿qué soportes tiene?", new ModeloDeGuion([llamar("proveedor_simular_envio", { caso: "co-industrias-delta", confirmado: true }), decir("¿Confirmas el envío?")]))
    expect(intento.toolCalls[0]).toMatchObject({ ok: false, resumen: "requiere confirmación explícita", argumentos: { confirmado: false } })
    expect(intento.needsConfirmation).toBe(true)
    expect(await existeEnvio("co-industrias-delta")).toBe(false)
  })

  test("una negación no confirma y la confirmación solo vale para el caso pendiente", async () => {
    await turno("Procesa co-industrias-delta", new ModeloDeGuion(procesarCaso("co-industrias-delta")))
    const negado = await turno("no, espera", new ModeloDeGuion([llamar("proveedor_simular_envio", { caso: "co-industrias-delta", confirmado: true }), decir("Entendido.")]))
    expect(negado.toolCalls[0]?.ok).toBe(false)
    const otroCaso = await turno("sí", new ModeloDeGuion([llamar("proveedor_simular_envio", { caso: "ec-corp-andina", confirmado: true }), decir("…")]))
    expect(otroCaso.toolCalls[0]?.ok).toBe(false)
  })

  test("el botón «Confirmar» del chat confirma aunque el texto no lo diga", async () => {
    await turno("Procesa co-industrias-delta", new ModeloDeGuion(procesarCaso("co-industrias-delta")))
    const confirmado = await turno("Adjunté lo pedido", new ModeloDeGuion([llamar("proveedor_simular_envio", { caso: "co-industrias-delta", confirmado: true }), decir("Enviado.")]), {}, true)
    expect(confirmado.toolCalls[0]?.ok).toBe(true)
  })
})

describe("topes y errores (CA1, CA5 y HU-5)", () => {
  test("al llegar al tope de iteraciones responde sin herramientas con lo que tiene", async () => {
    const modelo = new ModeloDeGuion([
      llamar("proveedor_leer_solicitud", { caso: "co-industrias-delta" }),
      llamar("proveedor_leer_solicitud", { caso: "co-industrias-delta" }),
      decir("Leí la solicitud dos veces; falta mapear los campos."),
    ])
    const resultado = await turno("Procesa co-industrias-delta", modelo, { maxIteraciones: 2 })
    expect(resultado.toolCalls).toHaveLength(2)
    expect(resultado.reply).toBe("Leí la solicitud dos veces; falta mapear los campos.")
    expect(modelo.opcionesRecibidas.at(-1)).toEqual({ sinHerramientas: true })
  })

  test("argumentos inválidos y herramientas desconocidas vuelven al modelo como error sin romper el turno", async () => {
    const modelo = new ModeloDeGuion([
      () => ({ texto: "", llamadas: [{ id: "x1", nombre: "proveedor_leer_solicitud", argumentos: "{no es json" }], uso: USO }),
      llamar("proveedor_borrar_todo", {}),
      decir("No pude leer el caso."),
    ])
    const resultado = await turno("Procesa algo", modelo)
    expect(resultado.toolCalls.map((llamada) => llamada.ok)).toEqual([false, false])
    expect(resultado.toolCalls[0]?.resumen).toContain("Argumentos inválidos")
    expect(resultado.toolCalls[1]?.resumen).toContain("no existe")
    expect(resultado.reply).toBe("No pude leer el caso.")
  })

  test("un error del proveedor se explica en el chat y la sesión sigue", async () => {
    const caido: AdaptadorLLM = {
      proveedor: "caido",
      modelo: "caido",
      enviar: async () => {
        throw new ErrorLLM("El modelo no respondió en 90 segundos.", "timeout")
      },
    }
    const fallido = await turno("Hola", caido)
    expect(fallido).toMatchObject({ error: true, reply: "No pude completar la respuesta: El modelo no respondió en 90 segundos." })
    expect(sesion.mensajes.at(-1)?.rol).toBe("assistant")
    const siguiente = await turno("¿Sigues ahí?", new ModeloDeGuion([decir("Sí, aquí estoy.")]))
    expect(siguiente.reply).toBe("Sí, aquí estoy.")
  })

  test("el tope de tokens de la sesión corta sin llamar al modelo", async () => {
    sesion.tokens = 500
    const modelo = new ModeloDeGuion([])
    const resultado = await turno("Procesa co-industrias-delta", modelo, { maxTokensSesion: 500 })
    expect(resultado.reply).toContain("tope de tokens")
    expect(modelo.opcionesRecibidas).toHaveLength(0)
  })
})

describe("esAfirmativo", () => {
  test.each([
    ["envía", true],
    ["Sí, envíalo", true],
    ["Confirmo.", true],
    ["dale", true],
    ["no envíes nada todavía", false],
    ["¿ya está listo para firma?", false],
    ["cancela", false],
    ["procesa el caso", false],
  ])("«%s» → %p", (mensaje, esperado) => {
    expect(esAfirmativo(mensaje)).toBe(esperado)
  })
})
