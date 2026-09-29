// Mensajes del chat: bienvenida con los casos, mensajes del usuario y del agente, eventos y avisos.
import { escapar, markdown } from "./markdown.js"
import { dolares, FORMATOS, hora, NOMBRES_HERRAMIENTAS, segundos, tokens } from "./textos.js"

const conversacion = document.querySelector("#conversacion")

function agregar(elemento) {
  conversacion.querySelector(".bienvenida")?.classList.add("compacta")
  conversacion.append(elemento)
  // Desplazamiento inmediato: el suave se interrumpe cuando cambia la altura (por ejemplo, al quitar «trabajando…»).
  const largo = elemento.offsetHeight > conversacion.clientHeight * 0.7
  elemento.scrollIntoView({ block: largo ? "start" : "end" })
  return elemento
}

function nodo(etiqueta, clase, html = "") {
  const elemento = document.createElement(etiqueta)
  elemento.className = clase
  elemento.innerHTML = html
  return elemento
}

export function limpiarChat() {
  conversacion.innerHTML = ""
}

function tarjetaCaso(caso) {
  const fecha = new Date(`${caso.fecha}T12:00:00`).toLocaleDateString("es-CO", { day: "numeric", month: "short", year: "numeric" })
  return `<button type="button" class="caso-tarjeta" data-caso="${escapar(caso.caso)}">
    <span class="caso-cabecera"><span class="caso-pais">${escapar(caso.pais)}</span><span class="chip">${escapar(FORMATOS[caso.formato] ?? caso.formato)}</span></span>
    <span class="caso-cliente">${escapar(caso.cliente)}</span>
    <span class="caso-asunto">${escapar(caso.asunto)}</span>
    <span class="caso-pie"><span>${escapar(fecha)}</span><span class="caso-accion">Procesar →</span></span>
  </button>`
}

export function pintarBienvenida(casos, alProcesar) {
  const bienvenida = nodo(
    "section",
    "bienvenida",
    `<h2>¿Qué solicitud procesamos hoy?</h2>
    <p>El agente lee la solicitud del cliente, cruza cada campo con el repositorio maestro, llena el formulario y arma el paquete para la firma del representante legal. Nada se firma ni se envía sin ti.</p>
    <ol class="flujo">
      <li><span>1</span>Lee la solicitud</li><li><span>2</span>Cruza con el maestro</li><li><span>3</span>Llena el formulario</li>
      <li><span>4</span>Arma el paquete</li><li class="humano"><span>5</span>Tú firmas</li><li class="humano"><span>6</span>Tú confirmas el envío</li>
    </ol>
    <h3>Solicitudes recibidas</h3>
    <div class="casos">${casos.map(tarjetaCaso).join("") || "<p class='dim'>No hay solicitudes en fixtures/.</p>"}</div>`,
  )
  bienvenida.addEventListener("click", (evento) => {
    const tarjeta = evento.target.closest("[data-caso]")
    if (tarjeta) alProcesar(tarjeta.dataset.caso)
  })
  conversacion.prepend(bienvenida)
}

export function pintarUsuario(texto) {
  agregar(nodo("div", "mensaje usuario", `<p>${escapar(texto).replace(/\n/g, "<br>")}</p>`))
}

function pasoDelAgente(llamada) {
  const nombre = NOMBRES_HERRAMIENTAS[llamada.herramienta] ?? llamada.herramienta
  return `<li class="paso ${llamada.ok ? "bien" : "mal"}"><details>
    <summary><span class="icono">${llamada.ok ? "✓" : "✗"}</span><span class="paso-nombre">${escapar(nombre)}</span><span class="paso-resumen">${escapar(llamada.resumen)}</span></summary>
    <div class="paso-detalle"><code>${escapar(llamada.herramienta)}</code><pre>${escapar(JSON.stringify(llamada.argumentos, null, 2))}</pre></div>
  </details></li>`
}

function pieDeConsumo(consumo) {
  if (!consumo) return ""
  const total = consumo.entrada.tokens + consumo.salida.tokens
  return `<footer class="pie-mensaje">${segundos(consumo.duracionMs)} · ${tokens(total)} tokens · ${dolares(consumo.totalUsd)}</footer>`
}

function botonesConfirmacion(alConfirmar, alCancelar) {
  const fila = nodo("div", "acciones")
  const confirmar = nodo("button", "boton primario", "Confirmar envío")
  const cancelar = nodo("button", "boton secundario", "Cancelar")
  confirmar.type = cancelar.type = "button"
  const usar = (accion) => {
    confirmar.disabled = cancelar.disabled = true
    accion()
  }
  confirmar.addEventListener("click", () => usar(alConfirmar))
  cancelar.addEventListener("click", () => usar(alCancelar))
  fila.append(confirmar, cancelar)
  return fila
}

/** Mensaje del agente: los pasos que dio (herramientas), su respuesta y, si hace falta, la confirmación. */
export function pintarAgente(respuesta, { alConfirmar, alCancelar, conBotones = true } = {}) {
  const clases = ["mensaje", "agente", respuesta.needsConfirmation ? "confirmacion" : "", respuesta.error ? "error" : ""].filter(Boolean).join(" ")
  const pasos = respuesta.toolCalls?.length ? `<ol class="pasos-agente">${respuesta.toolCalls.map(pasoDelAgente).join("")}</ol>` : ""
  const etiqueta = respuesta.needsConfirmation ? `<p class="etiqueta-confirmacion">Esperando tu confirmación</p>` : ""
  const burbuja = nodo(
    "article",
    clases,
    `<div class="avatar" aria-hidden="true">P</div>
    <div class="cuerpo-mensaje">${pasos}${etiqueta}<div class="texto">${markdown(respuesta.reply)}</div>${pieDeConsumo(respuesta.consumo)}</div>`,
  )
  if (respuesta.needsConfirmation && conBotones) burbuja.querySelector(".cuerpo-mensaje").append(botonesConfirmacion(alConfirmar, alCancelar))
  agregar(burbuja)
}

export function pintarEvento(texto, ts = new Date().toISOString()) {
  agregar(nodo("div", "evento", `<span>✍ ${escapar(texto)} · ${hora(ts)}</span>`))
}

export function pintarAviso(texto) {
  agregar(nodo("div", "mensaje agente error", `<div class="avatar" aria-hidden="true">!</div><div class="cuerpo-mensaje"><p>${escapar(texto)}</p></div>`))
}

export function mostrarPensando() {
  const indicador = agregar(nodo("div", "pensando", "<span></span><span></span><span></span> <em>El agente está trabajando… 0 s</em>"))
  const inicio = Date.now()
  const reloj = setInterval(() => {
    indicador.querySelector("em").textContent = `El agente está trabajando… ${Math.round((Date.now() - inicio) / 1000)} s`
  }, 1000)
  return () => {
    clearInterval(reloj)
    indicador.remove()
  }
}
