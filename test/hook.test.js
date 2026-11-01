import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { exec } from 'node:child_process'
import { promisify } from 'node:util'
import { handleHook } from '../lib/hook.js'
import { containsSecret, recallText, storeText } from '../lib/memory.js'

const hit = { id: '12345678-1234-1234-1234-123456789012', title: '项目使用TypeScript', score: 0.8 }
const base = { session_id: 'session', turn_id: 'turn', cwd: process.cwd(), prompt: '项目约定是什么', hook_event_name: 'UserPromptSubmit' }
const textOf = output => output.hookSpecificOutput?.additionalContext ?? ''

async function fixture(t, call = async () => ({ status: 'ok', details: [hit] })) {
  const dataDir = await mkdtemp(join(tmpdir(), 'respire codex '))
  t.after(() => rm(dataDir, { recursive: true, force: true }))
  return { dataDir, call, showStatus: false, archive: async () => ({ result: 'nothing-to-store', records: [], calls: 2 }) }
}

test('recall injects bounded titles and archives silently only once', async t => {
  const calls = []
  const options = await fixture(t, async args => { calls.push(args); return { status: 'ok', details: [hit] } })
  assert.match(textOf(await handleHook(base, options)), /auto-recall.*\n.*12345678/s)
  assert.equal(calls[0][0], 'recall')
  const stop = { ...base, hook_event_name: 'Stop', stop_hook_active: false }
  let archives = 0
  options.archive = async () => { archives++; return { result: 'nothing-to-store', records: [], calls: 2 } }
  assert.deepEqual(await handleHook(stop, options), {})
  assert.deepEqual(await handleHook(stop, options), {})
  assert.equal(archives, 1)
  assert.equal(calls.length, 1)
  await handleHook({ ...base, turn_id: 'next-user' }, options)
  assert.equal(calls.length, 2)
})

test('explicit storage commits once and suppresses reminder', async t => {
  let writes = 0
  const options = await fixture(t, async args => { assert.equal(args[0], 'remember'); writes++; return { status: 'ok', summary: { id: hit.id } } })
  const event = { ...base, prompt: '记住：项目使用TypeScript' }
  assert.match(textOf(await handleHook(event, options)), /【respire · stored】/)
  await handleHook(event, options)
  assert.equal(writes, 1)
  assert.deepEqual(await handleHook({ ...event, hook_event_name: 'Stop' }, options), {})
  const files = await readdir(join(options.dataDir, 'sessions'))
  const saved = await readFile(join(options.dataDir, 'sessions', files[0]), 'utf8')
  assert.doesNotMatch(saved, /TypeScript|项目|记住/)
})

test('pending is not success; failed write stays unconfirmed and is never retried', async t => {
  const pending = await fixture(t, async () => ({ status: 'pending', items: [{ name: hit.id, value: hit.title }] }))
  assert.match(textOf(await handleHook({ ...base, prompt: '存：项目约定' }, pending)), /Nothing was written/)
  let calls = 0
  const failed = await fixture(t, async () => { calls++; throw new Error('password=do-not-echo') })
  const event = { ...base, prompt: '存：项目约定' }
  const output = textOf(await handleHook(event, failed))
  assert.match(output, /unconfirmed/)
  assert.doesNotMatch(output, /do-not-echo/)
  await handleHook(event, failed)
  assert.equal(calls, 1)
})

test('secret, skip, empty, plan and paused inputs do not write', async t => {
  let calls = 0
  const options = await fixture(t, async () => { calls++; return { status: 'skip' } })
  for (const [index, prompt] of ['记：password=hidden', '/nomem project', '记：', '', 'a'].entries()) {
    await handleHook({ ...base, turn_id: `skip-${index}`, prompt }, options)
  }
  await handleHook({ ...base, turn_id: 'plan', permission_mode: 'plan', prompt: '记：项目约定' }, options)
  assert.equal(calls, 0)
  assert.match(textOf(await handleHook({ ...base, turn_id: 'paused', prompt: '记：项目约定' }, options)), /not stored/)
  assert.deepEqual(await handleHook({ ...base, turn_id: 'paused', hook_event_name: 'Stop' }, options), {})
})

