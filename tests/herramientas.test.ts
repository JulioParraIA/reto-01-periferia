import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { Workbook } from "exceljs"
import { z } from "zod"
import * as proveedor from "../src/tools/proveedor.ts"
import { FormularioSchema, LecturaSchema, MapeoSchema, PaqueteSchema, borrar, datos, error, proyectoTemporal } from "./apoyo.ts"

let directorio = ""
const ctx = () => ({ directory: directorio, sessionId: "prueba" })

beforeAll(async () => {
  directorio = await proyectoTemporal()
})
afterAll(() => borrar(directorio))

async function leer(caso: string) {
  return datos(await proveedor.leer_solicitud.execute({ caso }, ctx()), LecturaSchema)
}

async function mapear(caso: string, campos?: string[]) {
  const etiquetas = campos ?? (await leer(caso)).campos
  return datos(await proveedor.mapear_campos.execute({ caso, campos: etiquetas }, ctx()), MapeoSchema)
}

/** Recorre el flujo completo de un caso hasta el paquete. */
async function procesar(caso: string, fecha = "2026-09-03") {
  const { mapeo } = await mapear(caso)
  datos(await proveedor.generar_formulario.execute({ caso, mapeo }, ctx()), FormularioSchema)
  return datos(await proveedor.armar_paquete.execute({ caso, fecha_referencia: fecha }, ctx()), PaqueteSchema)
}

function celda(libro: Workbook, hoja: string, direccion: string): unknown {
  return libro.getWorksheet(hoja)?.getCell(direccion).value
}

describe("proveedor_leer_solicitud (HU-1)", () => {
  test.each([
    ["co-industrias-delta", "CO", "xlsx", 17],
    ["ec-corp-andina", "EC", "pdf", 15],
    ["hn-agroexport-sula", "HN", "xlsx", 11],
    ["pa-logistica-istmo", "PA", "portal", 9],
  ])("%s: país %s, formato %s, %i campos", async (caso, pais, formato, total) => {
    const lectura = await leer(caso)
    expect(lectura.pais).toBe(pais)
    expect(lectura.formato).toBe(formato)
    expect(lectura.campos).toHaveLength(total)
  })

  test("un caso inexistente devuelve un error claro con los casos disponibles", async () => {
    const mensaje = error(await proveedor.leer_solicitud.execute({ caso: "no-existe" }, ctx()))
    expect(mensaje).toContain("no existe")
    expect(mensaje).toContain("co-industrias-delta")
  })

  test("un nombre con rutas no sale de la carpeta de casos", async () => {
    expect(error(await proveedor.leer_solicitud.execute({ caso: "../repositorio" }, ctx()))).toContain("no es un nombre de caso válido")
  })
})

describe("proveedor_mapear_campos (HU-2 y RN1)", () => {
  test("co-industrias-delta llena los 17 campos con su ruta en el maestro", async () => {
    const mapeo = await mapear("co-industrias-delta")
    expect(mapeo.llenos).toHaveLength(17)
    expect(mapeo.llenos.find((campo) => campo.etiqueta === "NIT")?.clave).toBe("nit")
    expect(mapeo.faltantes).toHaveLength(0)
  })

  test("ec-corp-andina: el RUC se llena con el NIT y se marca como identificador extranjero", async () => {
    const mapeo = await mapear("ec-corp-andina")
    expect(mapeo.requiere_confirmacion).toEqual([expect.objectContaining({ etiqueta: "RUC", clave: "nit" })])
    expect(mapeo.requiere_confirmacion[0]?.nota).toContain("identificador extranjero")
    expect(mapeo.faltantes.map((campo) => campo.etiqueta)).toEqual(["Número de contribuyente especial"])
  })

  test("hn-agroexport-sula: RTN por confirmar y referencias comerciales faltantes", async () => {
    const mapeo = await mapear("hn-agroexport-sula")
    expect(mapeo.requiere_confirmacion.map((campo) => campo.etiqueta)).toEqual(["RTN"])
    expect(mapeo.faltantes.map((campo) => campo.etiqueta)).toEqual(["Referencias comerciales"])
  })

  test("sin tildes es la misma etiqueta; una aproximada o ambigua pide confirmación", async () => {
    const mapeo = await mapear("co-industrias-delta", ["Correo electronico", "Razon social del proveedor", "Identificación tributaria"])
    expect(mapeo.llenos.map((campo) => campo.etiqueta)).toEqual(["Correo electronico"])
    const notas = Object.fromEntries(mapeo.requiere_confirmacion.map((campo) => [campo.etiqueta, campo.nota ?? ""]))
    expect(notas["Razon social del proveedor"]).toContain("mapeo aproximado")
    expect(notas["Identificación tributaria"]).toContain("campo ambiguo")
  })
})

