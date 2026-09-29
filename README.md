# Reto 01 · Agente «Registro como proveedor»

Agente conversacional que prepara el registro de Periferia IT Group como proveedor ante un cliente: lee la solicitud, llena el formulario (Excel o PDF) con el repositorio maestro, arma el paquete para la firma del representante legal y solo simula el envío tras una confirmación explícita.

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
| `POST` | `/api/chat` | `{ sessionId, message, confirmar? }` → `{ reply, toolCalls[], needsConfirmation }` |
| `GET` | `/api/sessions/:id` | Historial completo de la sesión |
| `GET` | `/api/health` | `{ ok: true, provider, model, acceso }`, sin claves |

Si `CLAVE_ACCESO` está definida, `/api/chat` y `/api/sessions/:id` exigen la cabecera `x-clave-acceso`. `confirmar: true` es lo que envía el botón «Confirmar» del chat.

## Comandos

| Comando | Qué hace |
|---|---|
| `bun run dev` | Levanta front y backend con recarga automática |
| `bun run start` | Levanta front y backend |
| `bun run demo.ts` | Verificación sin modelo |
| `bun test` | Pruebas de herramientas, ciclo del agente y módulo |
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
src/server.ts                        API HTTP y servidor del front
web/                                 front del chat (HTML, CSS y JavaScript sin dependencias)
modulo/                              bonus: el agente empaquetado para otras plataformas
fixtures/                            datos entregados por Periferia (solo lectura)
demo.ts                              verificación sin modelo
tests/                               pruebas con bun test
```

## Despliegue

El repositorio incluye `Dockerfile` y `render.yaml`. En Render: New → Blueprint → este repositorio, y completar `OPENROUTER_API_KEY` y `CLAVE_ACCESO` cuando los pida. El plan gratis se duerme cuando nadie lo usa y tarda cerca de un minuto en despertar, así que conviene abrir el link un rato antes de la defensa.

## Módulo reutilizable

`modulo/` sigue el formato de agentes de OpenCode: `agent.md` (frontmatter con `mode: primary` y permisos `edit` y `bash` en `deny`, y el prompt como cuerpo), `tools/proveedor.ts` (las mismas herramientas; en OpenCode quedan como `proveedor_<export>`) y `skill/registro-proveedor/SKILL.md` (el conocimiento del proceso). Se genera con `bun run modulo` y una prueba falla si se aparta de las fuentes de la aplicación. Las herramientas necesitan `zod`, `exceljs` y `pdf-lib` instalados en el proyecto que las cargue.
