import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { handleHook } from '../lib/hook.js'
import { withState, keyOf } from '../lib/state.js'

const id = '12345678-1234-1234-1234-123456789012'
const hit = { id, title: '项目使用中文提交', score: 0.8 }
const base = { session_id: 'visibility', turn_id: 'first', cwd: process.cwd(), prompt: '项目约定是什么', hook_event_name: 'UserPromptSubmit' }
const text = output => output.hookSpecificOutput?.additionalContext ?? ''
async function setup(t, response = { status: 'ok', details: [hit] }) {
  const dataDir = await mkdtemp(join(tmpdir(), 'respire-visibility-'))
  t.after(() => rm(dataDir, { recursive: true, force: true }))
  return { dataDir, call: async () => response, showStatus: true }
}

test('status remains silent when disabled and does not consume previous notices', async t => {
  const options = { ...await setup(t), showStatus: false }
  await withState(options.dataDir, base.session_id, async (state, save) => {
    state.turns.old = { archive: { status: 'completed', result: 'stored', records: [id], checkedRecords: [id] } }
    await save(state)
  })
  const output = text(await handleHook(base, options))
  assert.match(output, /自动召回/)
  assert.doesNotMatch(output, /可见提示|Memory:|Used:|save:/)
  await withState(options.dataDir, base.session_id, async state => {
    assert.equal(state.visibilityInitialized, undefined)
    assert.equal(state.turns.old.noticeOutcome, undefined)
  })
})

test('optional hints defer to strict output formats and empty writes stay skipped', async t => {
  const options = await setup(t)
  delete options.showStatus
  const output = text(await handleHook({ ...base, prompt: '只输出JSON' }, options))
  assert.match(output, /Memory: 1 found/)
  assert.match(output, /严格JSON/)
  assert.match(output, /省略所有状态标签/)
  const empty = text(await handleHook({ ...base, turn_id: 'empty-write', prompt: '记住：' }, options))
  assert.match(empty, /Save: skipped/)
  assert.doesNotMatch(empty, /Save: verified/)
})
test('visible recall counts only safe delivered candidates and distinguishes empty from unavailable', async t => {
  for (const [response, expected] of [
    [{ status: 'ok', details: [hit, { ...hit, title: 'password=hidden' }] }, /Memory: 1 found/],
    [{ status: 'skip', summary: { count: 0 } }, /Memory: no match/],
    [{ status: 'skip', summary: { reason: 'paused' } }, /Memory: skipped/],
    [{ status: 'fail' }, /Memory: unavailable/],
  ]) {
    const output = text(await handleHook(base, await setup(t, response)))
    assert.match(output, expected)
    assert.doesNotMatch(output, /password=hidden/)
  }
})
test('prior storage requires nonempty written IDs and readback of every written ID', async t => {
  for (const [archive, expected] of [
    [{ status: 'completed', result: 'read-only', records: [], checkedRecords: [] }, /Last save: read-only/],
    [{ status: 'completed', result: 'stored', records: [id], checkedRecords: [id] }, /Last save: verified/],
    [{ status: 'completed', result: 'stored', records: [id], checkedRecords: [] }, /Last save: unverified/],
    [{ status: 'completed', result: 'stored', records: [] }, /Last save: unconfirmed/],
    [{ status: 'unconfirmed', error: 'token=hidden', records: [id] }, /Last save: unconfirmed/],
    [{ status: 'running' }, /Last save: pending/],
    [{ status: 'completed', result: 'nothing-to-store', records: [] }, /Last save: not needed/],
    [{ status: 'completed', result: 'already-stored', checkedRecords: [id] }, /Last save: already exists/],
  ]) {
    const options = await setup(t)
    await withState(options.dataDir, base.session_id, async (state, save) => { state.turns.old = { archive }; await save(state) })
    const output = text(await handleHook(base, options))
    assert.match(output, expected)
    assert.doesNotMatch(output, /token=hidden/)
    if (!archive.checkedRecords?.length) assert.doesNotMatch(output, /Last save: verified/)
  }
})
test('late completion is reported once, is session isolated, and does not replay pre-upgrade history', async t => {
  const options = await setup(t)
  await withState(options.dataDir, base.session_id, async (state, save) => {
    state.turns.ancient = { archive: { status: 'completed', result: 'nothing-to-store' } }
    await save(state)
  })
  await handleHook(base, options)
  await withState(options.dataDir, base.session_id, async (state, save) => {
    state.turns[keyOf(base.turn_id)].archive = { status: 'running' }; await save(state)
  })
  assert.match(text(await handleHook({ ...base, turn_id: 'second' }, options)), /Last save: pending/)
  await withState(options.dataDir, base.session_id, async (state, save) => {
    state.turns[keyOf(base.turn_id)].archive = { status: 'completed', result: 'stored', records: [id], checkedRecords: [id] }
    await save(state)
  })
  assert.match(text(await handleHook({ ...base, turn_id: 'third' }, options)), /Earlier save: verified/)
  assert.doesNotMatch(text(await handleHook({ ...base, turn_id: 'fourth' }, options)), /save: verified|save: not needed/)
  assert.doesNotMatch(text(await handleHook({ ...base, session_id: 'other' }, options)), /Last save:|Earlier save:/)
})
test('skip and explicit writes have accurate concise notices without touching retrieval on skip', async t => {
  const options = await setup(t)
  options.call = () => assert.fail('skip must not call engine')
  assert.match(text(await handleHook({ ...base, prompt: '/nomem hello' }, options)), /Memory: skipped/)
  const explicit = await setup(t, { status: 'ok', summary: { id } })
  const output = text(await handleHook({ ...base, prompt: '记住：项目使用中文' }, explicit))
  assert.match(output, /Save: unverified/)
  assert.doesNotMatch(output, /save: verified/)
})

