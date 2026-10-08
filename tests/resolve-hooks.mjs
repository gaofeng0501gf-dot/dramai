import { existsSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src')
const EXTS = ['.ts', '.tsx', '/index.ts', '/index.tsx']

function withExt(base) {
  if (existsSync(base) && path.extname(base)) return base
  for (const ext of EXTS) if (existsSync(base + ext)) return base + ext
  return null
}

export async function resolve(specifier, context, next) {
  if (specifier.startsWith('@/')) {
    const file = withExt(path.join(SRC, specifier.slice(2)))
    if (file) return { url: pathToFileURL(file).href, shortCircuit: true }
  }
  if (
    (specifier.startsWith('./') || specifier.startsWith('../')) &&
    context.parentURL?.startsWith('file:')
  ) {
    const base = path.resolve(path.dirname(fileURLToPath(context.parentURL)), specifier)
    if (!path.extname(base)) {
      const file = withExt(base)
      if (file) return { url: pathToFileURL(file).href, shortCircuit: true }
    }
  }
  return next(specifier, context)
}
