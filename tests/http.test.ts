/** Pruebas de las rutas HTTP sin levantar un servidor: el manejador se llama con Request directamente. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { cp } from "node:fs/promises"
import path from "node:path"
import { HERRAMIENTAS } from "../src/agente/herramientas.ts"
import { Sesiones } from "../src/agente/sesiones.ts"
import { crearManejador } from "../src/http/app.ts"
import type { AdaptadorLLM, RespuestaModelo } from "../src/llm/adapter.ts"
import { z } from "zod"
import { RAIZ, borrar, proyectoTemporal } from "./apoyo.ts"

const CLAVE = "clave-de-prueba"
let directorio = ""
let manejar: (peticion: Request) => Promise<Response>

const respuestaFija: RespuestaModelo = {
  texto: "Hola, soy el agente.",
  llamadas: [],
  uso: { entrada: 1200, entradaEnCache: 800, entradaEscritaEnCache: 0, salida: 60, salidaRazonamiento: 10, costoEntrada: 0.001, costoSalida: 0.0006, costo: 0.0016 },
  modeloUsado: "modelo/de-prueba",
  proveedorUsado: "Proveedor de prueba",
}
const modelo: AdaptadorLLM = { proveedor: "prueba", modelo: "modelo/de-prueba", enviar: async () => respuestaFija }

function pedir(ruta: string, opciones: { metodo?: string; cuerpo?: unknown; clave?: string | null } = {}): Promise<Response> {
  const clave = opciones.clave === undefined ? CLAVE : opciones.clave
  return manejar(
    new Request(`http://prueba${ruta}`, {
      method: opciones.metodo ?? "GET",
      headers: { "Content-Type": "application/json", ...(clave ? { "x-clave-acceso": clave } : {}) },
      body: opciones.cuerpo === undefined ? undefined : JSON.stringify(opciones.cuerpo),
    }),
  )
}

beforeAll(async () => {
  directorio = await proyectoTemporal()
  await cp(path.join(RAIZ, "web"), path.join(directorio, "web"), { recursive: true })
  manejar = crearManejador({
    raiz: directorio,
    claveAcceso: CLAVE,
    promptSistema: "prompt de prueba",
    sesiones: new Sesiones(),
    ciclo: { llm: modelo, herramientas: HERRAMIENTAS, directorio, maxIteraciones: 5, maxTokensSesion: 100_000 },
  })
})
afterAll(() => borrar(directorio))

describe("rutas HTTP", () => {
  test("/api/health responde sin clave y sin exponer secretos", async () => {
    const respuesta = await pedir("/api/health", { clave: null })
    expect(await respuesta.json()).toEqual({ ok: true, provider: "prueba", model: "modelo/de-prueba", acceso: "con_clave" })
  })

  test("el resto de la API exige la clave de acceso", async () => {
    expect((await pedir("/api/casos", { clave: null })).status).toBe(401)
    expect((await pedir("/api/casos", { clave: "otra" })).status).toBe(401)
    const { casos } = z.object({ casos: z.array(z.object({ caso: z.string() })) }).parse(await (await pedir("/api/casos")).json())
    expect(casos.map((caso) => caso.caso)).toEqual(["co-industrias-delta", "ec-corp-andina", "hn-agroexport-sula", "pa-logistica-istmo"])
  })

  test("los archivos solo se sirven desde out/", async () => {
    for (const ruta of ["../.env", "out/../.env", "fixtures/reto-01/repositorio/maestro.json", "out/../../x"]) {
      expect((await pedir(`/api/archivo?ruta=${encodeURIComponent(ruta)}`)).status).toBe(400)
    }
    expect((await pedir("/api/archivo?ruta=out/no-existe.txt")).status).toBe(404)
  })

  test("/api/chat devuelve la respuesta y el consumo del turno, de entrada y de salida", async () => {
    const respuesta = await pedir("/api/chat", { metodo: "POST", cuerpo: { sessionId: "sesion-http-1", message: "Hola" } })
    expect(await respuesta.json()).toMatchObject({
      reply: "Hola, soy el agente.",
      toolCalls: [],
      needsConfirmation: false,
      consumo: {
        modelo: "modelo/de-prueba",
        proveedor: "Proveedor de prueba",
        llamadas: 1,
        entrada: { tokens: 1200, enCache: 800, usd: 0.001 },
        salida: { tokens: 60, razonamiento: 10, usd: 0.0006 },
        totalUsd: 0.0016,
      },
    })
  })

  test("firmar antes de armar el paquete responde 409 con el motivo", async () => {
    const respuesta = await pedir("/api/casos/co-industrias-delta/firma", { metodo: "POST", cuerpo: { metodo: "clic" } })
    expect(respuesta.status).toBe(409)
    expect(await respuesta.json()).toEqual({ error: "Primero hay que armar el paquete." })
  })

  test("sirve el front y rechaza archivos fuera de web/", async () => {
    expect((await pedir("/", { clave: null })).status).toBe(200)
    expect((await pedir("/expediente.js", { clave: null })).status).toBe(200)
    expect((await pedir("/../.env", { clave: null })).status).toBe(404)
  })
})