describe("proveedor_generar_formulario (HU-3)", () => {
  test("xlsx: cada etiqueta y valor van en la hoja y celda de la plantilla", async () => {
    const { mapeo } = await mapear("co-industrias-delta")
    const formulario = datos(await proveedor.generar_formulario.execute({ caso: "co-industrias-delta", mapeo }, ctx()), FormularioSchema)
    expect(formulario.ruta).toBe("out/co-industrias-delta/formulario.xlsx")
    const libro = new Workbook()
    await libro.xlsx.readFile(path.join(directorio, formulario.ruta))
    expect(celda(libro, "Datos Proveedor", "B3")).toBe("Razón social")
    expect(celda(libro, "Datos Proveedor", "C3")).toBe("Periferia IT Group S.A.S.")
    expect(celda(libro, "Datos Proveedor", "C8")).toBe("050021")
    expect(celda(libro, "Datos Bancarios", "C5")).toBe("03100012345")
  })

  test("el mapeo no puede inyectar valores ni poner datos bancarios fuera de los campos bancarios", async () => {
    const mapeo = [
      { etiqueta: "Razón social", clave: "razon_social", valor: "EMPRESA FALSA" },
      { etiqueta: "Ciudad", clave: "banco.numero_cuenta" },
    ]
    const salida = await proveedor.generar_formulario.execute({ caso: "co-industrias-delta", mapeo }, ctx())
    const libro = new Workbook()
    await libro.xlsx.readFile(path.join(directorio, datos(salida, FormularioSchema).ruta))
    expect(celda(libro, "Datos Proveedor", "C3")).toBe("Periferia IT Group S.A.S.")
    expect(celda(libro, "Datos Proveedor", "C7")).toBeNull()
  })

  test("pdf: genera un PDF para ec-corp-andina", async () => {
    const { mapeo } = await mapear("ec-corp-andina")
    const formulario = datos(await proveedor.generar_formulario.execute({ caso: "ec-corp-andina", mapeo }, ctx()), FormularioSchema)
    const contenido = await readFile(path.join(directorio, formulario.ruta))
    expect(contenido.subarray(0, 5).toString()).toBe("%PDF-")
  })

  test("portal: formato no soportado y valores listos para copiar", async () => {
    const { mapeo } = await mapear("pa-logistica-istmo")
    const formulario = datos(await proveedor.generar_formulario.execute({ caso: "pa-logistica-istmo", mapeo }, ctx()), FormularioSchema)
    expect(formulario).toMatchObject({ ruta: "out/pa-logistica-istmo/valores-portal.md", soportado: false })
    const texto = await readFile(path.join(directorio, formulario.ruta), "utf8")
    expect(texto).toContain("Formato no soportado")
    expect(texto).toContain("https://vendorhub.logisticaistmo-ficticia.pa")
  })
})

