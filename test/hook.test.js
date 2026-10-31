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
  const options = await fixture(t, async () => { writes++; await new Promise(resolve => setTimeout(resolve, 100)); return { status: 'ok', summary: { id: hit.id } } })
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
