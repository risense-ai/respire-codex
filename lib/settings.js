import { readFile, mkdir, writeFile, rename, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'

export const settingsPath = () => join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'respire', 'settings.json')

export async function memoryStatus(file = settingsPath()) {
  let saved
  try {
    const value = JSON.parse(await readFile(file, 'utf8'))
    if (!value || Array.isArray(value) || typeof value.showMemoryStatus !== 'boolean') throw new SyntaxError()
    saved = value.showMemoryStatus
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error(error instanceof SyntaxError ? 'settings-invalid' : 'settings-unreadable')
  }
  return {
    showMemoryStatus: saved ?? (process.env.RESPIRE_MEMORY_STATUS !== '0'),
    source: saved === undefined ? (process.env.RESPIRE_MEMORY_STATUS === undefined ? 'default' : 'environment') : 'settings',
    path: file,
  }
}

export async function setMemoryStatus(enabled, file = settingsPath()) {
  if (typeof enabled !== 'boolean') throw new Error('invalid-setting-value')
  await mkdir(dirname(file), { recursive: true, mode: 0o700 })
  const temp = `${file}.${randomUUID()}.tmp`
  try {
    await writeFile(temp, JSON.stringify({ showMemoryStatus: enabled }) + '\n', { mode: 0o600 })
    await rename(temp, file)
  } finally {
    await unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error })
  }
  return memoryStatus(file)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const command = process.argv[2] ?? 'status'
    if (process.argv.length > 3 || !['status', 'on', 'off'].includes(command)) throw new Error('invalid-settings-command')
    console.log(JSON.stringify(command === 'status' ? await memoryStatus() : await setMemoryStatus(command === 'on')))
  } catch (error) {
    console.error(JSON.stringify({ error: error.message, path: settingsPath() }))
    process.exitCode = 1
  }
}