describe("proveedor_armar_paquete (HU-4, RN2 y RN3)", () => {
  test("con la fecha de los PRD: co listo, ec con soporte ausente, hn con soporte vencido", async () => {
    expect((await procesar("co-industrias-delta")).listo_para_firma).toBe(true)
    const ec = await procesar("ec-corp-andina")
    expect(ec.listo_para_firma).toBe(false)
    expect(ec.checklist.soportes.find((soporte) => soporte.tipo === "certificado_cumplimiento_tributario")?.estado).toBe("ausente")
    const hn = await procesar("hn-agroexport-sula")
    expect(hn.listo_para_firma).toBe(false)
    expect(hn.checklist.soportes.find((soporte) => soporte.tipo === "parafiscales")?.estado).toBe("vencido")
  })

  test("la Cámara de Comercio vence el 30 de septiembre y desde el 1 de octubre bloquea", async () => {
    expect((await procesar("co-industrias-delta", "2026-09-30")).listo_para_firma).toBe(true)
    const despues = await procesar("co-industrias-delta", "2026-10-01")
    expect(despues.listo_para_firma).toBe(false)
    expect(despues.checklist.soportes.find((soporte) => soporte.tipo === "camara_comercio")?.estado).toBe("vencido")
  })

  test("el paquete trae formulario, soportes, checklist y un borrador sin datos bancarios", async () => {
    const paquete = await procesar("co-industrias-delta")
    const carpeta = path.join(directorio, paquete.ruta)
    for (const archivo of ["formulario.xlsx", "rut-2026.txt", "checklist.md", "borrador-correo.md"]) {
      expect(await Bun.file(path.join(carpeta, archivo)).exists()).toBe(true)
    }
    const borrador = await readFile(path.join(carpeta, "borrador-correo.md"), "utf8")
    for (const dato of ["03100012345", "COLOCOBM", "Bancolombia", "Ahorros"]) expect(borrador).not.toContain(dato)
  })

  test("sin formulario generado el paquete no queda listo", async () => {
    const otro = await proyectoTemporal()
    try {
      const salida = await proveedor.armar_paquete.execute({ caso: "co-industrias-delta", fecha_referencia: "2026-09-03" }, { directory: otro })
      expect(datos(salida, PaqueteSchema).checklist.bloqueos).toContain("el formulario no se ha generado")
    } finally {
      await borrar(otro)
    }
  })
})

describe("proveedor_simular_envio (RN4)", () => {
  test("sin confirmación responde exactamente «requiere confirmación explícita»", async () => {
    expect(error(await proveedor.simular_envio.execute({ caso: "co-industrias-delta", confirmado: false }, ctx()))).toBe("requiere confirmación explícita")
  })

  test("con confirmación escribe solo ENVIO-SIMULADO.md", async () => {
    await procesar("co-industrias-delta")
    const envio = datos(await proveedor.simular_envio.execute({ caso: "co-industrias-delta", confirmado: true }, ctx()), z.object({ ruta: z.string() }))
    expect(envio.ruta).toBe("out/co-industrias-delta/ENVIO-SIMULADO.md")
    expect(await readFile(path.join(directorio, envio.ruta), "utf8")).toContain("No se envió ningún correo")
  })
})

describe("manejo de errores (HU-5 y RN5)", () => {
  test("una plantilla dañada da un mensaje claro y no lanza", async () => {
    const otro = await proyectoTemporal()
    try {
      await writeFile(path.join(otro, "fixtures", "reto-01", "casos", "hn-agroexport-sula", "plantilla-celdas.json"), "{ esto no es json")
      const mensaje = error(await proveedor.leer_solicitud.execute({ caso: "hn-agroexport-sula" }, { directory: otro }))
      expect(mensaje).toBe("No se pudo leer la plantilla de celdas del caso hn-agroexport-sula: no es un JSON válido.")
    } finally {
      await borrar(otro)
    }
  })

  test("cada ejecución deja { ts, herramienta, ok, resumen } en out/<caso>/log.jsonl", async () => {
    await leer("pa-logistica-istmo")
    const lineas = (await readFile(path.join(directorio, "out", "pa-logistica-istmo", "log.jsonl"), "utf8")).trim().split("\n")
    expect(JSON.parse(lineas.at(-1) ?? "{}")).toMatchObject({ herramienta: "proveedor_leer_solicitud", ok: true, resumen: expect.any(String), ts: expect.any(String) })
  })
})
