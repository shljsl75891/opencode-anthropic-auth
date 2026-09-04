import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { QuotaSnapshot } from './quota-headers.ts'

export function getQuotaStateFile(): string {
  return (
    process.env.OPENCODE_ANTHROPIC_AUTH_QUOTA_FILE ??
    join(tmpdir(), 'sahiljassal-opencode-anthropic-auth', 'quota.json')
  )
}

// Single-writer, single-reader (server plugin -> TUI plugin, separate
// processes). Write-to-temp-then-rename makes the file atomic to readers —
// renameSync on the same filesystem is a single directory-entry swap, so a
// concurrent read never observes a partially written file.
export function writeQuotaState(
  snapshot: QuotaSnapshot,
  file: string = getQuotaStateFile(),
): void {
  mkdirSync(dirname(file), { recursive: true })
  const tmpFile = `${file}.${process.pid}.tmp`
  writeFileSync(tmpFile, JSON.stringify(snapshot))
  renameSync(tmpFile, file)
}

export function readQuotaState(
  file: string = getQuotaStateFile(),
): QuotaSnapshot | undefined {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as QuotaSnapshot
  } catch {
    return undefined
  }
}
