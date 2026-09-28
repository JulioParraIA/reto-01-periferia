// Front del chat: historial, llamadas a herramientas visibles y confirmaciones resaltadas.
const $ = (selector) => document.querySelector(selector)
const conversacion = $("#conversacion")
const formulario = $("#formulario")
const campoMensaje = $("#mensaje")
const botonEnviar = $("#enviar")

const almacen = {
  leer(clave, porDefecto = null) {
    try {
      return window.sessionStorage.getItem(clave) ?? window.localStorage.getItem(clave) ?? porDefecto
    } catch {
      return porDefecto
    }
  },
  guardar(clave, valor, duradero = false) {
    try {
      ;(duradero ? window.localStorage : window.sessionStorage).setItem(clave, valor)
    } catch {
      // Sin almacenamiento el chat funciona igual; solo no recuerda la sesión.
    }
  },
}

let sesionId = almacen.leer("sesion") ?? nuevaSesionId()
let claveAcceso = almacen.leer("claveAcceso") ?? ""
let ocupado = false

function nuevaSesionId() {
  const id = crypto.randomUUID()
  almacen.guardar("sesion", id)
  return id
}

// ─── Markdown mínimo y seguro: primero se escapa todo el HTML ────────────────

function escapar(texto) {
  return texto.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c])
}

function enLinea(texto) {
  return escapar(texto)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
}

function tabla(lineas) {
  const celdas = (linea) => linea.trim().replace(/^\||\|$/g, "").split("|").map((celda) => enLinea(celda.trim()))
  const [cabecera, , ...filas] = lineas
  const th = celdas(cabecera).map((c) => `<th>${c}</th>`).join("")
  const tr = filas.map((fila) => `<tr>${celdas(fila).map((c) => `<td>${c}</td>`).join("")}</tr>`).join("")
  return `<div class="tabla"><table><thead><tr>${th}</tr></thead><tbody>${tr}</tbody></table></div>`
}

