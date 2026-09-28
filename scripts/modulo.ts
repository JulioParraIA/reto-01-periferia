/**
 * Empaqueta el agente como módulo reutilizable (bonus, sección 9.4 del PRD) desde las mismas
 * fuentes que usa la aplicación, para que nunca haya copias divergentes:
 *   agent/prompt.md               → modulo/agent.md (con frontmatter)
 *   src/tools/proveedor.ts        → modulo/tools/proveedor.ts (copia exacta)
 *   src/knowledge/*.md            → modulo/skill/registro-proveedor/SKILL.md (con frontmatter)
 *
 *   bun run modulo              regenera modulo/
 *   bun run modulo --verificar  falla si modulo/ no coincide con las fuentes
 */
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"

const RAIZ = path.resolve(import.meta.dir, "..")

const FRONTMATTER_AGENTE = `---
description: Prepara el registro de Periferia IT Group como proveedor ante clientes; lee la solicitud, llena el formulario desde el repositorio maestro y arma el paquete para firma sin enviar nada sin confirmación.
mode: primary
permission:
  edit: deny
  bash: deny
---

`

const FRONTMATTER_SKILL = `---
name: registro-proveedor
description: Reglas del proceso de registro de Periferia como proveedor (estados de los campos, identificador tributario por país, datos bancarios, vigencia de los soportes y formatos de salida). Úsala al procesar una solicitud de registro.
---

`

/** Git en Windows puede cambiar los finales de línea; se comparan siempre como \n. */
function normalizar(texto: string): string {
  return texto.replace(/\r\n/g, "\n")
}

export async function construirModulo(raiz = RAIZ): Promise<Map<string, string>> {
  const leer = async (...partes: string[]) => normalizar(await readFile(path.join(raiz, ...partes), "utf8"))
  return new Map([
    ["modulo/agent.md", FRONTMATTER_AGENTE + (await leer("agent", "prompt.md"))],
    ["modulo/tools/proveedor.ts", await leer("src", "tools", "proveedor.ts")],
    ["modulo/skill/registro-proveedor/SKILL.md", FRONTMATTER_SKILL + (await leer("src", "knowledge", "registro-proveedor.md"))],
  ])
}

/** Archivos de modulo/ que no coinciden con lo que saldría de las fuentes. */
export async function diferencias(raiz = RAIZ): Promise<string[]> {
  const distintos: string[] = []
  for (const [ruta, esperado] of await construirModulo(raiz)) {
    const actual = await readFile(path.join(raiz, ruta), "utf8").catch(() => null)
    if (actual === null || normalizar(actual) !== esperado) distintos.push(ruta)
  }
  return distintos
}

async function main(): Promise<void> {
  if (process.argv.includes("--verificar")) {
    const distintos = await diferencias()
    if (distintos.length > 0) {
      console.error(`modulo/ no coincide con las fuentes: ${distintos.join(", ")}. Corre «bun run modulo».`)
      process.exit(1)
    }
    console.log("modulo/ coincide con agent/prompt.md, src/tools/proveedor.ts y src/knowledge/.")
    return
  }
  for (const [ruta, contenido] of await construirModulo()) {
    await mkdir(path.dirname(path.join(RAIZ, ruta)), { recursive: true })
    await writeFile(path.join(RAIZ, ruta), contenido, "utf8")
    console.log(`escrito ${ruta}`)
  }
}

if (import.meta.main) await main()
