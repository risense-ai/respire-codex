import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { exec } from 'node:child_process'
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

test('explicit storage delegates curation without engine writes or a second background writer', async t => {
  let calls = 0, archives = 0
  const options = await fixture(t, async () => { calls++; throw new Error('must not call the engine') })
  options.archive = async () => { archives++; return {} }
  for (const [index, prefix] of ['记：', '存：', '记录：', '记住：', 'remember:'].entries()) {
    const event = { ...base, turn_id: `prefix-${index}`, prompt: `${prefix}项目使用TypeScript` }
    const text = textOf(await handleHook(event, options))
    for (const phrase of ['Nothing was written', 'you MUST read prompt and agent-config', 'show their full bodies', 'Prefer update, then an authorized merge, then attach, then a new record', 'taxonomy --list or tree', 'permitted ONLY AFTER', 'DO NOT retry automatically or claim success', 'Verification does not authorize an automatic retry', 'After every actual write, you MUST read it back with show', 'no justified parent exists, you MUST remain pending', 'DO NOT execute the engineering task']) assert.ok(text.includes(phrase), phrase)
    assert.doesNotMatch(text, /Saved:|may have been written/)
    assert.match(textOf(await handleHook(event, options)), /Resolve the original storage request/)
    await handleHook({ ...event, hook_event_name: 'Stop' }, options)
  }
  assert.equal(calls, 0)
  assert.equal(archives, 0)
  const files = await readdir(join(options.dataDir, 'sessions'))
  assert.doesNotMatch(await readFile(join(options.dataDir, 'sessions', files[0]), 'utf8'), /TypeScript|项目|记住/)
})

test('pending handoff differs from an unknown actual write outcome', async t => {
  const options = await fixture(t, async () => assert.fail('a prefix does not send a write'))
  const text = textOf(await handleHook({ ...base, prompt: '存：项目约定' }, options))
  assert.match(text, /hook made no write request/)
  assert.match(text, /MUST resolve this storage request in this turn/)
  const { RULES } = await import('../lib/memory.js')
  assert.match(RULES, /Hook pending does not prohibit the first policy-compliant write/)
  assert.match(storeText({ status: 'ok' }).text, /unconfirmed/)
})

test('secret, skip, empty, plan and paused inputs do not write', async t => {
  let calls = 0
  const options = await fixture(t, async () => { calls++; return { status: 'skip' } })
  for (const [index, prompt] of ['记：password=hidden', '/nomem project', '记：', '', 'a'].entries()) {
    await handleHook({ ...base, turn_id: `skip-${index}`, prompt }, options)
  }
  await handleHook({ ...base, turn_id: 'plan', permission_mode: 'plan', prompt: '记：项目约定' }, options)
  assert.equal(calls, 0)
  assert.match(textOf(await handleHook({ ...base, turn_id: 'paused', prompt: '记：项目约定' }, options)), /store pending/)
  assert.deepEqual(await handleHook({ ...base, turn_id: 'paused', hook_event_name: 'Stop' }, options), {})
})

