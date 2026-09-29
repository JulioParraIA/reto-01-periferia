// Vista previa de lo generado: el Excel como tabla, el PDF incrustado y los Markdown formateados.
import { descargar, pedir, traerArchivo } from "./api.js"
import { escapar, markdown } from "./markdown.js"

const modal = document.querySelector("#visor")
const titulo = document.querySelector("#visor-titulo")
const contenido = document.querySelector("#visor-contenido")
let rutaActual = null
let urlTemporal = null

function cerrar() {
  modal.hidden = true
  contenido.innerHTML = ""
  if (urlTemporal) URL.revokeObjectURL(urlTemporal)
  urlTemporal = null
}

function tablaExcel(hoja) {
  const columnas = [...new Set(hoja.filas.flatMap((fila) => fila.celdas.map((celda) => celda.columna)))].sort(
    (a, b) => a.length - b.length || a.localeCompare(b),
  )
  const cabecera = `<tr><th></th>${columnas.map((c) => `<th>${c}</th>`).join("")}</tr>`
  const filas = hoja.filas
    .map((fila) => {
      const valores = Object.fromEntries(fila.celdas.map((celda) => [celda.columna, celda.valor]))
      return `<tr><th>${fila.numero}</th>${columnas.map((c) => `<td>${escapar(valores[c] ?? "")}</td>`).join("")}</tr>`
    })
    .join("")
  return `<div class="tabla-desplazable"><table class="hoja-excel"><thead>${cabecera}</thead><tbody>${filas}</tbody></table></div>`
}

async function mostrarExcel(ruta) {
  const { ok, datos } = await pedir(`/api/excel?ruta=${encodeURIComponent(ruta)}`)
  if (!ok) throw new Error(datos.error ?? "No se pudo leer el Excel.")
  const pestanas = datos.hojas.map((hoja, i) => `<button type="button" class="pestana-hoja" data-hoja="${i}" aria-pressed="${i === 0}">${escapar(hoja.nombre)}</button>`).join("")
  contenido.innerHTML = `<div class="fila pestanas-hoja">${pestanas}</div><div id="hoja-activa">${tablaExcel(datos.hojas[0])}</div>`
  for (const boton of contenido.querySelectorAll(".pestana-hoja")) {
    boton.addEventListener("click", () => {
      for (const otro of contenido.querySelectorAll(".pestana-hoja")) otro.setAttribute("aria-pressed", String(otro === boton))
      contenido.querySelector("#hoja-activa").innerHTML = tablaExcel(datos.hojas[Number(boton.dataset.hoja)])
    })
  }
}

async function mostrarPdf(ruta) {
  urlTemporal = URL.createObjectURL(await traerArchivo(ruta))
  contenido.innerHTML = `<iframe class="visor-pdf" title="Vista previa del PDF" src="${urlTemporal}"></iframe>`
}

async function mostrarTexto(ruta) {
  const texto = await (await traerArchivo(ruta)).text()
  contenido.innerHTML = ruta.endsWith(".md") ? `<div class="documento">${markdown(texto)}</div>` : `<pre class="documento-plano">${escapar(texto)}</pre>`
}

export async function abrirVisor(ruta) {
  rutaActual = ruta
  titulo.textContent = ruta.split("/").slice(1).join(" / ")
  contenido.innerHTML = `<p class="cargando">Cargando…</p>`
  modal.hidden = false
  document.querySelector("#visor-cerrar").focus()
  try {
    if (ruta.endsWith(".xlsx")) await mostrarExcel(ruta)
    else if (ruta.endsWith(".pdf")) await mostrarPdf(ruta)
    else await mostrarTexto(ruta)
  } catch (error) {
    contenido.innerHTML = `<p class="texto-error">${escapar(error.message)}</p>`
  }
}

document.querySelector("#visor-cerrar").addEventListener("click", cerrar)
document.querySelector("#visor-descargar").addEventListener("click", () => rutaActual && descargar(rutaActual))
modal.addEventListener("click", (evento) => evento.target === modal && cerrar())
document.addEventListener("keydown", (evento) => evento.key === "Escape" && !modal.hidden && cerrar())
