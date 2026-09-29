import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { Workbook } from "exceljs"
import { PDFDocument } from "pdf-lib"
import { consultarFirma, firmar } from "../src/firma/firmar.ts"
import * as proveedor from "../src/tools/proveedor.ts"
import { LecturaSchema, MapeoSchema, borrar, datos, proyectoTemporal } from "./apoyo.ts"

/** PNG de 1×1 píxel: basta para probar que la firma dibujada se incrusta. */
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="

let directorio = ""
const ctx = () => ({ directory: directorio, sessionId: "prueba-firma" })

async function armar(caso: string) {
  const { campos } = datos(await proveedor.leer_solicitud.execute({ caso }, ctx()), LecturaSchema)
  const { mapeo } = datos(await proveedor.mapear_campos.execute({ caso, campos }, ctx()), MapeoSchema)
  await proveedor.generar_formulario.execute({ caso, mapeo }, ctx())
  await proveedor.armar_paquete.execute({ caso, fecha_referencia: "2026-09-03" }, ctx())
}

function rutaPaquete(caso: string, archivo: string): string {
  return path.join(directorio, "out", caso, "paquete", archivo)
}

beforeAll(async () => {
  directorio = await proyectoTemporal()
  // Para probar la firma de un PDF, ec-corp-andina necesita el soporte que le falta.
  const soportes = path.join(directorio, "fixtures", "reto-01", "repositorio", "soportes")
  const indice = JSON.parse(await readFile(path.join(soportes, "index.json"), "utf8"))
  indice.push({ tipo: "certificado_cumplimiento_tributario", archivo: "cumplimiento.txt", vigencia_hasta: "2026-12-31", pais_emisor: "CO", descripcion: "Certificado de cumplimiento tributario" })
  await writeFile(path.join(soportes, "index.json"), JSON.stringify(indice))
  await writeFile(path.join(soportes, "cumplimiento.txt"), "placeholder")
})
afterAll(() => borrar(directorio))

describe("firma del representante legal", () => {
  test("antes de armar el paquete no se puede firmar", async () => {
    const resultado = await firmar(directorio, "co-industrias-delta", "clic", undefined, null)
    expect(resultado).toEqual({ ok: false, error: "Primero hay que armar el paquete." })
  })

  test("Excel con firma dibujada: agrega la hoja Firma y el firmado reemplaza al original en el envío", async () => {
    await armar("co-industrias-delta")
    const resultado = await firmar(directorio, "co-industrias-delta", "dibujada", PNG, "sesion-1")
    if (!resultado.ok) throw new Error(resultado.error)
    expect(resultado.data).toMatchObject({ firmante: "Roberto Andrade Salazar", cargo: "Gerente General", metodo: "dibujada", archivo: "formulario-firmado.xlsx" })
    expect(resultado.data.codigo).toMatch(/^[0-9A-F]{4}(-[0-9A-F]{4}){3}$/)
    const libro = new Workbook()
    await libro.xlsx.readFile(rutaPaquete("co-industrias-delta", "formulario-firmado.xlsx"))
    expect(libro.worksheets.map((hoja) => hoja.name)).toEqual(["Datos Proveedor", "Datos Bancarios", "Firma"])
    const estado = JSON.parse(await readFile(path.join(directorio, "out", "co-industrias-delta", "estado-paquete.json"), "utf8"))
    expect(estado.adjuntos).toContain("formulario-firmado.xlsx")
    expect(estado.adjuntos).not.toContain("formulario.xlsx")
    await proveedor.simular_envio.execute({ caso: "co-industrias-delta", confirmado: true }, ctx())
    expect(await readFile(path.join(directorio, "out", "co-industrias-delta", "ENVIO-SIMULADO.md"), "utf8")).toContain("firma dibujada")
  })

  test("PDF con firma de un clic: agrega una página de firma", async () => {
    await armar("ec-corp-andina")
    const original = await PDFDocument.load(await readFile(rutaPaquete("ec-corp-andina", "formulario.pdf")))
    const resultado = await firmar(directorio, "ec-corp-andina", "clic", undefined, null)
    if (!resultado.ok) throw new Error(resultado.error)
    const firmado = await PDFDocument.load(await readFile(rutaPaquete("ec-corp-andina", "formulario-firmado.pdf")))
    expect(firmado.getPageCount()).toBe(original.getPageCount() + 1)
  })

  test("volver a armar el paquete borra la firma", async () => {
    await armar("co-industrias-delta")
    expect((await consultarFirma(directorio, "co-industrias-delta")).firma).toBeNull()
  })

  test("no se firma un paquete no listo, un portal ni una imagen que no sea PNG", async () => {
    await armar("hn-agroexport-sula")
    const noListo = await firmar(directorio, "hn-agroexport-sula", "clic", undefined, null)
    expect(noListo.ok || noListo.error).toContain("no está listo para firma")
    await armar("pa-logistica-istmo")
    const portal = await firmar(directorio, "pa-logistica-istmo", "clic", undefined, null)
    expect(portal.ok || portal.error).toContain("portal")
    const imagen = await firmar(directorio, "co-industrias-delta", "dibujada", "data:image/png;base64,AAAA", null)
    expect(imagen.ok || imagen.error).toBe("La firma dibujada no es un PNG válido.")
  })
})
