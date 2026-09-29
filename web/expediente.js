// Expediente del caso: las cuatro funcionalidades del reto (lectura, cruce, formulario y paquete)
// más la firma y el envío, cada una con su resultado. Se arma con los datos que devuelven las herramientas.
import { descargar, pedir } from "./api.js"
import { crearPadDeFirma } from "./firma.js"
import { escapar } from "./markdown.js"
import { bytes, FORMATOS, IDENTIFICADORES, nombreSoporte, PAISES, PASOS } from "./textos.js"
import { abrirVisor } from "./visor.js"

const nodo = document.querySelector("#expediente")
const expedientes = new Map()
let activo = null
let resumenes = new Map()
let ctx = null
let pad = null
let modoFirma = "dibujada"

const ICONOS = { hecho: "✓", alerta: "!", bloqueado: "✗", error: "✗", omitido: "–", pendiente: "" }
const ETIQUETAS = { hecho: "hecho", alerta: "revisar", bloqueado: "bloqueado", error: "error", omitido: "no aplica", pendiente: "pendiente" }
const CORTOS = { solicitud: "Solicitud", cruce: "Cruce", formulario: "Formulario", paquete: "Paquete", firma: "Firma", envio: "Envío" }

export function iniciarExpediente(opciones) {
  ctx = opciones
  nodo.addEventListener("click", manejarClic)
  pintar()
}

export function fijarCasos(lista) {
  resumenes = new Map(lista.map((caso) => [caso.caso, caso]))
  pintar()
}

export function reiniciarExpediente() {
  expedientes.clear()
  activo = null
  pad = null
  pintar()
}

function obtener(caso) {
  if (!expedientes.has(caso)) expedientes.set(caso, { caso, errores: {}, archivos: [], firmaEstado: null })
  return expedientes.get(caso)
}

/** Actualiza los expedientes con las llamadas a herramientas de un turno y deja activo el último caso tocado. */
export function aplicarLlamadas(llamadas, { refrescar = true } = {}) {
  let ultimo = null
  for (const llamada of llamadas ?? []) {
    const caso = llamada.argumentos?.caso
    const paso = PASOS.find((candidato) => candidato.herramienta === llamada.herramienta)
    if (typeof caso !== "string" || !paso) continue
    const expediente = obtener(caso)
    if (llamada.ok) {
      expediente[paso.id] = llamada.datos
      delete expediente.errores[paso.id]
      if (paso.id === "paquete") expediente.firmaEstado = null
    } else if (!String(llamada.resumen).includes("requiere confirmación")) {
      expediente.errores[paso.id] = llamada.resumen
    }
    ultimo = caso
  }
  if (!ultimo) return
  activo = ultimo
  pintar()
  if (refrescar) refrescarArchivos(ultimo)
}

async function refrescarArchivos(caso) {
  const expediente = obtener(caso)
  const [archivos, firma] = await Promise.all([pedir(`/api/casos/${caso}/archivos`), pedir(`/api/casos/${caso}/firma`)])
  if (archivos.ok) expediente.archivos = archivos.datos.archivos
  if (firma.ok) expediente.firmaEstado = firma.datos
  if (caso === activo) pintar()
}

// ─── Estado de cada paso ─────────────────────────────────────────────────────

function estadoPaso(expediente, id) {
  if (expediente.errores[id]) return "error"
  switch (id) {
    case "solicitud":
      return expediente.solicitud ? "hecho" : "pendiente"
    case "cruce":
      if (!expediente.cruce) return "pendiente"
      return expediente.cruce.faltantes.length || expediente.cruce.requiere_confirmacion.length ? "alerta" : "hecho"
    case "formulario":
      if (!expediente.formulario) return "pendiente"
      return expediente.formulario.soportado ? "hecho" : "alerta"
    case "paquete":
      if (!expediente.paquete) return "pendiente"
      return expediente.paquete.listo_para_firma ? "hecho" : "bloqueado"
    case "firma":
      if (expediente.solicitud?.formato === "portal") return "omitido"
      if (expediente.firmaEstado?.firma) return "hecho"
      if (expediente.paquete && !expediente.paquete.listo_para_firma) return "bloqueado"
      return "pendiente"
    case "envio":
      return expediente.envio ? "hecho" : "pendiente"
  }
  return "pendiente"
}

function estadoGeneral(expediente) {
  if (expediente.envio) return ["bien", "Envío simulado"]
  if (expediente.firmaEstado?.firma) return ["bien", "Firmado"]
  if (expediente.paquete) return expediente.paquete.listo_para_firma ? ["bien", "Listo para firma"] : ["mal", "No listo para firma"]
  return ["neutro", "En proceso"]
}

