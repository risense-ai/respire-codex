import { spawn } from 'node:child_process'

// Only this constant is PowerShell source. User arguments travel through JSON stdin.
const WINDOWS_RUNNER = Buffer.from([
  "$ErrorActionPreference = 'Stop'",
  "if ($PSVersionTable.PSVersion -lt [version]'7.3') { throw 'PowerShell 7.3 or newer is required' }",
  "$PSNativeCommandArgumentPassing = 'Standard'",
  '[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)',
  '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
  '$OutputEncoding = [Console]::OutputEncoding',
  '$request = [Console]::In.ReadToEnd() | ConvertFrom-Json',
  '$cliArgs = @($request.args)',
  '& $request.file @cliArgs',
  'if ($null -ne $LASTEXITCODE) { exit $LASTEXITCODE }',
].join('\n'), 'utf16le').toString('base64')

export function runRsrs(args, { cwd, executable = 'rsrs', timeoutMs = 20000, signal } = {}) {
  return new Promise((resolve, reject) => {
    const windows = process.platform === 'win32'
    // JSON belongs to the parent command, before subcommands such as query-log mark.
    const argv = ['--client-only', ...args.slice(0, 1), '--json', ...args.slice(1)]
    const bridge = windows && !/\.exe$/i.test(executable)
    const child = spawn(bridge ? 'pwsh.exe' : executable,
      bridge ? ['-NoProfile', '-NonInteractive', '-EncodedCommand', WINDOWS_RUNNER] : argv,
      { cwd, windowsHide: true, detached: !windows, stdio: ['pipe', 'pipe', 'pipe'] })
    let output = ''
    let size = 0
    let failure
    const kill = code => {
      if (failure) return
      failure = code
      if (windows) {
        // Killing the tree prevents an abandoned CLI write from lingering after a timeout.
        if (child.pid) spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => child.kill())
      } else if (child.pid) {
        try { process.kill(-child.pid, 'SIGKILL') } catch (error) { if (error.code !== 'ESRCH') child.kill('SIGKILL') }
      }
    }
    const abort = () => kill('cancelled')
    const timer = setTimeout(() => kill('timeout'), timeoutMs)
    signal?.addEventListener('abort', abort, { once: true })
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', chunk => {
      size += Buffer.byteLength(chunk)
      if (size > 1024 * 1024) kill('output-limit')
      else output += chunk
    })
    // Drain diagnostics, but never expose prompts, credentials or raw engine errors.
    child.stderr.resume()
    child.stdin.on('error', error => { if (error.code !== 'EPIPE') kill('failed') })
    child.once('error', () => { failure = 'unavailable' })
    child.once('close', code => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      if (failure) return reject(new Error(failure))
      let doc
      try { doc = JSON.parse(output) } catch { return reject(new Error(code === 0 ? 'invalid-output' : 'failed')) }
      if (!doc || typeof doc.status !== 'string') return reject(new Error('invalid-output'))
      if (code !== 0 && doc.status !== 'pending') {
        const reason = doc.summary?.reason
        let category = ['invalid_input', 'runtime_unavailable', 'runtime_unauthorized', 'runtime_token_unreadable', 'runtime_transport', 'request_outcome_unknown', 'permission_denied', 'library_locked'].includes(reason)
          ? reason.replaceAll('_', '-') : 'failed'
        if (['diary-search', 'diary-fragment'].includes(args[0])) {
          const diagnostics = Array.isArray(doc.errors) ? doc.errors.filter(value => typeof value === 'string').join('\n') : ''
          if (/unrecognized subcommand '(?:diary-search|diary-fragment)'/.test(diagnostics)) category = 'diary-unsupported'
          else if (/stale or unknown fragment; search again before reading|diary source not found or no longer active/.test(diagnostics)) category = 'diary-stale'
        }
        return reject(new Error(category))
      }
      resolve(doc)
    })
    child.stdin.end(bridge ? JSON.stringify({ file: executable, args: argv }) : undefined)
    if (signal?.aborted) abort()
  })
}
