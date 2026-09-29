// Nombres legibles y formatos de número en español de Colombia.

export const PAISES = { CO: "Colombia", EC: "Ecuador", PE: "Perú", PA: "Panamá", HN: "Honduras" }
export const FORMATOS = { xlsx: "Excel", pdf: "PDF", portal: "Portal web" }
/** RN1: cómo se llama el identificador tributario en cada país. */
export const IDENTIFICADORES = { CO: "NIT", EC: "RUC", PE: "RUC", PA: "RUC", HN: "RTN" }

const SOPORTES = {
  camara_comercio: "Cámara de Comercio",
  rut: "RUT",
  certificacion_bancaria: "Certificación bancaria",
  estados_financieros: "Estados financieros",
  parafiscales: "Parafiscales",
  certificado_cumplimiento_tributario: "Certificado de cumplimiento tributario",
  certificado_iso_9001: "Certificado ISO 9001",
}

/** Las cuatro funcionalidades del reto y los dos pasos humanos, en orden. */
export const PASOS = [
  { id: "solicitud", numero: 1, titulo: "Lectura de la solicitud", herramienta: "proveedor_leer_solicitud" },
  { id: "cruce", numero: 2, titulo: "Cruce con el repositorio maestro", herramienta: "proveedor_mapear_campos" },
  { id: "formulario", numero: 3, titulo: "Llenado del formulario", herramienta: "proveedor_generar_formulario" },
  { id: "paquete", numero: 4, titulo: "Paquete para firma", herramienta: "proveedor_armar_paquete" },
  { id: "firma", numero: 5, titulo: "Firma del representante legal", herramienta: null },
  { id: "envio", numero: 6, titulo: "Envío al cliente", herramienta: "proveedor_simular_envio" },
]

export const NOMBRES_HERRAMIENTAS = {
  proveedor_leer_solicitud: "Leer la solicitud",
  proveedor_mapear_campos: "Cruzar con el repositorio maestro",
  proveedor_generar_formulario: "Llenar el formulario",
  proveedor_armar_paquete: "Armar el paquete para firma",
  proveedor_simular_envio: "Envío simulado",
}

export function nombreSoporte(tipo) {
  if (SOPORTES[tipo]) return SOPORTES[tipo]
  const legible = String(tipo).replace(/_/g, " ")
  return legible.charAt(0).toUpperCase() + legible.slice(1)
}

const ENTERO = new Intl.NumberFormat("es-CO")
const DOLARES = new Intl.NumberFormat("es-CO", { minimumFractionDigits: 4, maximumFractionDigits: 4 })

export function tokens(n) {
  return ENTERO.format(n ?? 0)
}

export function dolares(n) {
  return n === null || n === undefined ? "—" : `USD ${DOLARES.format(n)}`
}

export function segundos(ms) {
  return `${(ms / 1000).toLocaleString("es-CO", { maximumFractionDigits: 1 })} s`
}

export function hora(iso) {
  return new Date(iso).toLocaleTimeString("es-CO", { hour: "2-digit", minute: "2-digit" })
}

export function bytes(n) {
  return n < 1024 ? `${n} B` : `${(n / 1024).toLocaleString("es-CO", { maximumFractionDigits: 1 })} KB`
}
