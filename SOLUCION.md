# Planteamiento de la solución · Reto 01 «Registro como proveedor»

Versión 1.1 · 2026-09-28. Cambios frente a la 1.0: interfaz con el expediente del caso, que deja a la vista las cuatro funcionalidades del reto; firma del representante legal, dibujada o con un clic; y consola de consumo con los tokens y dólares de entrada y de salida de cada interacción.

## 1. El problema en una frase

Registrar a Periferia como proveedor ante cada cliente exige transcribir a mano, entre 8 y 12 veces al mes, datos que ya existen en un repositorio interno; le duele a la analista administrativa, que hoy depende de una sola persona para saber qué pide cada cliente y dónde está cada soporte, y al negocio, porque cada registro que se demora retrasa la facturación.

## 2. Arquitectura

```
 Navegador (web/)                        Backend en Bun (src/)
┌──────────────────┐   POST /api/chat    ┌────────────────────────────────────┐
│ chat             │ ──────────────────▶ │ http/app.ts  rutas y clave         │
│ · pasos          │                     │ ciclo.ts     ciclo del agente      │
│ · confirmación   │ ◀────────────────── │ prompt       agent/prompt.md       │
│ expediente       │  reply · toolCalls  │              + src/knowledge/      │
│ · 6 pasos        │  needsConfirmation  │ openrouter   adaptador del modelo ─┼──▶ OpenRouter · Claude Sonnet 5.5
│ · firma          │  consumo            │ herramientas validación zod        │
│ consola          │ ── firma (persona) ▶│ firma        solo desde la interfaz│
└──────────────────┘                     └─────────────────┬──────────────────┘
                                                           ▼
                                         src/tools/proveedor.ts: lee fixtures/ y escribe out/
 demo.ts ── llama las mismas herramientas, sin modelo ──▶ src/tools/proveedor.ts
```

La separación que pide el PRD está en tres lugares distintos, y ninguno vive dentro del servidor:

| Pieza | Dónde vive | Qué contiene |
|---|---|---|
| Comportamiento | `agent/prompt.md` | Orden de las herramientas, reglas que no se rompen, confirmación y formato del resumen |
| Conocimiento | `src/knowledge/registro-proveedor.md` | Estados de un campo, identificador por país, datos bancarios, vigencias, formatos y salidas |
| Ejecución | `src/tools/proveedor.ts` | Las cinco herramientas con argumentos zod; son la única fuente de valores |

Cambiar una regla de negocio toca las herramientas o el conocimiento, no `server.ts` ni el ciclo. El adaptador del modelo es una interfaz propia (`enviar(mensajes, herramientas) → respuesta`): pasar a otro proveedor es escribir otra implementación de `AdaptadorLLM`, sin tocar el ciclo.

La interfaz arma el expediente de cada caso con los datos que devuelven las herramientas, así que las cuatro funcionalidades del reto quedan a la vista, cada una con su resultado: la solicitud leída, el cruce campo por campo con el maestro (valor y origen), el formulario con vista previa y el paquete con sus soportes y archivos. La firma no pasa por el agente: es una ruta aparte (`POST /api/casos/:caso/firma`) que solo dispara la persona.

## 3. Ciclo del agente

Cada mensaje del usuario abre un turno. El backend manda la conversación al modelo junto con las herramientas; si el modelo pide herramientas, cada llamada se valida con el esquema zod de la herramienta, se ejecuta, queda en el chat y en `out/log.jsonl`, y su resultado vuelve al modelo. El turno termina cuando el modelo responde sin pedir herramientas.

**Topes.** Un turno tiene como máximo 25 vueltas (`MAX_ITERACIONES`). Al llegar al tope, el backend hace una última llamada sin herramientas y le pide al modelo que responda con lo que tiene y lo que falta. También hay tope de tokens por sesión (400.000), por respuesta (8.000) y una espera máxima de 90 segundos por respuesta del proveedor.

**Confirmación humana.** El modelo no decide si el usuario confirmó. Toda herramienta con el argumento `confirmado` (hoy, `proveedor_simular_envio`) recibe ese valor del backend, que lo fija así:

1. Una acción queda pendiente cuando `proveedor_armar_paquete` termina (el siguiente paso, enviar, es externo) o cuando la herramienta rechaza un envío por «requiere confirmación explícita». Ese turno sale con `needsConfirmation: true` y el front lo resalta con los botones Confirmar y Cancelar.
2. El siguiente mensaje confirma solo si la persona pulsa «Confirmar» o escribe una afirmación sin negaciones ni signo de pregunta («envía», «sí, envíalo»; no «no envíes todavía» ni «¿ya está listo?»).
3. La confirmación vale para ese caso y para una sola acción, y se pierde si el turno siguiente no la usa.