// ─── Piezas de la vista ──────────────────────────────────────────────────────

function botonesArchivo(ruta) {
  return `<span class="archivo-acciones">
    <button type="button" class="boton mini primario" data-accion="ver" data-ruta="${escapar(ruta)}">Ver</button>
    <button type="button" class="boton mini secundario" data-accion="descargar" data-ruta="${escapar(ruta)}">Descargar</button>
  </span>`
}

function filaArchivo(archivo, detalle = bytes(archivo.bytes)) {
  const extension = archivo.nombre.split(".").pop()
  return `<li class="archivo-fila"><span class="archivo-icono tipo-${extension}">${escapar(extension)}</span>
    <span class="archivo-nombre">${escapar(archivo.nombre)}<small>${escapar(detalle)}</small></span>${botonesArchivo(archivo.ruta)}</li>`
}

function pendiente(texto) {
  return `<p class="exp-pendiente">${texto}</p>`
}

function seccionSolicitud(expediente) {
  const solicitud = expediente.solicitud
  if (!solicitud) return pendiente("El agente todavía no ha leído la solicitud del cliente.")
  const { correo, pais, formato, campos, soportes } = solicitud
  return `<p class="exp-meta">Correo de <strong>${escapar(correo.de)}</strong> · ${escapar(correo.fecha)}</p>
    <p class="exp-asunto">${escapar(correo.asunto)}</p>
    <details class="exp-correo"><summary>Ver el correo del cliente</summary><div>${escapar(correo.cuerpo).replace(/\n/g, "<br>")}</div></details>
    <div class="chips">
      <span class="chip">${escapar(PAISES[pais] ?? pais)} · pide ${IDENTIFICADORES[pais] ?? "identificador"}</span>
      <span class="chip">Formato ${escapar(FORMATOS[formato] ?? formato)}</span>
      <span class="chip">${campos.length} campos pedidos</span>
    </div>
    <h5>Soportes que exige el cliente</h5>
    <ul class="lista-simple">${soportes.map((tipo) => `<li>${escapar(nombreSoporte(tipo))}</li>`).join("")}</ul>`
}

function filaCampo(cruce, etiqueta) {
  const lleno = cruce.llenos.find((campo) => campo.etiqueta === etiqueta)
  const porConfirmar = cruce.requiere_confirmacion.find((campo) => campo.etiqueta === etiqueta)
  const faltante = cruce.faltantes.find((campo) => campo.etiqueta === etiqueta)
  const campo = lleno ?? porConfirmar ?? faltante
  const [clase, icono, nota] = lleno ? ["lleno", "✓", ""] : porConfirmar ? ["alerta", "!", porConfirmar.nota] : ["faltante", "✗", faltante?.motivo ?? ""]
  const valor = campo?.valor === undefined ? `<span class="dim">—</span>` : escapar(campo.valor)
  const origen = campo?.clave ? `<code>${escapar(campo.clave)}</code>` : `<span class="dim">sin fuente</span>`
  return `<tr class="fila-${clase}"><td><span class="marca-estado">${icono}</span>${escapar(etiqueta)}</td>
    <td>${valor}${nota ? `<div class="nota">${escapar(nota)}</div>` : ""}</td><td>${origen}</td></tr>`
}

function seccionCruce(expediente) {
  const cruce = expediente.cruce
  if (!cruce) return pendiente("Aquí aparece cada campo que pide el cliente, con el dato del maestro que le corresponde.")
  return `<div class="contadores">
      <span class="contador bien">✓ ${cruce.llenos.length} llenos</span>
      <span class="contador alerta">! ${cruce.requiere_confirmacion.length} por confirmar</span>
      <span class="contador mal">✗ ${cruce.faltantes.length} faltantes</span>
    </div>
    <div class="tabla-desplazable"><table class="tabla-campos">
      <thead><tr><th>Campo que pide el cliente</th><th>Valor</th><th>Origen en el maestro</th></tr></thead>
      <tbody>${cruce.mapeo.map(({ etiqueta }) => filaCampo(cruce, etiqueta)).join("")}</tbody>
    </table></div>`
}

