// Panel de firma: dibujar la firma con el mouse, el dedo o un lápiz, o firmar con un clic.

/** Convierte un <canvas> en un área para firmar; devuelve cómo limpiarla, saber si está vacía y exportarla a PNG. */
export function crearPadDeFirma(canvas) {
  const contexto = canvas.getContext("2d")
  let trazos = 0
  let anterior = null

  function ajustarResolucion() {
    const escala = window.devicePixelRatio || 1
    const { width, height } = canvas.getBoundingClientRect()
    canvas.width = Math.round(width * escala)
    canvas.height = Math.round(height * escala)
    contexto.setTransform(escala, 0, 0, escala, 0, 0)
    contexto.lineWidth = 2.4
    contexto.lineCap = "round"
    contexto.lineJoin = "round"
    contexto.strokeStyle = "#12337a"
  }

  function punto(evento) {
    const caja = canvas.getBoundingClientRect()
    return { x: evento.clientX - caja.left, y: evento.clientY - caja.top }
  }

  canvas.addEventListener("pointerdown", (evento) => {
    canvas.setPointerCapture(evento.pointerId)
    anterior = punto(evento)
    contexto.beginPath()
    contexto.arc(anterior.x, anterior.y, 1.1, 0, Math.PI * 2)
    contexto.fillStyle = contexto.strokeStyle
    contexto.fill()
    trazos++
    canvas.dispatchEvent(new Event("cambio"))
  })
  canvas.addEventListener("pointermove", (evento) => {
    if (!anterior) return
    const actual = punto(evento)
    const medio = { x: (anterior.x + actual.x) / 2, y: (anterior.y + actual.y) / 2 }
    contexto.beginPath()
    contexto.moveTo(anterior.x, anterior.y)
    contexto.quadraticCurveTo(anterior.x, anterior.y, medio.x, medio.y)
    contexto.lineTo(actual.x, actual.y)
    contexto.stroke()
    anterior = actual
  })
  const terminar = () => {
    anterior = null
  }
  canvas.addEventListener("pointerup", terminar)
  canvas.addEventListener("pointercancel", terminar)

  ajustarResolucion()

  return {
    limpiar() {
      contexto.clearRect(0, 0, canvas.width, canvas.height)
      trazos = 0
      canvas.dispatchEvent(new Event("cambio"))
    },
    vacio: () => trazos === 0,
    aPng: () => canvas.toDataURL("image/png"),
    /** Vuelve a dibujar una firma guardada (por ejemplo, si el panel se repinta mientras se firma). */
    restaurar(dataUrl) {
      const imagen = new Image()
      imagen.onload = () => {
        const { width, height } = canvas.getBoundingClientRect()
        contexto.drawImage(imagen, 0, 0, width, height)
        trazos = Math.max(trazos, 1)
        canvas.dispatchEvent(new Event("cambio"))
      }
      imagen.src = dataUrl
    },
  }
}