test('sessions and concurrent duplicate prefix events stay pending without writes', async t => {
  const options = await fixture(t, async () => assert.fail('no engine call'))
  const event = { ...base, prompt: 'remember: confirmed fact' }
  const results = await Promise.all([handleHook(event, options), handleHook(event, options)])
  for (const result of results) assert.match(textOf(result), /store pending/)
  assert.match(textOf(await handleHook({ ...event, session_id: 'other' }, options)), /MUST resolve this storage request/)
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
  const parent = hit.id
  const requests = []
  const pre = (command, tool_name = 'Bash', tool_input = { command }) => handleHook({ ...base, hook_event_name: 'PreToolUse', tool_name, tool_input }, {
    call: async args => { requests.push(args); return { status: 'ok', summary: { id: parent }, details: { entry: { id: parent, content: 'real parent body' } } } },
  })
  for (const command of [
    'rsrs remember "fact"', 'rsrs remember "fact --parent ' + parent + '"',
    'rsrs remember "fact" --parent=', 'rsrs remember "fact" --parent "$parent"',
    'env MODE=x rsrs remember "fact"', 'X=x rsrs remember "fact"', 'command rsrs remember "fact"',
    '>out rsrs remember fact', '2>/dev/null rsrs remember fact', 'rsrs >out remember fact --importance important --force',
    'rsrs 2>/dev/null remember fact', 'rsrs 2>&1 remember fact', 'echo $(rsrs remember fact)', 'echo "$(rsrs remember fact)"',
    'rsrs remember fact --importance trivial --merge-ids A,B',
    'npx rsrs remember fact', 'command -- rsrs remember fact', 'env -- rsrs remember fact',
    "bash -c 'rsrs remember fact --force'", "bash -lc 'rsrs remember fact --force'",
    "pwsh -NoProfile -NonInteractive -Command 'rsrs remember fact --force'", 'echo `rsrs remember fact --force`',
    'rsrs --model-task-id audit remember fact', 'rsrs --progress-id=audit remember fact',
    'rsrs remember "fact" --force=false --parent ' + parent,
    'rsrs update ' + parent + ' --clear-parent', 'rsrs update ' + parent + ' --clear-parent=true',
    'rsrs update ' + parent + ' --parent=not-an-id', 'rsrs update ' + parent + ' --parent ""',
    'echo done && rsrs remember "fact"', 'rsrs remember "$fact" --parent ' + parent,
    'rsrs remember "fact" --parent ' + parent + ' | cat',
  ]) assert.equal((await pre(command)).hookSpecificOutput?.permissionDecision, 'deny', command)
  assert.equal(requests.length, 0)
  for (const command of [
    'echo "rsrs remember --force"', "echo '$(rsrs remember fact)'", "echo '`rsrs remember fact --force`'",
    "bash -c 'echo \"rsrs remember fact --force\"'", "bash -c 'rsrs recall remember --titles --json'",
    "pwsh -Command 'rsrs recall remember --titles --json'", 'rsrs recall "--force --parent=fake"', 'rsrs remember --help',
    'rsrs recall remember --titles --json', 'rsrs --client-only --json recall remember --titles --json',
    'rsrs remember "process diary" --importance=trivial', 'rsrs update ' + parent + ' --content "ordinary update"',
    'rsrs update ' + parent + ' --content "--clear-parent"', 'rsrs --addr http://example.invalid recall remember',
    'rsrs remember "fact --force --parent=fake" --parent ' + parent,
    'rsrs update ' + parent + ' --content "quoted --clear-parent" --parent=' + parent,
    'rsrs remember fact --parent ' + parent + ' --project project --tags a,b --type context --summary "--force in data"',
    'rsrs --client-only --json --model-task-id audit --progress-id=audit remember fact --parent ' + parent,
  ]) assert.deepEqual(await pre(command), {}, command)
  assert.deepEqual(requests, Array.from({ length: 4 }, () => ['show', parent]))
  assert.deepEqual(await pre('rsrs remember "fact"', 'apply_patch'), {})
  for (const tool of ['mcp__respire__memory_remember', 'mcp__respire__memory_update']) assert.equal((await pre('', tool, { content: 'fact', parent, force: true })).hookSpecificOutput.permissionDecision, 'deny')
  assert.deepEqual(await pre('', 'mcp__respire__memory_recall', { query: 'remember' }), {})
  for (const doc of [{ status: 'fail' }, { status: 'ok', summary: { id: parent }, details: { entry: { id: 'wrong', content: 'wrong body' } } }]) {
    const out = await handleHook({ ...base, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'rsrs remember "fact" --parent ' + parent } }, { call: async () => doc })
    assert.equal(out.hookSpecificOutput.permissionDecision, 'deny')
  }
  const timeout = await handleHook({ ...base, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'rsrs update ' + parent + ' --parent ' + parent } }, { call: async () => { throw new Error('timeout') } })
  assert.equal(timeout.hookSpecificOutput.permissionDecision, 'deny')
  const target = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
  for (const currentParent of ['', 'not-an-id', parent]) {
    const seen = []
    const result = await handleHook({ ...base, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'rsrs update ' + target + ' --importance=important' } }, {
      call: async args => {
        seen.push(args)
        return { status: 'ok', summary: { id: args[1] }, details: { entry: { id: args[1], content: 'existing body', parent_id: currentParent } } }
      },
    })
    if (currentParent === parent) {
      assert.deepEqual(result, {})
      assert.deepEqual(seen, [['show', target], ['show', parent]])
    } else {
      assert.equal(result.hookSpecificOutput.permissionDecision, 'deny')
      assert.match(result.hookSpecificOutput.permissionDecisionReason, /attach.*BEFORE promoting/)
      assert.deepEqual(seen, [['show', target]])
    }
  }
  const absentParent = await handleHook({ ...base, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'rsrs update ' + target + ' --importance important' } }, {
    call: async args => args[1] === target
      ? { status: 'ok', summary: { id: target }, details: { entry: { id: target, content: 'diary', parent_id: parent } } }
      : { status: 'fail' },
  })
  assert.equal(absentParent.hookSpecificOutput.permissionDecision, 'deny')
})