test('no receipt is omitted without blocking a later completed receipt', async t => {
  const options = await setup(t)
  await handleHook(base, options)
  assert.doesNotMatch(text(await handleHook({ ...base, turn_id: 'next' }, options)), /Last save:|Earlier save:/)
  await withState(options.dataDir, base.session_id, async (state, save) => {
    state.turns[keyOf(base.turn_id)].archive = { status: 'completed', result: 'stored', records: [id], checkedRecords: [id] }
    await save(state)
  })
  assert.match(text(await handleHook({ ...base, turn_id: 'later' }, options)), /Earlier save: verified/)
})
test('Chinese outcomes from the previous version are not replayed after translation', async t => {
  const options = await setup(t)
  await withState(options.dataDir, base.session_id, async (state, save) => {
    state.visibilityInitialized = true
    state.turns.old = { noticeEligible: true, noticeOutcome: '已保存并回读确认',
      archive: { status: 'completed', result: 'stored', records: [id], checkedRecords: [id] } }
    await save(state)
  })
  assert.doesNotMatch(text(await handleHook(base, options)), /Last save:|Earlier save:/)
})

test('visible adoption requires per-record basis/reference/history labels without promoting recall or save receipts', async t => {
  const output = text(await handleHook(base, await setup(t)));
  assert.match(output, /\[basis\]/);
  assert.match(output, /\[ref\]/);
  assert.match(output, /\[history\]/);
  assert.match(output, /逐条/);
  assert.match(output, /保存.*不.*可信/);
  assert.match(output, /成功读取正文/);
  assert.match(output, /默认在每条用途标签后显示（简短标题）/);
  assert.doesNotMatch(output, /默认不显示标题/);
  assert.match(output, /不超过24个Unicode字符/);
  assert.match(output, /英文、数字、空格和标点也逐个计数/);
  assert.match(output, /不附记录ID、验收编号/);
  assert.match(output, /Memory: unused/);
});
