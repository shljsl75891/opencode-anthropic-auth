import { expect, test } from 'bun:test'
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
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

test('the packed tui entrypoint imports from an unrelated working directory', async () => {
  // The host imports this file with its cwd set to the user's project, not to
  // the installed package. Bun resolves a tsconfig.json (and with it
  // jsxImportSource) relative to cwd, so shipping one alongside the source
  // doesn't help — only a per-file pragma does. Reproduce that exact shape:
  // pack, unpack somewhere else, and import from a cwd that knows nothing
  // about either.
  const workspace = mkdtempSync(join(tmpdir(), 'packaging-test-'))
  try {
    await $`npm pack --pack-destination ${workspace}`.quiet()
    const [tarball] = readdirSync(workspace).filter((f) => f.endsWith('.tgz'))
    await $`tar -xzf ${join(workspace, tarball as string)} -C ${workspace}`.quiet()

    const pkg = join(workspace, 'package')
    symlinkSync(
      resolve(import.meta.dir, '../../node_modules'),
      join(pkg, 'node_modules'),
    )

    const cwd = join(workspace, 'unrelated-cwd')
    mkdirSync(cwd)
    const entry = join(pkg, 'src/tui.tsx')
    const probe =
      await $`bun -e ${`import m from ${JSON.stringify(entry)}; console.log(m.id, typeof m.tui)`}`
        .cwd(cwd)
        .quiet()

    expect(probe.stdout.toString().trim()).toBe(
      '@sahiljassal/opencode-anthropic-auth function',
    )
  } finally {
    rmSync(workspace, { recursive: true, force: true })
  }
}, 60_000)