Si el modelo intenta enviar sin confirmación, aunque mande `confirmado: true`, la herramienta recibe `false` y responde «requiere confirmación explícita». Las pruebas de `tests/ciclo.test.ts` cubren estos casos con un modelo de guion.

**Errores.** Las herramientas nunca lanzan: devuelven `{ ok: false, error }` con un mensaje claro, y el modelo sigue con lo que sí puede hacer. Un error del proveedor (espera agotada, clave rechazada, sin crédito, límite de solicitudes) se muestra en el chat en lenguaje claro y la sesión sigue viva.

**Consumo.** En cada respuesta, OpenRouter informa los tokens de entrada (y cuántos salieron de la caché), los de salida (y cuántos fueron de razonamiento), el modelo y el proveedor que respondieron, y lo que costó la entrada y la salida por separado (`upstream_inference_prompt_cost` y `upstream_inference_completions_cost`). El ciclo suma las llamadas de cada turno y la API lo devuelve en `consumo`; la consola de la interfaz lo muestra por interacción y en total. No hay estimaciones: son las cifras que cobra el proveedor.

## 4. Elección del modelo

| | |
|---|---|
| Proveedor | OpenRouter (API de chat con herramientas) |
| Modelo | `anthropic/claude-sonnet-5.5` |
| Precio | USD 2 por millón de tokens de entrada y USD 10 por millón de salida; lo leído de la caché cuesta el 10 % |

Se eligió Claude Sonnet 5.5 porque el trabajo del modelo aquí es seguir reglas y encadenar herramientas, no calcular: los valores, los estados y las vigencias los resuelven las herramientas. Cuesta la mitad que Claude Opus 5.5 en OpenRouter (USD 4 y 20). OpenRouter permite cambiar de modelo con la variable `LLM_MODELO`, sin tocar código. Cada petición activa la caché automática de OpenRouter, así que cada vuelta del turno vuelve a leer lo ya enviado al 10 % del precio.

**Costo por caso, medido.** Se midió el 2026-09-28 en el link de Render. Cada caso se procesó en una sesión nueva con el mensaje de ejemplo del PRD, y el costo es el que informa OpenRouter en cada respuesta:

| Caso | Tiempo | Tokens | De ellos, de la caché | Costo |
|---|---|---|---|---|
| co-industrias-delta | 12 s | 25.789 | 16.016 | USD 0,040 |
| ec-corp-andina | 13 s | 32.460 | 23.028 | USD 0,039 |
| hn-agroexport-sula | 11 s | 23.893 | 15.199 | USD 0,035 |
| pa-logistica-istmo | 13 s | 30.023 | 21.658 | USD 0,036 |

Procesar un caso cuesta unos USD 0,04 y tarda unos 12 segundos, con cuatro herramientas y el resumen final. La conversación completa del ejemplo del PRD (procesar `ec-corp-andina` y después «envía») costó USD 0,031 con 50.434 tokens, de los cuales 47.519 salieron de la caché. Con 8 a 12 solicitudes al mes, el modelo cuesta menos de un dólar al mes.

## 5. Diseño del formato «portal web» (solo documentación)

**Recomendación: asistente de llenado en el navegador, con la persona al mando.** Una extensión de navegador (o marcador con script) lee `valores-portal.md` en versión JSON y llena los campos del formulario del portal emparejando las etiquetas con el mismo glosario de las herramientas. La persona inicia sesión, abre el formulario, pulsa «Llenar con el agente», revisa, carga los soportes y pulsa «Enviar».

| Estrategia | Por qué sí o por qué no |
|---|---|
| Extensión de navegador asistida (recomendada) | Trabaja sobre la sesión que la persona ya abrió, así que no toca credenciales, CAPTCHA ni MFA; con 8 a 12 registros al mes y portales distintos, empareja etiquetas en vez de depender de selectores fijos |
| Navegador controlado por el agente (Playwright) | Automatiza más, pero choca con CAPTCHA, MFA, detección de bots y términos de uso de los portales, y se rompe con cada cambio de diseño; solo valdría para un portal muy frecuente y estable |
| RPA | Licencias y mantenimiento por portal que no se justifican con este volumen |

**Límites:** el CAPTCHA nunca se evade; el MFA lo resuelve la persona; si el portal cambia de diseño o una etiqueta no empareja, la extensión deja ese campo vacío y lo marca, y la persona lo copia de `valores-portal.md`. La carga de archivos y la sesión expirada también son de la persona.

