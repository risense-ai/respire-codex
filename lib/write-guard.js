import { validId } from './memory.js'

const deny = reason => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: `Respire: ${reason}. Nothing was written by this hook. Use a separate, explicit rsrs command after reviewing policy, candidates, and parent bodies; DO NOT force, clear a parent, or guess one.` } })

// Inspect direct literal commands only; this is not a shell or a sandbox for arbitrary scripts.
function words(command) {
  const tokens = []
  const substitutions = []
  let value = '', quote = '', active = false, dynamic = false, incomplete = false
  const flush = () => { if (active) tokens.push({ value, dynamic }); value = ''; active = false; dynamic = false }
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]
    if (ch === '$' && command[i + 1] === '(' && quote !== "'") {
      flush(); tokens.push({ value: '$(', operator: true }); substitutions.push(quote); quote = ''; i++; continue
    }
    if (!quote && ch === ')' && substitutions.length) {
      flush(); tokens.push({ value: ')', operator: true }); quote = substitutions.pop(); continue
    }
    if (quote) {
      if (ch === quote) quote = ''
      else if (quote === '"' && ch === '\\' && /["\\$`]/.test(command[i + 1] ?? '')) { if (/[$`]/.test(command[i + 1])) dynamic = true; value += command[++i] }
      else { value += ch; if (quote === '"' && /[$`]/.test(ch)) dynamic = true }
      continue
    }
    if (ch === '"' || ch === "'") { quote = ch; active = true }
    else if (ch === '\\' && command[i + 1] && !/^[A-Za-z]:/.test(value)) { value += command[++i]; active = true }
    else if (/[\r\n;&|<>()]/.test(ch)) { flush(); tokens.push({ value: ch, operator: true }) }
    else if (/\s/.test(ch)) flush()
    else { value += ch; active = true; if (/[$`*?()[\]{}]/.test(ch)) dynamic = true }
  }
  incomplete = !!quote || !!substitutions.length
  flush()
  return { tokens, incomplete }
}

function afterRedirect(tokens, index) {
  let end = index
  if (/^(?:\d+|\*)$/.test(tokens[end]?.value ?? '') && tokens[end + 1]?.operator && ['>', '<'].includes(tokens[end + 1].value)) end++
  if (!tokens[end]?.operator || !['>', '<'].includes(tokens[end].value)) return index
  const operator = tokens[end++].value
  while (tokens[end]?.operator && tokens[end].value === operator) end++
  if (tokens[end]?.operator && tokens[end].value === '&') end++
  return Math.min(end + 1, tokens.length)
}

export async function guardWrite(event, execute) {
  if (/^mcp__.*__memory_(?:remember|update)$/.test(event.tool_name ?? '')) return deny('This structured MCP memory write cannot be verified against its target; use the explicit local rsrs path')
  if (!['Bash', 'shell', 'exec_command', 'shell_command'].includes(event.tool_name)) return {}
  const command = event.tool_input?.command
  if (typeof command !== 'string') return {}
  const { tokens, incomplete } = words(command.trim())
  const writes = []
  for (let index = 0; index < tokens.length; index++) {
    if (index && !tokens[index - 1].operator) continue
    let binary = index
    while (true) {
      const redirected = afterRedirect(tokens, binary)
      if (redirected !== binary) binary = redirected
      else if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[binary]?.value ?? '')) binary++
      else if (['env', 'command', 'exec', 'npx'].includes(tokens[binary]?.value)) {
        binary++
        while (['--', '-y', '--yes'].includes(tokens[binary]?.value)) binary++
      } else break
    }
    if (!/(?:^|[/\\])rsrs(?:\.cmd|\.exe|\.ps1)?$/i.test(tokens[binary]?.value ?? '')) continue
    let sub = binary + 1
    while (true) {
      const option = tokens[sub]?.value ?? ''
      const redirected = afterRedirect(tokens, sub)
      if (redirected !== sub) sub = redirected
      else if (['--client-only', '--json'].includes(option)) sub++
      else if (/^--(?:model-task-id|progress-id)=/.test(option)) sub++
      else if (['--model-task-id', '--progress-id'].includes(option)) sub += 2
      else break
    }
    if (['remember', 'update'].includes(tokens[sub]?.value)) writes.push({ index: binary, sub })
  }
  if (!writes.length) return {}
  const { index, sub } = writes[0]
  const invocation = index === 1 && tokens[0].value === '&'
  if (writes.length !== 1 || (index !== 0 && !invocation) || incomplete || tokens.some((token, i) => token.dynamic || (token.operator && !(invocation && i === 0)))) return deny('Cannot safely inspect a compound or dynamic rsrs write')
  const parents = []
  let importance = 'important', importanceChanged = false, positionals = 0, target
  const valued = new Set(['--title', '--content', '--importance', '--parent', '--type', '--kind', '--summary', '--source-refs', '--valid-until', '--review-at', '--artifact', '--tags', '--project', '--computer', '--emotion', '--supersedes', '--see-also', '--model-task-id', '--progress-id'])
  const boolean = new Set(['--client-only', '--json', '--clear-summary', '--clear-source-refs', '--clear-valid-until', '--clear-review-at', '--clear-artifact'])
  for (let i = sub + 1; i < tokens.length; i++) {
    const token = tokens[i].value
    if (!token.startsWith('-')) { positionals++; target ??= token; continue }
    const equal = token.indexOf('=')
    const flag = equal < 0 ? token : token.slice(0, equal)
    if (['--force', '--merge-ids', '--clear-parent', '--direct'].includes(flag)) return deny('Forced, merged, or detached writes are not permitted by this guard')
    if (['--help', '-h'].includes(flag) && equal < 0) return {}
    if (boolean.has(flag) && equal < 0) continue
    if (!valued.has(flag)) return deny('Cannot safely inspect this rsrs write option')
    const value = equal < 0 ? tokens[++i]?.value : token.slice(equal + 1)
    if (value === undefined) return deny('A write option has no explicit value')
    if (flag === '--parent') parents.push(value)
    if (flag === '--importance') { importance = value; importanceChanged = true }
  }
  if (positionals !== 1 || !(tokens[sub].value === 'update' ? ['important', 'normal', 'trivial'] : ['important', 'trivial']).includes(importance) || parents.length > 1) return deny('Cannot determine this rsrs write or its placement')
  if (tokens[sub].value === 'remember' && importance !== 'trivial' && !parents.length) return deny('A new important memory requires a real parent')
  if (parents.some(parent => !validId(parent))) return deny('The explicit parent must be a full literal memory id')
  const deadline = Date.now() + 5000
  const show = async id => {
    const timeoutMs = deadline - Date.now()
    if (!validId(id) || timeoutMs <= 0) throw new Error('invalid-parent-read')
    const doc = await execute(['show', id], { timeoutMs })
    if (doc.status !== 'ok' || doc.summary?.id !== id || doc.details?.entry?.id !== id || typeof doc.details.entry.content !== 'string') throw new Error('unverified-parent-read')
    return doc.details.entry
  }
  try {
    let parent = parents[0]
    if (tokens[sub].value === 'update' && importanceChanged && importance === 'important') {
      const entry = await show(target)
      if (!validId(entry.parent_id)) return deny('The target has no valid current parent; attach it to a verified parent BEFORE promoting it')
      await show(entry.parent_id)
      if (parent === entry.parent_id) parent = undefined
    }
    if (parent) await show(parent)
  } catch { return deny('Target or parent verification failed or timed out; the write remains blocked') }
  // No allow decision: the host's permission checks still apply.
  return {}
}
