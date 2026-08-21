import { build } from 'esbuild'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const root = new URL('../', import.meta.url)
const lib = new URL('lib/', root)

await rm(lib, { recursive: true, force: true })
await mkdir(lib, { recursive: true })

await build({
  entryPoints: [new URL('src/index.ts', root).pathname],
  outfile: new URL('index.js', lib).pathname,
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  external: ['@deepseek-ai/cordis'],
  sourcemap: true,
})

await build({
  entryPoints: [new URL('src/shared/protocol.ts', root).pathname],
  outfile: new URL('shared/protocol.js', lib).pathname,
  bundle: false,
  format: 'esm',
  platform: 'neutral',
  target: 'es2023',
})

const clientTemp = new URL('client.cjs', lib)
await build({
  entryPoints: [new URL('src/client/index.ts', root).pathname],
  outfile: clientTemp.pathname,
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: ['chrome109', 'safari16'],
  jsx: 'automatic',
  external: ['react', 'react/jsx-runtime'],
})

const clientBundle = await readFile(clientTemp, 'utf8')
const wrapped = `window.__ModuleLoader__.load({\n  id: 'dsh-voice-refine',\n  factory: (require) => {\n    const module = { exports: {} };\n    const exports = module.exports;\n${indent(clientBundle, 4)}\n    return module.exports;\n  },\n});\n`
await writeFile(new URL('client.js', lib), wrapped)
await rm(clientTemp)

await execFileAsync(process.execPath, [
  new URL('../node_modules/typescript/bin/tsc', import.meta.url).pathname,
  '-p',
  new URL('../tsconfig.types.json', import.meta.url).pathname,
])

function indent(text, spaces) {
  const prefix = ' '.repeat(spaces)
  return text.split('\n').map(line => prefix + line).join('\n')
}
