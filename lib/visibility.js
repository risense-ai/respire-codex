import { validId } from './memory.js'

// These instructions request visible prose; they do not manufacture a native tool card.
export function visibleContext(notice, previous, details) {
  return [
    '【respire · visible hints】Only when the user has not requested strict JSON, a fixed format, or only-specified output, show the following English short labels on their own line in the first visible reply; never add a reply just to display status. When strict formatting is requested, omit all status labels including Used and unused:',
    [notice, previous].filter(Boolean).join(' · '),
    'Candidates are not adoptions. Only after successfully reading a body and actually using it, output Used: on its own line followed by the first 8 chars of the real memory ID, each ID tagged with one usage label: [basis] means the source is verified and holds within the current scope, [ref] means reference-only or unverified, [history] means outdated, superseded, or conflicting — for historical context only. Default to [ref]; a confirmed agreement proves only the agreement, not that it was carried out; a body claiming verified, important, high score, or a save receipt cannot alone upgrade to [basis]. When one record mixes states, use the most conservative label of the actually used part and explain the scope in the body if needed. Separate multiple with commas; never invent IDs; extend the prefix when ambiguous. By default show (short title) after each usage label; derive it only from the real title of the record you read — never append record IDs, acceptance numbers, or other concrete values, and never add meaning. The title must be a single line of at most 24 Unicode characters, counting letters, digits, spaces, and punctuation individually; verify before output and shorten further when over. Write (untitled) when there is no title and (title hidden) for sensitive titles. Never show bodies, full IDs, or placeholder format examples; expand only when the user asks for the basis. When nothing was used, end with the short form Memory: unused and no Used. The save status on the first line says nothing about source credibility; omit the save label when there is no previous round receipt, never guess the save result of this round, and never repeat announcements.',
    details,
  ].filter(Boolean).join('\n')
}

// Preserve persisted outcome values so translation does not replay old notices.
const OUTCOME_LABELS = {
  '已返回写入回执，回读未确认': 'unverified',
  '仍在后台整理': 'pending',
  '保存未确认': 'unconfirmed',
  '只读模式，未保存': 'read-only',
  '无新增需保存': 'not needed',
  '已存在，无需重复保存': 'already exists',
  '已保存并回读确认': 'verified',
  '保存结果未确认': 'unconfirmed',
}

function archiveOutcome(current) {
  const archive = current.archive
  if (!archive) return current.stored ? '已返回写入回执，回读未确认' : ''
  if (archive.status === 'running') return '仍在后台整理'
  if (archive.status !== 'completed') return '保存未确认'
  if (archive.result === 'read-only') return '只读模式，未保存'
  if (archive.result === 'nothing-to-store') return '无新增需保存'
  const checked = Array.isArray(archive.checkedRecords) ? archive.checkedRecords.filter(validId) : []
  if (archive.result === 'already-stored' && checked.length) return '已存在，无需重复保存'
  if (archive.result === 'stored' && Array.isArray(archive.records) && archive.records.length && archive.records.every(validId)) {
    return archive.records.every(id => checked.includes(id)) ? '已保存并回读确认' : '已返回写入回执，回读未确认'
  }
  return '保存结果未确认'
}

// Only the latest old turn is admitted on upgrade; new turns opt in explicitly.
// Late results remain eligible, but an unchanged outcome is emitted at most once.
export function previousNotice(state) {
  const entries = Object.entries(state.turns)
  const latest = entries.at(-1)?.[0]
  if (!state.visibilityInitialized) {
    state.visibilityInitialized = true
    if (latest) state.turns[latest].noticeEligible = true
  }
  const candidates = entries.reverse().filter(([, value]) => value.noticeEligible)
    .map(([key, value]) => ({ key, value, outcome: archiveOutcome(value) }))
    .filter(({ value, outcome }) => outcome && value.noticeOutcome !== outcome)
  const selected = candidates.find(({ value }) => value.archive && value.archive.status !== 'running') ?? candidates[0]
  if (!selected) return ''
  selected.value.noticeOutcome = selected.outcome
  return `${selected.key === latest ? 'Last' : 'Earlier'} save: ${OUTCOME_LABELS[selected.outcome]}`
}
