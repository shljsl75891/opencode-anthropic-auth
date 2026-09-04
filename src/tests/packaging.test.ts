import { expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { $ } from 'bun'

const RELATIVE_IMPORT = /from ['"](\.[^'"]+)['"]/g

function relativeImports(source: string): string[] {
  return [...source.matchAll(RELATIVE_IMPORT)].map(
    (match) => match[1] as string,
  )
}

// Walks the relative-import graph starting from an entry file and returns
// every file it transitively reaches. Bare specifiers (npm packages,
// node:*) are skipped — those are covered by "dependencies", not "files".
async function collectRelativeImportGraph(entry: string): Promise<Set<string>> {
  const visited = new Set<string>()
  const queue = [entry]

  while (queue.length > 0) {
    const path = queue.pop() as string
    if (visited.has(path)) continue
    visited.add(path)

    const source = await Bun.file(path).text()
    const dir = path.slice(0, path.lastIndexOf('/'))
    for (const spec of relativeImports(source)) {
      const resolved = resolve(dir, spec)
      if (!visited.has(resolved)) queue.push(resolved)
    }
  }

  return visited
}

test('every runtime import reachable from src/tui.tsx is included in the published package', async () => {
  const graph = await collectRelativeImportGraph(
    resolve(import.meta.dir, '../tui.tsx'),
  )

  const pack = await $`npm pack --dry-run --json`.quiet()
  const [manifest] = JSON.parse(pack.stdout.toString()) as [
    { files: { path: string }[] },
  ]
  const repoRoot = resolve(import.meta.dir, '../..')
  const publishedFiles = new Set(
    manifest.files.map((file) => resolve(repoRoot, file.path)),
  )

  for (const path of graph) {
    expect(publishedFiles.has(path)).toBe(true)
  }
})