test('sessions are isolated and concurrent duplicate writes do not commit twice', async t => {
  let writes = 0
  const options = await fixture(t, async args => {
    if (args[0] === 'remember') writes++  // 回读的 show 不计入写入
    await new Promise(resolve => setTimeout(resolve, 100))
    return { status: 'ok', summary: { id: hit.id } }
  })
  const event = { ...base, prompt: 'remember: confirmed fact' }
  await Promise.all([handleHook(event, options), handleHook(event, options)])
  assert.equal(writes, 1)
  await handleHook({ ...event, session_id: 'other' }, options)
  assert.equal(writes, 2)
})

test('Stop guards missing turn, active continuation, failed recall and duplicate text new turn', async t => {
  const options = await fixture(t)
  const stop = { ...base, hook_event_name: 'Stop' }
  assert.deepEqual(await handleHook(stop, options), {})
  await handleHook(base, options)
  assert.deepEqual(await handleHook({ ...stop, stop_hook_active: true }, options), {})
  assert.deepEqual(await handleHook(stop, options), {})
  const failure = await fixture(t, async () => { throw new Error('timeout') })
  await handleHook(base, failure)
  assert.deepEqual(await handleHook(stop, failure), {})
})

test('SessionStart restores rules on startup, resume, compact and fork, reports unavailable engine', async t => {
  const options = await fixture(t, async () => ({ status: 'ok', summary: { unlocked: false, session: { has_session: false } } }))
  for (const source of ['startup', 'resume', 'compact', 'fork']) {
    const output = textOf(await handleHook({ ...base, hook_event_name: 'SessionStart', source }, options))
    assert.match(output, /memory layer/)
    assert.match(output, /locked/)
    assert.match(output, /Not signed in/)
  }
  assert.match(textOf(await handleHook({ ...base, hook_event_name: 'SessionStart' }, { call: async () => { throw Error('secret') } })), /runtime unavailable/)
})

test('invalid input, missing data and corrupt state fail without writing memories', async t => {
  await assert.rejects(handleHook({}), /invalid-input/)
  assert.match((await handleHook(base, { dataDir: '', call: () => assert.fail() })).systemMessage, /PLUGIN_DATA/)
  const options = await fixture(t)
  await handleHook(base, options)
  const { writeFile } = await import('node:fs/promises')
  const [file] = await readdir(join(options.dataDir, 'sessions'))
  await writeFile(join(options.dataDir, 'sessions', file), 'invalid')
  await assert.rejects(handleHook({ ...base, turn_id: 'other' }, options), /invalid-state/)
})

test('title budgets, malformed envelopes and credential heuristics', () => {
  assert.ok(containsSecret('token=hidden'))
  assert.throws(() => recallText({ status: 'ok', details: null }))
  assert.equal(recallText({ status: 'skip' }), '')
  assert.equal(recallText({ status: 'ok', details: [{ ...hit, title: 'password=hidden' }] }), '')
  assert.ok(recallText({ status: 'ok', details: Array(10).fill(hit) }).length <= 1500)
  assert.equal(storeText({ status: 'ok' }).stored, false)
})