function seccionFormulario(expediente) {
  const formulario = expediente.formulario
  if (!formulario) return pendiente("Aquí aparece el formulario lleno en el formato que pidió el cliente, con su vista previa.")
  const nombre = formulario.ruta.split("/").pop()
  const archivo = expediente.archivos.find((candidato) => candidato.ruta === formulario.ruta)
  const extension = nombre.split(".").pop()
  const { campos } = formulario
  return `<div class="archivo-tarjeta">
      <span class="archivo-icono grande tipo-${extension}">${escapar(extension)}</span>
      <span class="archivo-nombre"><strong>${escapar(nombre)}</strong>
        <small>${campos.llenos} llenos · ${campos.por_confirmar} por confirmar · ${campos.faltantes} faltantes${archivo ? ` · ${bytes(archivo.bytes)}` : ""}</small></span>
      ${botonesArchivo(formulario.ruta)}
    </div>
    ${formulario.aviso ? `<p class="aviso">${escapar(formulario.aviso)}</p>` : ""}`
}

function filaSoporte(soporte) {
  const icono = { presente: "✓", vencido: "⚠", ausente: "✗" }[soporte.estado] ?? "•"
  const vigencia = soporte.estado === "ausente" ? "no está en el repositorio" : soporte.vigencia_hasta ? `vigente hasta ${soporte.vigencia_hasta}` : "sin vencimiento"
  return `<li class="soporte soporte-${soporte.estado}"><span class="icono">${icono}</span><span>${escapar(soporte.nombre)}</span>
    <span class="chip-estado">${soporte.estado} · ${escapar(vigencia)}</span></li>`
}

function seccionPaquete(expediente) {
  const paquete = expediente.paquete
  if (!paquete) return pendiente("Aquí aparece el paquete para firma: soportes, checklist y borrador del correo.")
  const archivos = expediente.archivos.filter((archivo) => archivo.carpeta === "paquete" && !archivo.interno)
  return `<div class="banner ${paquete.listo_para_firma ? "bien" : "mal"}">
      <strong>${paquete.listo_para_firma ? "✓ Listo para firma" : "✗ No está listo para firma"}</strong>
      <span>vigencias revisadas al ${escapar(paquete.fecha_referencia)}</span>
    </div>
    ${paquete.checklist.bloqueos.length ? `<ul class="lista-bloqueos">${paquete.checklist.bloqueos.map((b) => `<li>${escapar(b)}</li>`).join("")}</ul>` : ""}
    <h5>Soportes</h5>
    <ul class="lista-soportes">${paquete.checklist.soportes.map(filaSoporte).join("")}</ul>
    <h5>Archivos del paquete</h5>
    <ul class="lista-archivos">${archivos.length ? archivos.map((archivo) => filaArchivo(archivo)).join("") : "<li class='dim'>Cargando archivos…</li>"}</ul>`
}

function firmaHecha(firma) {
  const metodo = firma.metodo === "dibujada" ? "firma dibujada" : "firma electrónica con un clic"
  return `<div class="banner bien"><strong>✓ Firmado por ${escapar(firma.firmante)}</strong><span>${escapar(firma.cargo)} · ${escapar(firma.fecha)}</span></div>
    <p class="exp-meta">${metodo} · código de verificación <code>${escapar(firma.codigo)}</code></p>
    <ul class="lista-archivos">${filaArchivo({ nombre: firma.archivo, ruta: `out/${firma.caso}/paquete/${firma.archivo}` }, "formulario con su hoja de firma")}</ul>
    <button type="button" class="boton mini secundario" data-accion="refirmar">Volver a firmar</button>`
}

function panelParaFirmar(estado) {
  const hoy = new Date().toLocaleDateString("es-CO", { dateStyle: "long" })
  const ocupado = ctx?.ocupado?.() ?? false
  return `<p class="exp-meta">Firmante: <strong>${escapar(estado.firmante)}</strong> · ${escapar(estado.cargo)} <span class="dim">(del repositorio maestro)</span></p>
    <div class="modo-firma" role="tablist" aria-label="Forma de firmar">
      <button type="button" role="tab" data-accion="modo-firma" data-modo="dibujada" aria-selected="${modoFirma === "dibujada"}">✍ Dibujar mi firma</button>
      <button type="button" role="tab" data-accion="modo-firma" data-modo="clic" aria-selected="${modoFirma === "clic"}">⚡ Firmar con un clic</button>
    </div>
    <div class="firma-dibujada" ${modoFirma === "dibujada" ? "" : "hidden"}>
      <canvas class="pad-firma" aria-label="Área para dibujar la firma"></canvas>
      <p class="pad-ayuda">Firma aquí con el mouse, el dedo o un lápiz.</p>
      <div class="fila">
        <button type="button" class="boton secundario" data-accion="limpiar-firma">Limpiar</button>
        <button type="button" class="boton primario" data-accion="firmar" data-metodo="dibujada" disabled>Firmar documento</button>
      </div>
    </div>
    <div class="firma-clic" ${modoFirma === "clic" ? "" : "hidden"}>
      <div class="sello"><span class="sello-nombre">${escapar(estado.firmante)}</span><span class="sello-texto">Firmado electrónicamente · ${hoy}</span></div>
      <button type="button" class="boton primario" data-accion="firmar" data-metodo="clic" ${ocupado ? "disabled" : ""}>Firmar con un clic</button>
    </div>
    <p class="nota">Firma electrónica simple para el reto; no es una firma digital con certificado. La firma es tuya: el agente no puede firmar.</p>
    <p class="texto-error" data-error-firma hidden></p>`
}

