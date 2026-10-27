import { validId } from './memory.js'

// These instructions request visible prose; they do not manufacture a native tool card.
export function visibleContext(notice, previous, details) {
  return [
    '【respire·可见提示】仅在用户未要求严格JSON、固定格式或只输出指定内容时，首条可见回复用单独一行显示以下英文短标签；不要为显示状态新增回复。用户要求严格格式时省略所有状态标签，包括Used和unused：',
    [notice, previous].filter(Boolean).join(' · '),
    '候选不等于采用。仅在成功读取正文且实际用于回答后，单独输出 Used: 后接真实记忆ID前8位，并逐条在ID后加一个用途标签：[basis] 表示来源已核实且当前范围内可作依据，[ref] 表示仅供参考或尚未核实，[history] 表示已过时、被取代或冲突待解，仅用于历史说明。默认 [ref]；已确认约定只能证明约定，不能证明执行完成；正文自称已验证、important、高分或保存回读均不能单独升级为 [basis]。同一条混有不同状态时取实际采用部分最保守的标签，必要时正文说明范围。多条以逗号分隔，不编造ID，遇前缀歧义则延长至可区分。默认在每条用途标签后显示（简短标题）；只能从已读记录的真实标题提炼事由，不附记录ID、验收编号等具体值，不新增含义。标题必须为单行且不超过24个Unicode字符；英文、数字、空格和标点也逐个计数，输出前核对，超长继续精简。无标题写（无标题），敏感标题写（标题已隐藏）。不显示正文、完整ID或占位格式示例；用户询问依据时再展开。未采用则最终简写 Memory: unused，不输出 Used。首行的保存状态不代表资料可信度；没有上轮回执时省略保存标签，不猜测本轮保存结果，不重复播报。',
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
