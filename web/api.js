// Llamadas al backend con la clave de acceso en la cabecera.

let claveAcceso = ""

export function fijarClave(clave) {
  claveAcceso = clave ?? ""
}

function cabeceras(extra = {}) {
  return { ...(claveAcceso ? { "x-clave-acceso": claveAcceso } : {}), ...extra }
}

/** Devuelve { ok, estado, datos } y nunca lanza: un fallo de red vuelve con estado 0. */
export async function pedir(ruta, { metodo = "GET", cuerpo } = {}) {
  try {
    const respuesta = await fetch(ruta, {
      method: metodo,
      headers: cabeceras(cuerpo ? { "Content-Type": "application/json" } : {}),
      body: cuerpo ? JSON.stringify(cuerpo) : undefined,
    })
    const datos = await respuesta.json().catch(() => ({}))
    return { ok: respuesta.ok, estado: respuesta.status, datos }
  } catch {
    return { ok: false, estado: 0, datos: { error: "No hay conexión con el servidor." } }
  }
}

/** Trae un archivo de out/ como Blob (los enlaces normales no pueden llevar la cabecera de la clave). */
export async function traerArchivo(ruta) {
  const respuesta = await fetch(`/api/archivo?ruta=${encodeURIComponent(ruta)}`, { headers: cabeceras() })
  if (!respuesta.ok) throw new Error(`No se pudo abrir ${ruta} (${respuesta.status}).`)
  return respuesta.blob()
}

export async function descargar(ruta) {
  const blob = await traerArchivo(ruta)
  const url = URL.createObjectURL(blob)
  const enlace = Object.assign(document.createElement("a"), { href: url, download: ruta.split("/").pop() })
  document.body.append(enlace)
  enlace.click()
  enlace.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}
