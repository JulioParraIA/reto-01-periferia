---
name: registro-proveedor
description: Reglas del proceso de registro de Periferia como proveedor (estados de los campos, identificador tributario por país, datos bancarios, vigencia de los soportes y formatos de salida). Úsala al procesar una solicitud de registro.
---

# Conocimiento del proceso: registro de Periferia como proveedor

## Para qué sirve

Los clientes de Periferia en Colombia, Ecuador, Perú, Panamá y Honduras piden registrarla como proveedor; mientras el registro no esté, la facturación se retrasa. Llegan de 8 a 12 solicitudes al mes. Los datos casi siempre son los mismos y están en el repositorio maestro; lo que cambia es el formato de salida: plantilla de Excel, formulario PDF o portal web. El cierre es la firma del representante legal y el envío, que siempre hace una persona.

## Estados de un campo

- **lleno:** el dato existe en el maestro; se indica la ruta de donde salió.
- **faltante:** el maestro no tiene el dato o la etiqueta no tiene equivalente en el glosario. Nunca se inventa. No bloquea la firma, pero va en el checklist.
- **requiere_confirmacion:** hay dato, pero la analista debe revisarlo: el mapeo es aproximado (confianza menor a 0,8), la etiqueta es ambigua o aplica la regla del identificador tributario.

## Identificador tributario por país

| País | Identificador |
|---|---|
| Colombia (CO) | NIT |
| Ecuador (EC), Perú (PE) y Panamá (PA) | RUC |
| Honduras (HN) | RTN |

Periferia solo tiene NIT colombiano. Para clientes de otros países, el campo se llena con el NIT y se marca por confirmar con la nota «identificador extranjero». Si la etiqueta es ambigua (por ejemplo, «Identificación tributaria»), se propone el identificador del país del cliente.

## Datos bancarios

Se llenan solo cuando la plantilla los pide de forma explícita. Nunca van en el borrador de correo.

## Soportes

Cada soporte del repositorio tiene su fecha de vigencia (`vigencia_hasta`):

- Un soporte con vigencia anterior a la fecha de referencia está **vencido** y bloquea el paquete: hay que conseguir uno nuevo.
- Un soporte que el cliente exige y no está en el repositorio está **ausente** y también bloquea el paquete.
- Un soporte sin fecha de vigencia (como el RUT) no vence.

El paquete queda **listo para firma** solo si el formulario está generado y no hay soportes vencidos ni ausentes. Los campos faltantes y por confirmar no bloquean, pero la analista los revisa antes de la firma.

## Formatos de salida

- **Excel (xlsx):** cada etiqueta y su valor van en la hoja y la celda que indica la plantilla del cliente.
- **PDF:** se genera un PDF con todos los campos, cada uno con su etiqueta y su valor, en el orden de la plantilla.
- **Portal web:** no se automatiza. Los valores quedan listos para copiar en `valores-portal.md`; una persona entra al portal con las credenciales, copia los valores, carga los soportes y hace clic en «Enviar».

## Qué queda en out/

- `out/<caso>/formulario.xlsx`, `formulario.pdf` o `valores-portal.md`.
- `out/<caso>/paquete/`: el formulario, las copias de los soportes, `checklist.md` y `borrador-correo.md`.
- `out/<caso>/ENVIO-SIMULADO.md`: solo tras la confirmación explícita; en este reto «enviar» es escribir ese archivo.
- `out/<caso>/log.jsonl`: el registro de cada herramienta que se usó en el caso.
