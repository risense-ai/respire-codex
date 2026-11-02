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
      if (/^\d+$/.test(tokens[binary]?.value ?? '') && ['>', '<'].includes(tokens[binary + 1]?.value)) binary++
      if (['>', '<'].includes(tokens[binary]?.value)) {
        const operator = tokens[binary++].value
        while (tokens[binary]?.value === operator) binary++
        binary++
      } else if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[binary]?.value ?? '')) binary++
      else if (['env', 'command', 'exec', 'npx'].includes(tokens[binary]?.value)) {
        binary++
        while (['--', '-y', '--yes'].includes(tokens[binary]?.value)) binary++
      } else break
    }
    if (!/(?:^|[/\\])rsrs(?:\.cmd|\.exe|\.ps1)?$/i.test(tokens[binary]?.value ?? '')) continue
    let sub = binary + 1
    while (true) {
      const option = tokens[sub]?.value ?? ''
      if (['--client-only', '--json'].includes(option)) sub++
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
  let importance = 'important', positionals = 0
  const valued = new Set(['--title', '--content', '--importance', '--parent', '--type', '--kind', '--summary', '--source-refs', '--valid-until', '--review-at', '--artifact', '--tags', '--project', '--computer', '--emotion', '--supersedes', '--see-also', '--model-task-id', '--progress-id'])
  const boolean = new Set(['--client-only', '--json', '--clear-summary', '--clear-source-refs', '--clear-valid-until', '--clear-review-at', '--clear-artifact'])
  for (let i = sub + 1; i < tokens.length; i++) {
    const token = tokens[i].value
    if (!token.startsWith('-')) { positionals++; continue }
    const equal = token.indexOf('=')
    const flag = equal < 0 ? token : token.slice(0, equal)
    if (['--force', '--merge-ids', '--clear-parent', '--direct'].includes(flag)) return deny('Forced, merged, or detached writes are not permitted by this guard')
    if (['--help', '-h'].includes(flag) && equal < 0) return {}
    if (boolean.has(flag) && equal < 0) continue
    if (!valued.has(flag)) return deny('Cannot safely inspect this rsrs write option')
    const value = equal < 0 ? tokens[++i]?.value : token.slice(equal + 1)
    if (value === undefined) return deny('A write option has no explicit value')
    if (flag === '--parent') parents.push(value)
    if (flag === '--importance') importance = value
  }
  if (positionals !== 1 || !(tokens[sub].value === 'update' ? ['important', 'normal', 'trivial'] : ['important', 'trivial']).includes(importance) || parents.length > 1) return deny('Cannot determine this rsrs write or its placement')
  if (tokens[sub].value === 'remember' && importance !== 'trivial' && !parents.length) return deny('A new important memory requires a real parent')
  if (parents.some(parent => !validId(parent))) return deny('The explicit parent must be a full literal memory id')
  if (parents.length) {
    try {
      const doc = await execute(['show', parents[0]], { timeoutMs: 5000 })
      if (doc.status !== 'ok' || doc.summary?.id !== parents[0] || doc.details?.entry?.id !== parents[0] || typeof doc.details.entry.content !== 'string') return deny('The parent could not be verified read-only')
    } catch { return deny('Parent verification failed or timed out; the write remains blocked') }
  }
  // No allow decision: the host's permission checks still apply.
  return {}
}