function markdown(texto) {
  const lineas = texto.replace(/\r/g, "").split("\n")
  const html = []
  let lista = null
  const cerrarLista = () => {
    if (lista) html.push(`</${lista}>`)
    lista = null
  }
  for (let i = 0; i < lineas.length; i++) {
    const linea = lineas[i]
    if (linea.trim().startsWith("|") && /^\s*\|?\s*:?-{2,}/.test(lineas[i + 1] ?? "")) {
      cerrarLista()
      const bloque = []
      while (i < lineas.length && lineas[i].trim().startsWith("|")) bloque.push(lineas[i++])
      i--
      html.push(tabla(bloque))
      continue
    }
    const titulo = linea.match(/^(#{1,4})\s+(.*)$/)
    const vineta = linea.match(/^\s*[-*]\s+(.*)$/)
    const numero = linea.match(/^\s*\d+[.)]\s+(.*)$/)
    if (titulo) {
      cerrarLista()
      html.push(`<h3>${enLinea(titulo[2])}</h3>`)
    } else if (vineta || numero) {
      const tipo = vineta ? "ul" : "ol"
      if (lista !== tipo) {
        cerrarLista()
        html.push(`<${tipo}>`)
        lista = tipo
      }
      html.push(`<li>${enLinea((vineta ?? numero)[1])}</li>`)
    } else if (linea.trim() === "") {
      cerrarLista()
    } else {
      cerrarLista()
      html.push(`<p>${enLinea(linea)}</p>`)
    }
  }
  cerrarLista()
  return html.join("")
}

// ─── Pintar mensajes ─────────────────────────────────────────────────────────

function agregar(elemento) {
  $("#bienvenida")?.remove()
  conversacion.append(elemento)
  elemento.scrollIntoView({ behavior: "smooth", block: "end" })
  return elemento
}

function nodo(etiqueta, clase, html = "") {
  const elemento = document.createElement(etiqueta)
  if (clase) elemento.className = clase
  elemento.innerHTML = html
  return elemento
}

function pintarUsuario(texto) {
  agregar(nodo("div", "mensaje usuario", `<p>${escapar(texto).replace(/\n/g, "<br>")}</p>`))
}

function pintarLlamadas(llamadas) {
  if (!llamadas?.length) return null
  const contenedor = nodo("div", "llamadas")
  for (const llamada of llamadas) {
    const detalle = nodo("details", `llamada ${llamada.ok ? "bien" : "mal"}`)
    detalle.innerHTML = `<summary><span class="icono">${llamada.ok ? "✓" : "✗"}</span><code>${escapar(llamada.herramienta)}</code><span class="resumen">${escapar(llamada.resumen)}</span></summary><pre>${escapar(JSON.stringify(llamada.argumentos, null, 2))}</pre>`
    contenedor.append(detalle)
  }
  return contenedor
}

function pintarAgente(respuesta) {
  const burbuja = nodo("div", `mensaje agente${respuesta.needsConfirmation ? " confirmacion" : ""}${respuesta.error ? " error" : ""}`)
  const llamadas = pintarLlamadas(respuesta.toolCalls)
  if (llamadas) burbuja.append(llamadas)
  if (respuesta.needsConfirmation) burbuja.append(nodo("p", "etiqueta", "Esperando tu confirmación"))
  burbuja.append(nodo("div", "texto", markdown(respuesta.reply)))
  if (respuesta.needsConfirmation) burbuja.append(botonesConfirmacion())
  agregar(burbuja)
}

function botonesConfirmacion() {
  const fila = nodo("div", "acciones")
  const confirmar = nodo("button", "", "Confirmar")
  const cancelar = nodo("button", "secundario", "Cancelar")
  confirmar.type = cancelar.type = "button"
  const usar = (texto, confirmado) => {
    confirmar.disabled = cancelar.disabled = true
    enviar(texto, confirmado)
  }
  confirmar.addEventListener("click", () => usar("Confirmo.", true))
  cancelar.addEventListener("click", () => usar("Cancela, no lo hagas.", false))
  fila.append(confirmar, cancelar)
  return fila
}

function pintarAviso(texto) {
  agregar(nodo("div", "mensaje agente error", `<p>${escapar(texto)}</p>`))
}

function mostrarPensando() {
  const indicador = agregar(nodo("div", "pensando", "<span></span><span></span><span></span> <em>Pensando… 0 s</em>"))
  const inicio = Date.now()
  const reloj = setInterval(() => {
    indicador.querySelector("em").textContent = `Pensando… ${Math.round((Date.now() - inicio) / 1000)} s`
  }, 1000)
  return () => {
    clearInterval(reloj)
    indicador.remove()
  }
}

// ─── API ─────────────────────────────────────────────────────────────────────

function cabeceras() {
  return { "Content-Type": "application/json", ...(claveAcceso ? { "x-clave-acceso": claveAcceso } : {}) }
}

async function enviar(texto, confirmar = false) {
  if (ocupado || !texto.trim()) return
  ocupado = true
  botonEnviar.disabled = true
  pintarUsuario(texto)
  const ocultar = mostrarPensando()
  try {
    const respuesta = await fetch("/api/chat", {
      method: "POST",
      headers: cabeceras(),
      body: JSON.stringify({ sessionId: sesionId, message: texto, confirmar }),
    })
    const datos = await respuesta.json().catch(() => ({}))
    if (respuesta.status === 401) pedirClave()
    if (!respuesta.ok) pintarAviso(datos.error ?? `El servidor respondió ${respuesta.status}.`)
    else pintarAgente(datos)
  } catch {
    pintarAviso("No hay conexión con el servidor. Revisa la red y vuelve a intentar.")
  } finally {
    ocultar()
    ocupado = false
    botonEnviar.disabled = false
    campoMensaje.focus()
  }
}

async function restaurar() {
  const respuesta = await fetch(`/api/sessions/${sesionId}`, { headers: cabeceras() }).catch(() => null)
  if (!respuesta?.ok) return
  const { historial } = await respuesta.json()
  for (const entrada of historial) {
    if (entrada.rol === "usuario") pintarUsuario(entrada.texto)
    else pintarAgente({ reply: entrada.texto, toolCalls: entrada.toolCalls, needsConfirmation: false, error: entrada.error })
  }
}

function pedirClave() {
  $("#acceso").hidden = false
  $("#clave").focus()
}

async function iniciar() {
  const salud = await fetch("/api/health").then((r) => r.json()).catch(() => null)
  $("#modelo").textContent = salud ? `${salud.provider} · ${salud.model}` : "sin conexión con el servidor"
  if (salud?.acceso === "con_clave" && !claveAcceso) pedirClave()
  else await restaurar()
}

// ─── Eventos ─────────────────────────────────────────────────────────────────

formulario.addEventListener("submit", (evento) => {
  evento.preventDefault()
  const texto = campoMensaje.value
  campoMensaje.value = ""
  enviar(texto)
})

campoMensaje.addEventListener("keydown", (evento) => {
  if (evento.key === "Enter" && !evento.shiftKey) {
    evento.preventDefault()
    formulario.requestSubmit()
  }
})

$("#acceso").addEventListener("submit", async (evento) => {
  evento.preventDefault()
  claveAcceso = $("#clave").value
  almacen.guardar("claveAcceso", claveAcceso, true)
  $("#acceso").hidden = true
  await restaurar()
})

$("#nueva").addEventListener("click", () => {
  sesionId = nuevaSesionId()
  window.location.reload()
})

for (const boton of document.querySelectorAll(".sugerencia")) {
  boton.addEventListener("click", () => enviar(boton.dataset.texto))
}

iniciar()