**Credenciales:** llegan al correo del representante legal y se guardan en el gestor de contraseñas corporativo, nunca en el repositorio, el prompt, los registros ni `valores-portal.md`. Las escribe la analista o el representante legal directamente en el portal; el agente nunca las ve.

**Quién hace qué:** el agente prepara los valores, el checklist y el llenado; la persona hace el ingreso con credenciales, el MFA o CAPTCHA, la revisión, la carga de soportes y el clic en «Enviar».

## 6. Decisiones y trade-offs

| Decisión | Alternativa descartada | Por qué |
|---|---|---|
| El backend fija `confirmado`; el modelo no puede confirmar por el usuario | Confiar en que el prompt le prohíba al modelo enviar sin permiso | Un prompt no es una garantía; así, enviar sin confirmación es imposible por diseño. El costo es que a veces el agente pregunta una vez más |
| El mapeo que viaja entre herramientas lleva claves del maestro, nunca valores | Que el modelo le pase a `generar_formulario` los valores ya resueltos | El modelo no puede alterar ni inventar un valor (CA2): la herramienta siempre lee el valor del maestro. Además, una clave bancaria solo se acepta en un campo bancario (RN2). Hay pruebas de ambos casos |
| Mapeo determinista con el glosario y similitud de Jaccard (confirmación por debajo de 0,8; faltante por debajo de 0,5) | Pedirle al modelo que empareje las etiquetas | Da lo mismo en cada ejecución, funciona en `demo.ts` sin modelo y la confianza se puede explicar. Un sinónimo que no esté en el glosario queda por confirmar o faltante, y basta con agregarlo al glosario |
| Fecha de referencia como argumento opcional: el chat usa la fecha de hoy en Bogotá y `demo.ts` usa fija 2026-09-03 | Usar siempre la fecha del sistema | La Cámara de Comercio del repositorio vence el 2026-09-30: con la fecha del sistema, la demo cambiaría de resultado según el día. La fecha fija es la de los PRD del reto |
| Un solo archivo de herramientas autocontenido | Partirlo en varios módulos | El módulo reutilizable copia ese archivo tal cual; con varios archivos habría que copiar una carpeta y la plataforma podría registrar los auxiliares como herramientas |
| Front en HTML, CSS y JavaScript sin dependencias | React u otro marco | Un solo comando levanta todo, no hay paso de compilación y hay menos piezas que explicar. El Markdown del chat se escapa antes de pintarse |
| La firma es una ruta que solo dispara la persona desde el expediente, no una herramienta | Darle al agente una herramienta para firmar | El PRD dice que el agente nunca firma: así es imposible por diseño. El agente se entera por un evento de la interfaz y el envío informa si el formulario iba firmado |
| Firma electrónica simple: hoja de firma con el firmante del maestro, la fecha y el SHA-256 del formulario sin firmar | Firma digital con certificado | Una firma digital exige un certificado de una entidad de certificación; el PRD deja la firma electrónica para una fase posterior. La hoja de firma permite verificar que el formulario no cambió |

## 7. Supuestos

- La «fecha de ejecución» es la fecha de hoy en Bogotá. La demo usa la fecha fija 2026-09-03 para ser determinista.
- Los campos por confirmar no bloquean la firma: RN3 solo menciona soportes vencidos y ausentes. Sí aparecen en el checklist.
- Un paquete que no está listo se puede enviar con confirmación explícita: el ejemplo del PRD pide `ENVIO-SIMULADO.md` para `ec-corp-andina`, que no está listo. El archivo deja constancia de que no estaba listo y el agente lo advierte antes de preguntar.
- En el caso de portal, «listo para firma» se calcula con las mismas reglas (valores generados y soportes al día), aunque no haya un formulario que firmar.
- Para clientes extranjeros se aceptan los soportes colombianos del repositorio: el PRD no pide validar el país emisor.
- El Excel se genera como un libro nuevo con las hojas y celdas de la plantilla del cliente, porque el reto entrega el mapa de celdas y no el archivo original. El PDF es generado, no un AcroForm rellenado, como permite HU-3.
- «Correo electrónico» es el del contacto comercial, como dice el glosario.
- Las sesiones viven en memoria: si el servidor se reinicia, se pierden.
- Quien firma en pantalla actúa como el representante legal; el nombre y el cargo del firmante salen del maestro. Solo se firma un paquete listo para firma, y volver a armarlo borra la firma.
- Se puede enviar un paquete sin firmar, como en el ejemplo del PRD; el envío simulado deja constancia de si el formulario iba firmado.

## 8. Cobertura