test('store receipts follow the result-state contract (warn written, pending relays actions, read-back)', async t => {
  // warn + valid id = WRITTEN after commit (unresolvable parent etc.) — never a failure, never a re-send
  const warned = storeText({ status: 'warn', summary: { id: hit.id }, errors: ['parent (cause) cannot be resolved; stored independently'] })
  assert.equal(warned.stored, true)
  assert.match(warned.text, /Saved with warnings/)
  assert.match(warned.text, /parent \(cause\) cannot be resolved/)
  assert.match(warned.text, /do not send the same record again/)
  // pending keeps engine-suggested actions (merge > attach > new), not just parent/force
  const pending = storeText({ status: 'pending', items: [{ name: 'aaaabbbb', value: 'similarity=88% title=stub candidate' }], actions: ['rsrs remember "<combined content>" --merge-ids "aaaabbbb"', 'rsrs remember "<content>" --force to write as new entry'] })
  assert.equal(pending.stored, false)
  assert.match(pending.text, /Nothing was written/)
  assert.match(pending.text, /aaaabbbb: similarity=88%/)
  assert.match(pending.text, /--merge-ids/)
  assert.match(pending.text, /--force/)
  // E2E through the hook: a warn write is verified by read-back; show is the second engine call
  const calls = []
  const options = await fixture(t, async args => {
    calls.push(args[0])
    if (args[0] === 'remember') return { status: 'warn', summary: { id: hit.id }, errors: ['parent (cause) cannot be resolved; stored independently'] }
    if (args[0] === 'show') return { status: 'ok', summary: { id: hit.id }, details: { entry: { id: hit.id, title: 'confirmed fact', content: 'confirmed fact' } } }
    return { status: 'ok', details: [hit] }
  })
  const text = textOf(await handleHook({ ...base, prompt: 'remember: confirmed fact' }, options))
  assert.match(text, /Saved with warnings/)
  assert.match(text, /Write verified by read-back/)
  assert.deepEqual(calls, ['remember', 'show'])
  // read-back mismatch is reported honestly
  const bad = await fixture(t, async args => {
    if (args[0] === 'remember') return { status: 'ok', summary: { id: hit.id } }
    if (args[0] === 'show') return { status: 'ok', summary: { id: hit.id }, details: { entry: { id: hit.id, title: 'drifted', content: 'drifted' } } }
    return { status: 'ok', details: [hit] }
  })
  assert.match(textOf(await handleHook({ ...base, turn_id: 'mismatch-turn', prompt: 'remember: confirmed fact' }, bad)), /DIFFERENT id, title or content/)
  // read-back failure degrades to unavailable, never blocks the receipt
  const blind = await fixture(t, async args => {
    if (args[0] === 'remember') return { status: 'ok', summary: { id: hit.id } }
    if (args[0] === 'show') throw new Error('timeout')
    return { status: 'ok', details: [hit] }
  })
  assert.match(textOf(await handleHook({ ...base, turn_id: 'blind-turn', prompt: 'remember: confirmed fact' }, blind)), /Read-back unavailable/)
  // wrong id: show returns a different entry — a title/body match alone must not verify
  const stranger = '99999999-9999-9999-9999-999999999999'
  const wrongId = await fixture(t, async args => {
    if (args[0] === 'remember') return { status: 'ok', summary: { id: hit.id } }
    if (args[0] === 'show') return { status: 'ok', summary: { id: stranger }, details: { entry: { id: stranger, title: 'confirmed fact', content: 'confirmed fact' } } }
    return { status: 'ok', details: [hit] }
  })
  const wrongIdText = textOf(await handleHook({ ...base, turn_id: 'wrong-id-turn', prompt: 'remember: confirmed fact' }, wrongId))
  assert.match(wrongIdText, /DIFFERENT/)
  assert.doesNotMatch(wrongIdText, /Write verified/)
  // same first 40 chars but a tampered tail is a DIFFERENT body, not a verified one
  const long = 'f'.repeat(60)
  const tampered = await fixture(t, async args => {
    if (args[0] === 'remember') return { status: 'ok', summary: { id: hit.id } }
    if (args[0] === 'show') return { status: 'ok', summary: { id: hit.id }, details: { entry: { id: hit.id, title: long, content: `${long}TAMPERED` } } }
    return { status: 'ok', details: [hit] }
  })
  const tamperedText = textOf(await handleHook({ ...base, turn_id: 'tampered-turn', prompt: `remember: ${long}` }, tampered))
  assert.match(tamperedText, /DIFFERENT/)
  assert.doesNotMatch(tamperedText, /Write verified/)
  // missing body (entry.content undefined) is never verified
  const noBody = await fixture(t, async args => {
    if (args[0] === 'remember') return { status: 'ok', summary: { id: hit.id } }
    if (args[0] === 'show') return { status: 'ok', summary: { id: hit.id }, details: { entry: { id: hit.id, title: 'confirmed fact' } } }
    return { status: 'ok', details: [hit] }
  })
  const noBodyText = textOf(await handleHook({ ...base, turn_id: 'no-body-turn', prompt: 'remember: confirmed fact' }, noBody))
  assert.doesNotMatch(noBodyText, /Write verified/)
  assert.match(noBodyText, /DIFFERENT|Read-back unavailable/)
  // slow remember + hanging show under a tight budget: the read-back is not even started
  // and the receipt still returns within the budget (never waits for the hanging show)
  process.env.RESPIRE_HOOK_BUDGET_MS = '4000'
  t.after(() => { delete process.env.RESPIRE_HOOK_BUDGET_MS })
  const slowCalls = []
  const slow = await fixture(t, async args => {
    slowCalls.push(args[0])
    if (args[0] === 'remember') { await new Promise(resolve => setTimeout(resolve, 2000)); return { status: 'ok', summary: { id: hit.id } } }
    if (args[0] === 'show') return new Promise(() => {}) // would hang ~10s in reality
    return { status: 'ok', details: [hit] }
  })
  let started = Date.now()
  const slowText = textOf(await handleHook({ ...base, turn_id: 'slow-turn', prompt: 'remember: confirmed fact' }, slow))
  const slowElapsed = Date.now() - started
  assert.match(slowText, /Read-back unavailable/)
  assert.ok(!slowCalls.includes('show'), 'a too-small remaining budget must not start the read-back')
  assert.ok(slowElapsed < 6000, `receipt took ${slowElapsed}ms`)
  // budget still allows starting show: the read-back signal aborts the executor and the
  // receipt returns unavailable without waiting for the hung show any longer
  process.env.RESPIRE_HOOK_BUDGET_MS = '7000'
  const raceCalls = []
  const raced = await fixture(t, async (args, options = {}) => {
    raceCalls.push(args[0])
    if (args[0] === 'remember') { await new Promise(resolve => setTimeout(resolve, 2000)); return { status: 'ok', summary: { id: hit.id } } }
    // hangs until the signal aborts it, exactly like a real runRsrs child
    if (args[0] === 'show') return new Promise((resolve, reject) => options.signal?.addEventListener('abort', () => reject(new Error('cancelled'))))
    return { status: 'ok', details: [hit] }
  })
  started = Date.now()
  const racedText = textOf(await handleHook({ ...base, turn_id: 'race-turn', prompt: 'remember: confirmed fact' }, raced))
  const racedElapsed = Date.now() - started
  assert.match(racedText, /Read-back unavailable/)
  assert.ok(raceCalls.includes('show'))
  assert.ok(racedElapsed < 6000, `receipt took ${racedElapsed}ms`)
})

