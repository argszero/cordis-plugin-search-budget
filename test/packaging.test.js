/**
 * Packaging contract: every package the published artifact imports at runtime
 * must be declared in the manifest.
 *
 * 0.1.0 shipped `import z from '@deepseek-ai/schemastery'` in `src/index.ts`
 * while declaring no `dependencies` block at all. The suite never noticed,
 * because the repo's own `node_modules` resolves `schemastery` transitively off
 * a sibling devDependency and the bundler hoists it. A consumer gets the
 * artifact, not the repo:
 *
 *   Error [ERR_MODULE_NOT_FOUND]: Cannot find package
 *   '@deepseek-ai/schemastery' imported from .../lib/index.js
 *
 * The lesson is the general one: a dependency that only resolves in the
 * author's tree is not a declared dependency, and "it tests green here" is not
 * evidence about the artifact.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const src = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')

/** Bare specifiers imported as values (not `import type`) in a source file. */
function runtimeImports(source) {
  const specifiers = new Set()
  // `import x from 'y'`, `import { a } from 'y'`, `import * as x from 'y'`,
  // `import 'y'` — but not `import type ... from 'y'`.
  for (const match of source.matchAll(/(^|\n)\s*import\s+(?!type\s)([^'"]*?)from\s+'([^']+)'/g)) {
    specifiers.add(match[3])
  }
  return [...specifiers]
}

test('every runtime import is declared as a dependency or a peer', () => {
  const declared = new Set([
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.peerDependencies ?? {}),
  ])
  const runtime = runtimeImports(src)
  assert.ok(runtime.length > 0, 'expected the source to import something')
  for (const specifier of runtime) {
    assert.ok(
      declared.has(specifier),
      `src/index.ts imports "${specifier}" for value, but the manifest declares it neither `
      + 'as a dependency nor as a peer — a consumer would get ERR_MODULE_NOT_FOUND',
    )
  }
})

test('the value-import of the config schema library is a real dependency', () => {
  // Named separately so the failure says which package regressed, and because
  // this is the one that actually shipped broken.
  assert.ok(runtimeImports(src).includes('@deepseek-ai/schemastery'))
  assert.ok(
    pkg.dependencies?.['@deepseek-ai/schemastery'],
    'a value import must be a `dependencies` entry, not a devDependency: devDependencies '
    + 'are not installed for consumers',
  )
})

test('the published build is the entry point the manifest advertises', () => {
  assert.equal(pkg.main, 'lib/index.js')
  assert.equal(pkg.exports['.'].default, './lib/index.js')
  assert.ok(pkg.files.includes('lib/index.js'))
})
