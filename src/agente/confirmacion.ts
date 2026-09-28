/**
 * Decide si un mensaje del usuario confirma la acción que el agente dejó pendiente (CA3 y RN4).
 * Es deliberadamente estricto: cualquier negación o una pregunta anulan la confirmación.
 */

const AFIRMACIONES = new Set([
  "si",
  "confirmo",
  "confirmado",
  "confirma",
  "envia",
  "envialo",
  "enviala",
  "adelante",
  "dale",
  "hazlo",
  "procede",
  "ok",
  "okay",
  "mandalo",
  "claro",
  "acuerdo",
])
const NEGACIONES = new Set(["no", "cancela", "cancelar", "cancelo", "espera", "todavia", "detente", "nunca", "tampoco"])

function palabras(texto: string): string[] {
  return texto
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
}

export function esAfirmativo(mensaje: string): boolean {
  if (mensaje.trim().endsWith("?")) return false
  const lista = palabras(mensaje)
  return !lista.some((palabra) => NEGACIONES.has(palabra)) && lista.some((palabra) => AFIRMACIONES.has(palabra))
}
