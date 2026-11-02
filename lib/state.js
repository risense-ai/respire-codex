import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, readdir, readFile, rename, rmdir, unlink, writeFile } from 'node:fs/promises'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

export const keyOf = text => createHash('sha256').update(text).digest('hex')

export async function withState(root, session, action) {
  const directory = join(root, 'sessions')
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const file = join(directory, `${keyOf(session)}.json`)
  const lock = `${file}.lock`
  const token = randomUUID()
  const owner = `owner-${process.pid}-${token}`
  const candidate = `${lock}.${owner}`
  await mkdir(candidate, { mode: 0o700 })
  let acquired = false
  try {
    await writeFile(join(candidate, owner), JSON.stringify({ version: 1, pid: process.pid, host: hostname(), token }), { mode: 0o600 })
    for (let attempt = 0; attempt < 20; attempt++) {
      const legacy = await lstat(lock).catch(error => { if (error.code !== 'ENOENT') throw error })
      if (legacy && !legacy.isDirectory()) throw new Error('state-legacy-lock')
      try { await rename(candidate, lock); acquired = true; break } catch (error) {
        let owners
        try { owners = await readdir(lock) } catch (readError) {
          if (readError.code === 'ENOENT') continue
          if (readError.code === 'ENOTDIR') throw new Error('state-legacy-lock')
          throw error
        }
        if (owners.length === 0) {
          await rmdir(lock).catch(error => { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code) && !(process.platform === 'win32' && error.code === 'EPERM')) throw error })
          continue
        }
        const match = owners.length === 1 && /^owner-([1-9]\d*)-[0-9a-f-]{36}$/.exec(owners[0])
        let metadata
        if (match) {
          try { metadata = JSON.parse(await readFile(join(lock, owners[0]), 'utf8')) } catch { /* Unverifiable owners stay locked. */ }
        }
        if (metadata?.version === 1 && metadata.host === hostname() && metadata.pid === Number(match[1]) && owners[0] === `owner-${metadata.pid}-${metadata.token}`) {
          let dead = false
          try { process.kill(Number(match[1]), 0) } catch (probeError) { dead = probeError.code === 'ESRCH' }
          if (dead) {
            // Owner names never repeat; rmdir cannot remove a new owner's populated lock.
            await unlink(join(lock, owners[0])).catch(error => { if (error.code !== 'ENOENT') throw error })
            await rmdir(lock).catch(error => { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code) && !(process.platform === 'win32' && error.code === 'EPERM')) throw error })
            continue
          }
        }
        await delay(50)
      }
    }
    if (!acquired) throw new Error('state-busy')
  } finally {
    if (!acquired) {
      await unlink(join(candidate, owner)).catch(error => { if (error.code !== 'ENOENT') throw error })
      await rmdir(candidate)
    }
  }
  const save = async state => {
    const temp = `${file}.${randomUUID()}.tmp`
    try {
      await writeFile(temp, JSON.stringify(state), { mode: 0o600 })
      await rename(temp, file)
    } finally {
      await unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error })
    }
  }
  try {
    let state = { turns: {} }
    try { state = JSON.parse(await readFile(file, 'utf8')) } catch (error) { if (error.code !== 'ENOENT') throw new Error('invalid-state') }
    if (!state || !state.turns || typeof state.turns !== 'object' || Array.isArray(state.turns)) throw new Error('invalid-state')
    return await action(state, save)
  } finally {
    await unlink(join(lock, owner))
    await rmdir(lock).catch(error => { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code) && !(process.platform === 'win32' && error.code === 'EPERM')) throw error })
  }
}
