# Reto 01 · Agente «Registro como proveedor»

Agente conversacional que prepara el registro de Periferia IT Group como proveedor ante un cliente: lee la solicitud, llena el formulario (Excel o PDF) con el repositorio maestro, arma el paquete para la firma del representante legal y solo simula el envío tras una confirmación explícita.

La interfaz tiene tres partes:

- **Chat con el agente**, con cada paso que da (herramienta, argumentos y resultado) y la confirmación del envío resaltada.
- **Expediente del caso**, que muestra las cuatro funcionalidades del reto con su resultado: lectura de la solicitud, cruce con el repositorio maestro (cada campo con su valor y su origen), llenado del formulario (con vista previa del Excel o del PDF) y paquete para firma (soportes, checklist y borrador). Desde ahí se firma, dibujando la firma o con un clic, y se pide el envío.
- **Consola de consumo**, en fondo negro, con el modelo que respondió y, por cada interacción, los tokens y los dólares de entrada y de salida.

- **Link de prueba:** https://reto-01-periferia.onrender.com
- **Clave de acceso al link:** `periferia-4127hcghm1` (el chat la pide al entrar).
- **Planteamiento de la solución:** [SOLUCION.md](SOLUCION.md).

## Levantar en local

Requiere [Bun](https://bun.sh) 1.4 o superior.

```bash
bun install
cp .env.example .env    # y escribe OPENROUTER_API_KEY
bun run dev             # front y backend en http://localhost:3000
```

## Verificación sin modelo

```bash
bun install && bun run demo.ts
```

Procesa los cuatro casos de `fixtures/reto-01/casos/` llamando directamente a las herramientas, con la fecha de referencia fija 2026-09-03, y deja el resultado en `out/`. No necesita ninguna clave y da lo mismo en cada ejecución (salvo las horas de los registros).

## Variables de entorno

| Variable | Obligatoria | Uso |
|---|---|---|
| `OPENROUTER_API_KEY` | Para el chat | Clave de OpenRouter. Solo vive en el backend. |
| `LLM_MODELO` | No | Modelo en OpenRouter. Por defecto, `anthropic/claude-sonnet-5.5`. |
| `LLM_ESFUERZO` | No | Esfuerzo de razonamiento: `low`, `medium` o `high`. Vacío deja el del proveedor. |
| `CLAVE_ACCESO` | No | Si se define, el chat pide esta clave antes de hablar con el agente. |
| `MAX_ITERACIONES` | No | Tope de vueltas modelo → herramientas por turno (25). |
| `MAX_TOKENS_SESION` | No | Tope de tokens por sesión (400.000). |
| `LLM_MAX_TOKENS` | No | Tope de tokens por respuesta del modelo (8.000). |
| `LLM_TIMEOUT_MS` | No | Espera máxima por respuesta del proveedor (90.000 ms). |
| `PORT` | No | Puerto del servidor (3000). |

## API

| Método | Ruta | Cuerpo y respuesta |
|---|---|---|
| `POST` | `/api/chat` | `{ sessionId, message, confirmar? }` → `{ reply, toolCalls[], needsConfirmation, consumo }` |
| `GET` | `/api/sessions/:id` | Historial completo de la sesión |
| `GET` | `/api/health` | `{ ok: true, provider, model, acceso }`, sin claves |
| `GET` | `/api/casos` | Casos de `fixtures/` para la pantalla de inicio |
| `GET` | `/api/casos/:caso/archivos` | Archivos que generaron las herramientas en `out/<caso>/` |
| `GET` | `/api/archivo?ruta=out/…` | Un archivo de `out/` (nunca de otra carpeta) |
| `GET` | `/api/excel?ruta=out/….xlsx` | El Excel generado como tabla, para la vista previa |
| `GET` | `/api/casos/:caso/firma` | Si se puede firmar, quién firma y la firma hecha |
| `POST` | `/api/casos/:caso/firma` | `{ metodo: "dibujada" \| "clic", imagen?, sessionId? }` → firma el formulario del paquete |

Si `CLAVE_ACCESO` está definida, todas las rutas de `/api/` menos `/api/health` exigen la cabecera `x-clave-acceso`. `confirmar: true` es lo que envía el botón «Confirmar envío» del chat. `consumo` trae, por turno, el modelo y el proveedor que respondieron, las llamadas, la duración y los tokens y dólares de entrada y de salida que informa OpenRouter.

La firma no es una herramienta del agente: solo la dispara la persona desde el expediente. Agrega al formulario una hoja de firma (página nueva en el PDF, hoja «Firma» en el Excel) con el firmante del maestro, la fecha y un código de verificación, y deja `formulario-firmado.*` en el paquete. Es una firma electrónica simple para el reto, no una firma digital con certificado.

## Comandos

| Comando | Qué hace |
|---|---|
| `bun run dev` | Levanta front y backend con recarga automática |
| `bun run start` | Levanta front y backend |
| `bun run demo.ts` | Verificación sin modelo |
| `bun test` | Pruebas de herramientas, ciclo del agente, rutas HTTP, firma y módulo |
| `bun run typecheck` | Revisión de tipos (TypeScript estricto, sin `any`) |
| `bun run modulo` | Regenera `modulo/` desde las fuentes de la aplicación |
| `bun run modulo --verificar` | Falla si `modulo/` no coincide con las fuentes |

## Estructura

```
agent/prompt.md                      comportamiento: el prompt de sistema
src/knowledge/registro-proveedor.md  conocimiento del proceso
src/tools/proveedor.ts               ejecución: las cinco herramientas (zod)
src/agente/                          ciclo del agente, confirmación, sesiones y registro de herramientas
src/llm/adapter.ts                   interfaz propia con el proveedor del modelo
src/llm/openrouter.ts                implementación para OpenRouter
src/http/app.ts                      rutas HTTP (API del chat y de la interfaz)
src/firma/firmar.ts                  firma del representante legal (solo la dispara la persona)
src/casos.ts, src/archivos.ts        lista de casos y archivos generados, sin salir de out/
src/server.ts                        arranque del servidor
web/                                 front sin dependencias: chat, expediente, firma, visor y consola
modulo/                              bonus: el agente empaquetado para otras plataformas
fixtures/                            datos entregados por Periferia (solo lectura)
demo.ts                              verificación sin modelo
tests/                               pruebas con bun test
```

## Despliegue

El repositorio incluye `Dockerfile` y `render.yaml`. En Render: New → Blueprint → este repositorio, y completar `OPENROUTER_API_KEY` y `CLAVE_ACCESO` cuando los pida. El plan gratis se duerme cuando nadie lo usa y tarda cerca de un minuto en despertar, así que conviene abrir el link un rato antes de la defensa.

## Módulo reutilizable

`modulo/` sigue el formato de agentes de OpenCode: `agent.md` (frontmatter con `mode: primary` y permisos `edit` y `bash` en `deny`, y el prompt como cuerpo), `tools/proveedor.ts` (las mismas herramientas; en OpenCode quedan como `proveedor_<export>`) y `skill/registro-proveedor/SKILL.md` (el conocimiento del proceso). Se genera con `bun run modulo` y una prueba falla si se aparta de las fuentes de la aplicación. Las herramientas necesitan `zod`, `exceljs` y `pdf-lib` instalados en el proyecto que las cargue.