test('packaged command runs through the real platform shell with spaces in PLUGIN_ROOT', async t => {
  const options = await fixture(t)
  const { cp } = await import('node:fs/promises')
  await cp('lib', join(options.dataDir, 'lib'), { recursive: true })
  await cp('package.json', join(options.dataDir, 'package.json'))
  const hooks = JSON.parse(await readFile('hooks/hooks.json', 'utf8'))
  const command = hooks.hooks.Stop[0].hooks[0].command
  const input = JSON.stringify({ ...base, hook_event_name: 'Stop' })
  const child = exec(command, { shell: process.platform === 'win32' ? 'powershell.exe' : '/bin/sh', env: { ...process.env, PLUGIN_ROOT: resolve(options.dataDir), PLUGIN_DATA: options.dataDir }, windowsHide: true, timeout: 10000 })
  let stdout = ''
  child.stdout.on('data', data => { stdout += data })
  child.stdin.end(input)
  await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', code => code === 0 ? resolve() : reject(Error(`exit ${code}`))) })
  assert.equal(stdout.trim(), '')
})

test('packaged read-back aborts its slow child tree and exits inside the shared budget', async t => {
  const root = await mkdtemp(join(tmpdir(), 'respire readback '))
  t.after(() => rm(root, { recursive: true, force: true }))
  const { cp, mkdir, writeFile, chmod } = await import('node:fs/promises')
  const dataDir = join(root, 'plugin data')
  const pluginRoot = join(root, 'plugin root')
  const markers = join(root, 'markers.log')
  const id = '12345678-1234-1234-1234-123456789012'
  await mkdir(dataDir, { recursive: true })
  await cp('lib', join(pluginRoot, 'lib'), { recursive: true })
  await cp('package.json', join(pluginRoot, 'package.json'))
  // Slow stub engine: remember commits after ~1s; show hangs ~15s, far past the shared budget.
  await writeFile(join(root, 'engine.js'), `const { appendFileSync } = require('node:fs')
const args = process.argv.slice(2)
if (args.includes('remember')) {
  appendFileSync(process.env.STUB_MARKERS, 'remember\\n')
  setTimeout(() => { process.stdout.write(JSON.stringify({ status: 'ok', summary: { id: '${id}' } }) + '\\n'); process.exit(0) }, 1000)
} else if (args.includes('show')) {
  appendFileSync(process.env.STUB_MARKERS, 'show ' + process.pid + '\\n')
  setTimeout(() => { process.stdout.write('{"status":"ok"}\\n'); process.exit(0) }, 15000)
}
`)
  // RESPIRE_RSRS_PATH is a single path: on Windows a .ps1 wrapper forwards to the node stub.
  const executable = process.platform === 'win32' ? join(root, 'engine.ps1') : join(root, 'engine.js')
  if (process.platform === 'win32') {
    const quote = value => value.replaceAll("'", "''")
    await writeFile(executable, `& '${quote(process.execPath)}' '${quote(join(root, 'engine.js'))}' @args\nexit $LASTEXITCODE\n`)
  } else await chmod(executable, 0o700)
  const hooks = JSON.parse(await readFile('hooks/hooks.json', 'utf8'))
  const command = hooks.hooks.UserPromptSubmit[0].hooks[0].command
  const input = JSON.stringify({ session_id: 'budget-session', turn_id: 'budget-turn', cwd: process.cwd(), prompt: 'remember: slow read-back fact', hook_event_name: 'UserPromptSubmit' })
  const env = { ...process.env, PLUGIN_ROOT: pluginRoot, PLUGIN_DATA: dataDir, RESPIRE_HOOK_BUDGET_MS: '8000', RESPIRE_RSRS_PATH: executable, STUB_MARKERS: markers }
  const run = () => new Promise((resolveRun, rejectRun) => {
    const started = Date.now()
    const child = exec(command, { shell: process.platform === 'win32' ? 'powershell.exe' : '/bin/sh', env, windowsHide: true, timeout: 20000 })
    let stdout = ''
    child.stdout.on('data', data => { stdout += data })
    child.stdin.end(input)
    child.on('error', rejectRun)
    child.on('close', code => resolveRun({ code, stdout, elapsed: Date.now() - started }))
  })
  const first = await run()
  assert.equal(first.code, 0, `stdout: ${first.stdout}`)
  assert.ok(first.elapsed < 10000, `the hook process exited after ${first.elapsed}ms; the shared budget is 8000ms`)
  assert.match(first.stdout, new RegExp(`Saved: ${id}`))
  assert.match(first.stdout, /Read-back unavailable/)
  const log = await readFile(markers, 'utf8')
  assert.equal(log.split('\n').filter(line => line === 'remember').length, 1)
  const showPid = Number(log.match(/^show (\d+)$/m)?.[1])
  assert.ok(Number.isInteger(showPid) && showPid > 0, 'the slow read-back show child must have started')
  // The aborted read-back child (whole tree) must be terminated: no leftover child past the receipt.
  await new Promise(resolveSleep => setTimeout(resolveSleep, 1000))
  if (process.platform === 'win32') {
    const { execFile } = await import('node:child_process')
    const list = await new Promise(resolveList => execFile('tasklist.exe', ['/NH', '/FI', `PID eq ${showPid}`], { windowsHide: true }, (error, stdout) => resolveList(error ? '' : String(stdout))))
    assert.doesNotMatch(list, new RegExp(`\\s${showPid}\\s`), `show child ${showPid} is still alive after the hook exited`)
  } else {
    assert.throws(() => process.kill(showPid, 0), error => error.code === 'ESRCH', `show child ${showPid} is still alive after the hook exited`)
  }
  // Replaying the same turn must not re-run remember (duplicate event path, no second write).
  const second = await run()
  assert.equal(second.code, 0, `stdout: ${second.stdout}`)
  assert.match(second.stdout, /duplicate event/)
  assert.equal((await readFile(markers, 'utf8')).split('\n').filter(line => line === 'remember').length, 1)
})

test('successful zero-match recall still archives once, paused and errors do not', async t => {
  for (const [name, response, expected] of [
    ['empty', { status: 'skip', summary: { count: 0 } }, 1],
    ['paused', { status: 'skip', summary: { reason: 'paused' } }, 0],
    ['error', { status: 'error', errors: ['unavailable'] }, 0],
  ]) {
    const options = await fixture(t, async () => response)
    let archives = 0
    options.archive = async () => { archives++; return { result: 'nothing-to-store', records: [], calls: 2 } }
    const event = { ...base, turn_id: name }
    await handleHook(event, options)
    await handleHook({ ...event, hook_event_name: 'Stop' }, options)
    await handleHook({ ...event, hook_event_name: 'Stop' }, options)
    assert.equal(archives, expected, name)
  }
})
