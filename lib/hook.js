import { previousNotice, visibleContext } from './visibility.js'
import { runRsrs } from './rsrs.js'
import { memoryStatus } from './settings.js'
import { archiveTurn } from './archive.js'
import { keyOf, withState } from './state.js'
import { RULES, STORE_PREFIX, SKIP_PREFIX, containsSecret, titleOf, recallText, storeText, record, validId } from './memory.js'

const context = (event, text) => text ? { hookSpecificOutput: { hookEventName: event, additionalContext: text } } : {}
const warning = code => ({ systemMessage: `Respire: ${code}. The current task continues; check rsrs --client-only status --json.` })

export async function handleHook(event, { dataDir = process.env.PLUGIN_DATA, call, signal, archive = archiveTurn, showStatus, settingsFile } = {}) {
  if (!record(event) || typeof event.session_id !== 'string' || !event.session_id || typeof event.cwd !== 'string') throw new Error('invalid-input')
  const name = event.hook_event_name
  if (!['SessionStart', 'UserPromptSubmit', 'Stop'].includes(name)) return {}
  const execute = call ?? ((args, options = {}) => runRsrs(args, { cwd: event.cwd, executable: process.env.RESPIRE_RSRS_PATH || 'rsrs', signal: options.signal ?? signal }))
  if (name === 'SessionStart') {
    let text = RULES
    try {
      const status = await execute(['status'])
      if (status.status !== 'ok') text += '\n【respire · status】The engine is unavailable or paused; follow engine mode and never force reads or stores.'
      if (status.summary?.unlocked === false) text += '\n【respire · status】The store is locked. Ask the user to unlock via the rsrs interactive flow; never collect passwords.'
      if (status.summary?.session?.has_session === false) text += '\n【respire · status】Not signed in. Configure the account via the rsrs interactive flow.'
    } catch { text += '\n【respire · status】Engine or runtime unavailable. Verify the rsrs install and host runtime. The current task continues.' }
    return context(name, text)
  }
  if (!dataDir) return warning('PLUGIN_DATA-missing')
  if (typeof event.turn_id !== 'string' || !event.turn_id) throw new Error('turn-id-missing')
  const turn = keyOf(event.turn_id)
  if (name === 'Stop') {
    const start = await withState(dataDir, event.session_id, async (state, save) => {
      const current = state.turns[turn]
      if (event.stop_hook_active || !current || current.phase !== 'done' || !current.ready || current.stored || current.reminded || current.continuation || current.archive) return false
      current.archive = { status: 'running' }
      await save(state)
      return true
    })
    if (!start) return {}
    const onProgress = async progress => withState(dataDir, event.session_id, async (state, save) => {
      const current = state.turns[turn]
      if (current?.archive?.status === 'running') {
        current.archive.progress = progress
        await save(state)
      }
    })
    let result
    try { result = { status: 'completed', ...await archive(event, { call: execute, signal, onProgress }) } }
    catch (error) {
      result = { status: 'unconfirmed', error: /^[a-z-]{1,64}$/.test(error.message) ? error.message : 'archive-unconfirmed' }
      if (error.archiveProgress) result.progress = error.archiveProgress
      if (error.archiveFailure) result.failure = error.archiveFailure
      if (Array.isArray(error.archiveRecords)) result.records = error.archiveRecords
      if (typeof error.method === 'string' && /^[a-z/]{1,64}$/.test(error.method)) {
        result.request = { method: error.method }
        if (Number.isSafeInteger(error.rpcCode)) result.request.code = error.rpcCode
      }
    }
    await withState(dataDir, event.session_id, async (state, save) => {
      if (state.turns[turn]) state.turns[turn].archive = result
      await save(state)
    })
    const request = result.request ? ` (${result.request.method}${result.request.code === undefined ? '' : `, JSON-RPC ${result.request.code}`})` : ''
    return result.status === 'completed' ? {} : { systemMessage: `Respire: ${result.error}${request}. The background wrap-up is unconfirmed; verify against the store first, never retry automatically. Check the Codex CLI/app-server and rsrs status.` }
  }
  let settingsWarning = ''
  if (showStatus === undefined) {
    try { showStatus = (await memoryStatus(settingsFile)).showMemoryStatus }
    catch (error) {
      showStatus = process.env.RESPIRE_MEMORY_STATUS !== '0'
      settingsWarning = `Respire: ${error.message}. Display preference not loaded; using the previous environment setting or default for now; run Respire settings to choose again. Recall and storage continue.`
    }
  }
  const output = await withState(dataDir, event.session_id, async (state, save) => {
    if (typeof event.prompt !== 'string') throw new Error('prompt-missing')
    if (state.turns[turn]) return context(name, '【respire · duplicate event】This turn was already processed or its result is unconfirmed; do not repeat the read/store; verify against the store when needed.')
    // Persist intent before any write. A crash must never cause an automatic retry.
    const previous = showStatus ? previousNotice(state) : ''
    const current = { phase: 'processing', ready: false, stored: false, reminded: false, ...(showStatus ? { noticeEligible: true } : {}) }
    state.turns[turn] = current
    state.turns = Object.fromEntries(Object.entries(state.turns).slice(-32))
    const prompt = event.prompt.trim()
    if (state.continuation && prompt === state.continuation) {
      current.continuation = true
      current.phase = 'done'
      delete state.continuation
      await save(state)
      return {}
    }
    delete state.continuation
    await save(state)
    let text = ''
    const store = STORE_PREFIX.exec(prompt)
    let notice = store ? 'Save: skipped' : 'Memory: skipped'
    if (!prompt || SKIP_PREFIX.test(prompt)) {
      // /nomem skips this input's recall only; the bounded stop reminder remains available.
      current.ready = !!prompt
    } else if (containsSecret(prompt)) {
      notice = 'Memory: skipped (sensitive)'
      text = '【respire · skipped】The input looks like it contains a credential and was not sent to the memory engine. Provide only the fact with the secret removed, or a safe location pointer.'
    } else if (store && event.permission_mode === 'plan') {
      notice = 'Save: read-only'
      text = '【respire · not stored】Plan mode is active; no storage is performed.'
    } else {
      try {
        if (store) {
          // remember and its read-back share one host budget: UserPromptSubmit is capped at 30s by the host.
          const t0 = Date.now()
          const content = prompt.slice(store[0].length).trim()
          if (!content) text = '【respire · not stored】The content is empty; provide the fact to save.'
          else {
            const doc = await execute(['remember', content, '--title', titleOf(content), '--importance', 'important'])
            const result = storeText(doc)
            current.stored = result.stored
            current.ready = result.stored || doc.status === 'pending'
            text = result.text
            if (result.stored && validId(doc.summary?.id)) {
              // Write read-back (R11): run only inside the remaining host budget and verify the
              // full id, the exact title and the complete content — a prefix match is not verification.
              const id = doc.summary.id
              const sentTitle = titleOf(content)
              const budget = Number(process.env.RESPIRE_HOOK_BUDGET_MS)
              // Reserve a 2.5s output/cleanup margin; below 1.5s the show is not even started.
              const remaining = (Number.isFinite(budget) && budget > 0 ? budget : 30000) - (Date.now() - t0) - 2500
              let verdict = 'unavailable'
              if (remaining >= 1500) {
                const overdue = Symbol('overdue')
                let guard
                try {
                  // The race never blocks on a slow engine: on timeout the child is left to the
                  // rsrs runner's own 20s kill timer / host cleanup, and the receipt is emitted now.
                  const shown = await Promise.race([
                    execute(['show', id]),
                    new Promise(resolve => { guard = setTimeout(() => resolve(overdue), remaining - 500) }),
                  ])
                  const summary = record(shown?.summary)
                  const entry = record(shown?.details?.entry)
                  const bodyOf = value => (typeof value === 'string' ? value.trim() : undefined)
                  if (shown !== overdue && shown.status === 'ok' && summary && entry) {
                    const idOk = summary.id === id
                    const titleOk = entry.title === sentTitle
                    const bodyOk = bodyOf(entry.content) === content
                    verdict = idOk && titleOk && bodyOk ? 'verified' : 'mismatch'
                  }
                } catch { verdict = 'unavailable' } finally { clearTimeout(guard) }
              }
              text += verdict === 'verified'
                ? ' Write verified by read-back (id, title and full content match).'
                : verdict === 'mismatch'
                  ? ` Read-back shows a DIFFERENT id, title or content than sent — inspect rsrs --client-only show ${id.slice(0, 8)} before refining the title.`
                  : ` Read-back unavailable — if it matters, verify with rsrs --client-only show ${id.slice(0, 8)}.`
            }
            notice = result.stored ? 'Save: unverified' : doc.status === 'pending' ? 'Save: needs review' : doc.status === 'skip' ? 'Save: skipped' : 'Save: unconfirmed'
          }
        } else if (prompt.length >= 2) {
          const query = prompt.replace(/^\$\s*skill\s*:\s*\S+\s*/i, '').trim() || prompt
          const doc = await execute(['recall', query.slice(0, 8000), '--limit', '5', '--titles'])
          text = recallText(doc, showStatus ? 1200 : 1500)
          const count = (text.match(/\n- \[/g) ?? []).length
          notice = count ? `Memory: ${count} found` : doc.status === 'ok' || (doc.status === 'skip' && doc.summary?.count === 0) ? 'Memory: no match' : 'Memory: skipped'
          // A successful empty search can still introduce new knowledge; paused/error responses cannot.
          current.ready = doc.status === 'ok' || (doc.status === 'skip' && doc.summary?.count === 0)
        }
      } catch {
        notice = store ? 'Save: unconfirmed' : 'Memory: unavailable'
        text = store
          ? '【respire · store unconfirmed】It may have been written; verify against the store first; never retry automatically or claim success.'
          : '【respire · recall unavailable】No memory was obtained; continue with the current materials and verify the host runtime.'
      }
    }
    current.phase = 'done'
    await save(state)
    return context(name, showStatus ? visibleContext(notice, previous, text) : ['【respire · display preference】Do not output Memory, Used, or save-status labels this round, and do not carry over display instructions from earlier rounds; recall, storage, and necessary error diagnostics continue as usual.', text].filter(Boolean).join('\n'))
  })
  return settingsWarning ? { ...output, systemMessage: settingsWarning } : output
}

export async function main() {
  const abort = new AbortController()
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => abort.abort())
  try {
    const chunks = []
    let size = 0
    for await (const chunk of process.stdin) {
      size += chunk.length
      if (size > 1024 * 1024) throw new Error('input-limit')
      chunks.push(chunk)
    }
    const event = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    const output = await handleHook(event, { signal: abort.signal })
    if (event.hook_event_name !== 'Stop' || Object.keys(output).length) console.log(JSON.stringify(output))
  } catch {
    console.log(JSON.stringify(warning('hook-failed')))
  }
}