test('title budgets, malformed envelopes and credential heuristics', () => {
  assert.ok(containsSecret('token=hidden'))
  assert.throws(() => recallText({ status: 'ok', details: null }))
  assert.equal(recallText({ status: 'skip' }), '')
  assert.equal(recallText({ status: 'ok', details: [{ ...hit, title: 'password=hidden' }] }), '')
  assert.ok(recallText({ status: 'ok', details: Array(10).fill(hit) }).length <= 1500)
  const superseded = recallText({ status: 'ok', details: [{ ...hit, superseded_by: hit.id }] })
  assert.match(superseded, /superseded; MUST read the replacing record before using this record/)
  assert.doesNotMatch(superseded, /已被取代|先查新条/)
  assert.equal(storeText({ status: 'ok' }).stored, false)
})

test('store receipts retain the result-state contract for actual writes', async t => {
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
})





test('validId accepts only canonical UUIDs or 16+ char hex strings', async () => {
  const { validId } = await import('../lib/memory.js')
  for (const bad of ['--------', 12345678, null, undefined, {}, 'short', 'abcd-1234-xyz-', '12345678-1234-1234-1234-12345678901z']) {
    assert.equal(validId(bad), false, String(bad))
  }
  for (const good of [hit.id, 'abcdef0123456789', 'ABCDEF0123456789', 'f'.repeat(60)]) {
    assert.equal(validId(good), true, String(good))
  }
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
  const guardCommand = hooks.hooks.PreToolUse[0].hooks[0].command
  const guard = exec(guardCommand, { shell: process.platform === 'win32' ? 'powershell.exe' : '/bin/sh', env: { ...process.env, PLUGIN_ROOT: resolve(options.dataDir), PLUGIN_DATA: options.dataDir }, windowsHide: true, timeout: 10000 })
  let denied = ''
  guard.stdout.on('data', data => { denied += data })
  guard.stdin.end(JSON.stringify({ ...base, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'rsrs remember "missing parent"' } }))
  await new Promise((resolve, reject) => { guard.on('error', reject); guard.on('close', code => code === 0 ? resolve() : reject(Error('guard exit ' + code))) })
  assert.equal(JSON.parse(denied).hookSpecificOutput.permissionDecision, 'deny')
  for (const input of ['not-json', JSON.stringify({ ...base, prompt: 'x'.repeat(1024 * 1024) }), JSON.stringify({ ...base, hook_event_name: 'Stop' })]) {
    const failed = exec(guardCommand, { shell: process.platform === 'win32' ? 'powershell.exe' : '/bin/sh', env: { ...process.env, PLUGIN_ROOT: resolve(options.dataDir), PLUGIN_DATA: options.dataDir }, windowsHide: true, timeout: 10000 })
    let output = ''
    failed.stdout.on('data', chunk => { output += chunk })
    failed.stdin.on('error', error => { if (error.code !== 'EPIPE') throw error })
    failed.stdin.end(input)
    await new Promise((resolve, reject) => { failed.on('error', reject); failed.on('close', code => code === 0 ? resolve() : reject(Error('guard exit ' + code))) })
    assert.equal(JSON.parse(output).hookSpecificOutput.permissionDecision, 'deny')
  }
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