function seccionFirma(expediente) {
  if (expediente.solicitud?.formato === "portal") return pendiente("No aplica: en un portal web no hay formulario que firmar; la persona completa el registro en el portal.")
  if (!expediente.paquete) return pendiente("Cuando el paquete esté armado y listo, aquí firmas: dibujando tu firma o con un clic.")
  const estado = expediente.firmaEstado
  if (!estado) return pendiente("Consultando el estado de la firma…")
  if (estado.firma && !expediente.refirmar) return firmaHecha(estado.firma)
  if (!estado.disponible) return `<p class="aviso">${escapar(estado.motivo)}</p>`
  return panelParaFirmar(estado)
}

function seccionEnvio(expediente) {
  if (expediente.envio) {
    return `<div class="banner bien"><strong>✓ Envío simulado</strong><span>${expediente.envio.firmado ? "con el formulario firmado" : "sin firma"}</span></div>
      <ul class="lista-archivos">${filaArchivo({ nombre: "ENVIO-SIMULADO.md", ruta: expediente.envio.ruta }, "constancia del envío")}</ul>`
  }
  if (!expediente.paquete) return pendiente("El envío siempre lo confirmas tú; en este reto solo se simula.")
  return `<p class="exp-meta">El envío lo hace el agente y solo con tu confirmación explícita. En este reto no sale ningún correo: queda la constancia ENVIO-SIMULADO.md.</p>
    <button type="button" class="boton primario" data-accion="pedir-envio" ${ctx?.ocupado?.() ? "disabled" : ""}>Pedirle al agente que lo envíe</button>`
}

const SECCIONES = { solicitud: seccionSolicitud, cruce: seccionCruce, formulario: seccionFormulario, paquete: seccionPaquete, firma: seccionFirma, envio: seccionEnvio }

function selectorDeCasos() {
  if (expedientes.size < 2) return ""
  const botones = [...expedientes.keys()].map((caso) => `<button type="button" data-accion="caso" data-caso="${caso}" aria-pressed="${caso === activo}">${escapar(caso)}</button>`)
  return `<div class="selector-casos" aria-label="Casos de esta sesión">${botones.join("")}</div>`
}

function vistaInicial() {
  return `<div class="exp-vacio">
    <h2>Expediente del caso</h2>
    <p>Cuando el agente procese una solicitud, aquí ves cada paso con su resultado:</p>
    <ol class="exp-guia">
      <li><strong>Lectura de la solicitud</strong><span>qué pide el cliente: campos y soportes</span></li>
      <li><strong>Cruce con el repositorio maestro</strong><span>cada campo con su dato y su origen</span></li>
      <li><strong>Llenado del formulario</strong><span>el Excel o el PDF, con vista previa</span></li>
      <li><strong>Paquete para firma</strong><span>soportes al día, checklist y borrador del correo</span></li>
      <li><strong>Firma del representante legal</strong><span>dibujada o con un clic, siempre tuya</span></li>
      <li><strong>Envío al cliente</strong><span>solo con tu confirmación</span></li>
    </ol>
  </div>`
}

