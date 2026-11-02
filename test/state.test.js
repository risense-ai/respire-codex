import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir, hostname } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { withState, keyOf } from '../lib/state.js'

test('dead owner recovers without changing pending or dedup state', async () => {
  const root = await mkdtemp(join(tmpdir(), 'respire-lock-'))
  try {
    await mkdir(join(root, 'sessions'))
    const file = join(root, 'sessions', keyOf('test') + '.json')
    const original = JSON.stringify({ turns: { old: { phase: 'processing', stored: 'unconfirmed' } } })
    await writeFile(file, original)
    const child = spawnSync(process.execPath, ['-e', ''])
    const token = randomUUID()
    await mkdir(file + '.lock')
    await writeFile(join(file + '.lock', `owner-${child.pid}-${token}`), JSON.stringify({ version: 1, pid: child.pid, host: hostname(), token }))
    await Promise.all(Array.from({ length: 8 }, () => withState(root, 'test', async state => {
      assert.equal(state.turns.old.stored, 'unconfirmed')
      await new Promise(resolve => setTimeout(resolve, 10))
    })))
    assert.equal(await readFile(file, 'utf8'), original)
  } finally { await rm(root, { recursive: true, force: true }) }
})

for (const [name, owner] of Object.entries({ live: { version: 1, pid: process.pid, host: hostname(), token: randomUUID() }, legacy: '', malformed: '{', foreign: { version: 1, pid: 999999, host: 'other-host', token: randomUUID() } })) {
  test(`preserves ${name} lock`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'respire-lock-'))
    try {
      await mkdir(join(root, 'sessions'))
      const lock = join(root, 'sessions', keyOf('test') + '.json.lock')
      const text = typeof owner === 'string' ? owner : JSON.stringify(owner)
      const record = name === 'legacy' ? lock : join(lock, `owner-${owner.pid ?? process.pid}-${owner.token ?? randomUUID()}`)
      if (name !== 'legacy') await mkdir(lock)
      await writeFile(record, text)
      await assert.rejects(withState(root, 'test', () => assert.fail('must not enter')), name === 'legacy' ? /state-legacy-lock/ : /state-busy/)
      assert.equal(await readFile(record, 'utf8'), text)
    } finally { await rm(root, { recursive: true, force: true }) }
  })
}

test('actual process exit leaves recoverable metadata', async () => {
  const root = await mkdtemp(join(tmpdir(), 'respire-crash-'))
  try {
    const moduleUrl = new URL('../lib/state.js', import.meta.url).href
    const script = `import {withState} from ${JSON.stringify(moduleUrl)}; await withState(${JSON.stringify(root)}, 'crash', async (s,save) => { s.turns.pending={stored:'unconfirmed'}; await save(s); process.exit(0) })`
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', script])
    assert.equal(child.status, 0, child.stderr?.toString())
    const file = join(root, 'sessions', keyOf('crash') + '.json')
    const original = await readFile(file, 'utf8')
    await withState(root, 'crash', state => assert.equal(state.turns.pending.stored, 'unconfirmed'))
    assert.equal(await readFile(file, 'utf8'), original)
  } finally { await rm(root, { recursive: true, force: true }) }
})
