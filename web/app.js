// Arranque del front: sesión, clave de acceso, casos, chat, expediente y consola de consumo.
import { fijarClave, pedir } from "./api.js"
import { limpiarChat, mostrarPensando, pintarAgente, pintarAviso, pintarBienvenida, pintarEvento, pintarUsuario } from "./chat.js"
import { fijarModelo, registrarConsumo, reiniciarConsola } from "./consola.js"
import { actualizarOcupado, aplicarLlamadas, fijarCasos, iniciarExpediente, refrescarActivo, reiniciarExpediente } from "./expediente.js"

const $ = (selector) => document.querySelector(selector)
const campoMensaje = $("#mensaje")
const botonEnviar = $("#enviar")

const almacen = {
  leer(clave) {
    try {
      return window.sessionStorage.getItem(clave) ?? window.localStorage.getItem(clave)
    } catch {
      return null
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
let ocupado = false
let casos = []
fijarClave(almacen.leer("claveAcceso") ?? "")

function nuevaSesionId() {
  const id = crypto.randomUUID()
  almacen.guardar("sesion", id)
  return id
}

function fijarOcupado(valor) {
  ocupado = valor
  botonEnviar.disabled = valor
  actualizarOcupado()
}

function cambiarVista(vista) {
  document.body.dataset.vista = vista
  for (const boton of document.querySelectorAll(".pestanas button")) {
    boton.setAttribute("aria-pressed", String(boton.dataset.vista === vista))
    if (boton.dataset.vista === vista) boton.classList.remove("novedad")
  }
}

function avisarNovedad(vista) {
  if (document.body.dataset.vista === vista) return
  document.querySelector(`.pestanas button[data-vista="${vista}"]`)?.classList.add("novedad")
}

async function enviar(texto, confirmar = false) {
  if (ocupado || !texto.trim()) return
  fijarOcupado(true)
  pintarUsuario(texto)
  const ocultar = mostrarPensando()
  const { ok, estado, datos } = await pedir("/api/chat", { metodo: "POST", cuerpo: { sessionId: sesionId, message: texto, confirmar } })
  ocultar()
  if (estado === 401) pedirClave()
  if (!ok) pintarAviso(datos.error ?? `El servidor respondió ${estado}.`)
  else {
    pintarAgente(datos, {
      alConfirmar: () => enviar("Confirmo el envío.", true),
      alCancelar: () => enviar("Cancela el envío; no lo envíes todavía."),
    })
    aplicarLlamadas(datos.toolCalls)
    registrarConsumo(datos.consumo)
    if (datos.toolCalls?.length) avisarNovedad("expediente")
    avisarNovedad("consumo")
  }
  fijarOcupado(false)
  campoMensaje.focus()
}

function procesarCaso(caso) {
  enviar(`Procesa el caso "${caso}". Dime qué campos quedaron llenos, cuáles faltan, si el paquete está listo para firma y qué soportes debo actualizar. No envíes nada todavía.`)
}

async function restaurar() {
  const { ok, datos } = await pedir(`/api/sessions/${sesionId}`)
  if (!ok) return
  for (const entrada of datos.historial) {
    if (entrada.rol === "usuario") pintarUsuario(entrada.texto)
    else if (entrada.rol === "evento") pintarEvento(entrada.texto, entrada.ts)
    else {
      pintarAgente({ reply: entrada.texto, toolCalls: entrada.toolCalls, needsConfirmation: entrada.needsConfirmation, consumo: entrada.consumo, error: entrada.error }, { conBotones: false })
      aplicarLlamadas(entrada.toolCalls, { refrescar: false })
      registrarConsumo(entrada.consumo, entrada.ts)
    }
  }
  refrescarActivo()
}

async function arrancar() {
  const respuesta = await pedir("/api/casos")
  if (respuesta.estado === 401) return pedirClave()
  casos = respuesta.ok ? respuesta.datos.casos : []
  limpiarChat()
  pintarBienvenida(casos, procesarCaso)
  fijarCasos(casos)
  await restaurar()
}

function pedirClave() {
  $("#acceso").hidden = false
  $("#clave").focus()
}

async function iniciar() {
  iniciarExpediente({
    enviarMensaje: (texto) => {
      cambiarVista("chat")
      enviar(texto)
    },
    anunciarEvento: (texto) => pintarEvento(texto),
    sesionId: () => sesionId,
    ocupado: () => ocupado,
  })
  const { ok, datos } = await pedir("/api/health")
  $("#chip-modelo").textContent = ok ? datos.model : "sin conexión con el servidor"
  if (ok) fijarModelo(datos.provider, datos.model)
  if (ok && datos.acceso === "con_clave" && !almacen.leer("claveAcceso")) return pedirClave()
  await arrancar()
}

// ─── Eventos ─────────────────────────────────────────────────────────────────

$("#formulario").addEventListener("submit", (evento) => {
  evento.preventDefault()
  const texto = campoMensaje.value
  campoMensaje.value = ""
  campoMensaje.style.height = ""
  enviar(texto)
})

campoMensaje.addEventListener("keydown", (evento) => {
  if (evento.key === "Enter" && !evento.shiftKey) {
    evento.preventDefault()
    $("#formulario").requestSubmit()
  }
})

campoMensaje.addEventListener("input", () => {
  campoMensaje.style.height = ""
  campoMensaje.style.height = `${Math.min(campoMensaje.scrollHeight, 160)}px`
})

$("#form-acceso").addEventListener("submit", async (evento) => {
  evento.preventDefault()
  const clave = $("#clave").value
  fijarClave(clave)
  const prueba = await pedir("/api/casos")
  if (prueba.estado === 401) {
    $("#error-acceso").hidden = false
    return
  }
  almacen.guardar("claveAcceso", clave, true)
  $("#acceso").hidden = true
  $("#error-acceso").hidden = true
  await arrancar()
})

$("#nueva").addEventListener("click", () => {
  sesionId = nuevaSesionId()
  reiniciarExpediente()
  reiniciarConsola()
  limpiarChat()
  pintarBienvenida(casos, procesarCaso)
  cambiarVista("chat")
})

for (const boton of document.querySelectorAll(".pestanas button")) {
  boton.addEventListener("click", () => cambiarVista(boton.dataset.vista))
}

iniciar()