function pintar() {
  const respaldo = pad && !pad.vacio() ? pad.aPng() : null
  pad = null
  if (!activo) {
    nodo.innerHTML = vistaInicial()
    return
  }
  const expediente = obtener(activo)
  const resumen = resumenes.get(activo)
  const [claseEstado, textoEstado] = estadoGeneral(expediente)
  const pais = expediente.solicitud?.pais ?? resumen?.pais
  const formato = expediente.solicitud?.formato ?? resumen?.formato
  const pasos = PASOS.map((paso) => {
    const estado = estadoPaso(expediente, paso.id)
    return `<li><button type="button" class="paso-indicador estado-${estado}" data-accion="ir-paso" data-paso="${paso.id}" title="${paso.titulo}: ${ETIQUETAS[estado]}">
      <span class="circulo">${ICONOS[estado] || paso.numero}</span><span class="rotulo">${CORTOS[paso.id]}</span></button></li>`
  }).join("")
  const secciones = PASOS.map((paso) => {
    const estado = estadoPaso(expediente, paso.id)
    const error = expediente.errores[paso.id] ? `<p class="texto-error">${escapar(expediente.errores[paso.id])}</p>` : ""
    return `<section class="exp-seccion estado-${estado}" id="paso-${paso.id}">
      <header><span class="circulo">${ICONOS[estado] || paso.numero}</span><h3>${paso.numero}. ${paso.titulo}</h3><span class="chip-paso">${ETIQUETAS[estado]}</span></header>
      <div class="exp-cuerpo">${error}${SECCIONES[paso.id](expediente)}</div>
    </section>`
  }).join("")
  nodo.innerHTML = `${selectorDeCasos()}
    <header class="exp-cabecera">
      <div><p class="exp-caso">${escapar(activo)}${pais ? ` · ${escapar(PAISES[pais] ?? pais)}` : ""}${formato ? ` · ${escapar(FORMATOS[formato] ?? formato)}` : ""}</p>
      <h2>${escapar(expediente.solicitud?.cliente ?? resumen?.cliente ?? activo)}</h2></div>
      <span class="estado-general ${claseEstado}">${textoEstado}</span>
    </header>
    <ol class="stepper">${pasos}</ol>
    ${secciones}`
  montarPad(respaldo)
}

function montarPad(respaldo) {
  const canvas = nodo.querySelector(".pad-firma")
  if (!canvas || canvas.closest("[hidden]")) return
  pad = crearPadDeFirma(canvas)
  const boton = nodo.querySelector('[data-accion="firmar"][data-metodo="dibujada"]')
  canvas.addEventListener("cambio", () => {
    boton.disabled = pad.vacio() || (ctx?.ocupado?.() ?? false)
  })
  if (respaldo) pad.restaurar(respaldo)
}

// ─── Acciones ────────────────────────────────────────────────────────────────

async function firmar(metodo) {
  const expediente = obtener(activo)
  const error = nodo.querySelector("[data-error-firma]")
  const cuerpo = { metodo, sessionId: ctx.sesionId() }
  if (metodo === "dibujada") {
    if (!pad || pad.vacio()) return
    cuerpo.imagen = pad.aPng()
  }
  for (const boton of nodo.querySelectorAll('[data-accion="firmar"]')) boton.disabled = true
  const respuesta = await pedir(`/api/casos/${activo}/firma`, { metodo: "POST", cuerpo })
  if (!respuesta.ok) {
    error.textContent = respuesta.datos.error ?? "No se pudo firmar."
    error.hidden = false
    for (const boton of nodo.querySelectorAll('[data-accion="firmar"]')) boton.disabled = false
    return
  }
  const { firma } = respuesta.datos
  expediente.firmaEstado = { ...(expediente.firmaEstado ?? {}), disponible: true, firma }
  expediente.refirmar = false
  pad = null
  ctx.anunciarEvento(`Firmaste el formulario de ${firma.caso} como ${firma.firmante} (${firma.metodo === "dibujada" ? "firma dibujada" : "firma con un clic"}).`)
  pintar()
  refrescarArchivos(firma.caso)
}

function manejarClic(evento) {
  const objetivo = evento.target.closest("[data-accion]")
  if (!objetivo) return
  const { accion, ruta } = objetivo.dataset
  if (accion === "ver") abrirVisor(ruta)
  else if (accion === "descargar") descargar(ruta)
  else if (accion === "ir-paso") nodo.querySelector(`#paso-${objetivo.dataset.paso}`)?.scrollIntoView({ behavior: "smooth", block: "start" })
  else if (accion === "caso") {
    activo = objetivo.dataset.caso
    pintar()
    refrescarArchivos(activo)
  } else if (accion === "modo-firma") {
    modoFirma = objetivo.dataset.modo
    pintar()
  } else if (accion === "limpiar-firma") pad?.limpiar()
  else if (accion === "firmar") firmar(objetivo.dataset.metodo)
  else if (accion === "refirmar") {
    obtener(activo).refirmar = true
    pintar()
  } else if (accion === "pedir-envio") ctx.enviarMensaje(`Envía el paquete del caso "${activo}".`)
}

/** Vuelve a pedir archivos y firma del caso activo (por ejemplo, al restaurar una sesión). */
export function refrescarActivo() {
  if (activo) refrescarArchivos(activo)
}

/** El panel se vuelve a pintar cuando cambia si el agente está ocupado (para activar o desactivar botones). */
export function actualizarOcupado() {
  if (activo) pintar()
}
