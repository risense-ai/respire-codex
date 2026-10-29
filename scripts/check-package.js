import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const read = path => JSON.parse(readFileSync(path, 'utf8'))
const pkg = read('package.json')
const plugin = read('.codex-plugin/plugin.json')
assert.equal(pkg.version, plugin.version)
assert.equal(pkg.name, '@rsrsai/codex')
assert.equal(plugin.hooks, './hooks/hooks.json')
assert.equal(plugin.skills, './skills/')
const hooks = read('hooks/hooks.json').hooks
for (const name of ['SessionStart', 'UserPromptSubmit', 'Stop']) {
  const hook = hooks[name][0].hooks[0]
  assert.equal(hook.type, 'command')
  assert.ok(hook.command.includes('process.env.PLUGIN_ROOT'))
  assert.ok(hook.timeout <= (name === 'Stop' ? 300 : 30))
  if (name === 'Stop') assert.equal(hook.async, true)
}
const [packed] = JSON.parse(execFileSync(process.execPath, [process.env.npm_execpath, 'pack', '--dry-run', '--ignore-scripts', '--json'], { encoding: 'utf8' }))
const files = packed.files.map(file => file.path)
for (const file of ['.codex-plugin/plugin.json', 'hooks/hooks.json', 'lib/hook.js', 'lib/memory.js', 'lib/rsrs.js', 'lib/state.js', 'lib/codex.js', 'lib/archive.js', 'lib/archive-context.js', 'lib/visibility.js', 'lib/settings.js', 'skills/settings/SKILL.md', 'skills/setup/SKILL.md', 'README.md', 'LICENSE']) assert.ok(files.includes(file), file)
for (const field of ['logo', 'logoDark', 'composerIcon', 'composerIconDark']) {
  const path = plugin.interface[field]
  assert.ok(typeof path === 'string' && path.startsWith('./assets/'), field)
  assert.ok(files.includes(path.slice(2)), `${field} must be packaged`)
}
assert.ok(!files.includes('plugin.json'), 'Codex 0.163.0 skips hooks from root Agent Plugins manifests')
assert.ok(files.every(file => !/^(test|scripts|\.verification|node_modules|\.github)\//.test(file)))
console.log(`Verified ${packed.filename}: ${files.length} files`)