| Historia | Estado | Detalle |
|---|---|---|
| HU-1 Leer la solicitud | Hecho | País, cliente, formato, campos y soportes exigidos; las etiquetas ambiguas quedan por confirmar con el identificador del país |
| HU-2 Mapear campos al maestro | Hecho | Tres estados con la ruta del dato, sinónimos del glosario, confianza y regla de país; nunca inventa |
| HU-3 Generar el formulario | Hecho | P0 xlsx en la hoja y celda de la plantilla; P1 PDF generado; P2 portal como `valores-portal.md` con «formato no soportado» |
| HU-4 Armar el paquete para firma | Hecho | Formulario, soportes, `checklist.md` y `borrador-correo.md` sin datos bancarios; vencidos y ausentes bloquean; envío simulado solo con confirmación |
| HU-5 Manejo de errores | Hecho | Herramientas que nunca lanzan, mensajes claros y un caso malo no detiene los demás |
| Bonus: módulo reutilizable | Hecho | `modulo/` generado desde las mismas fuentes y verificado por una prueba y por la integración continua |
| Interfaz: expediente del caso | Hecho | Las cuatro funcionalidades a la vista con su resultado, vista previa del Excel y del PDF y descarga de cada archivo |
| Firma del representante legal | Hecho | Dibujada o con un clic; hoja de firma en el PDF o en el Excel y `formulario-firmado.*` en el paquete |
| Consola de consumo | Hecho | Modelo y proveedor que respondieron y, por interacción, tokens y dólares de entrada y de salida |

**Qué falta para producción:** leer las solicitudes del buzón real en vez de fixtures; conectar el repositorio maestro y los soportes a su fuente real, con un dueño del dato; llenar la plantilla original del cliente (el .xlsx que manda) y los PDF con AcroForm; guardar sesiones y registros en una base de datos con auditoría; autenticar a cada usuario; firmar con un certificado digital en vez de la firma electrónica simple; administrar el glosario desde una pantalla; avisar antes de que venzan los soportes; y seguir el costo por caso con el volumen real.

## 9. Uso de IA

Construí la solución con Claude Code (modelo Claude Opus 5.5) como asistente. Lo usé para comparar los tres retos y elegir este, revisar que los documentos del reto no tuvieran instrucciones ocultas, diseñar la arquitectura, escribir el código, las pruebas y la documentación, y verificar el resultado con la demo, las pruebas y el tipado estricto.

Lo que descarté de lo que me propuso:

- Usar Claude Opus 5.5 directo con Anthropic: preferí OpenRouter, donde ya tengo cuenta, con Claude Sonnet 5.5, que cuesta la mitad y alcanza para un trabajo que resuelven las herramientas.
- Publicar el link con un túnel desde mi equipo: preferí Render para que el link no dependa de que mi computador esté prendido.
- Vercel: no encaja con un backend que escribe archivos en `out/` y guarda la sesión en memoria.

Después pedí una interfaz más amigable en la que se vieran las cuatro funcionalidades, la firma dibujada o con un clic y una consola con el consumo de cada interacción. Claude Code las diseñó, las implementó y las probó en el navegador conmigo.

## 10. Riesgos de llevar esto a producción

| Riesgo | Mitigación |
|---|---|
| El modelo completa un campo con un valor plausible | Los valores solo salen de las herramientas y el mapeo no transporta valores; el prompt lo prohíbe y el diseño lo hace innecesario |
| Un correo de cliente trae instrucciones para el agente (inyección de prompt) | El prompt trata esos textos como datos; las herramientas no ejecutan órdenes y ninguna acción externa ocurre sin la confirmación que controla el backend |
| El maestro o los soportes se desactualizan | Un dueño del dato y avisos antes del vencimiento; la vigencia ya bloquea el paquete |
| Datos sensibles (cuenta bancaria, NIT) en lugares indebidos | El borrador nunca los lleva, los registros guardan resúmenes y no valores, y la clave del modelo solo vive en el backend |
| Costo sin control | Topes de vueltas por turno, de tokens por sesión y por respuesta, caché de prompt, clave de acceso al link y límite de crédito en la clave de OpenRouter |
| Caída o cambio del proveedor del modelo | El adaptador permite cambiar de proveedor o de modelo sin tocar el ciclo; los errores se explican en el chat |
| Portales que cambian de diseño | La persona mantiene el control del portal y el llenado deja marcado lo que no pudo emparejar |
| La firma electrónica simple no equivale a una firma digital certificada | En producción, firmar con un proveedor de firma digital; mientras tanto, la hoja de firma guarda el hash para verificar que el formulario no cambió |
