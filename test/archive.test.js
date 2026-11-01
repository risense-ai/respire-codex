import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawn } from 'node:child_process'
import { memoryTools, archiveTurn } from '../lib/archive.js'
import { connectCodex } from '../lib/codex.js'
import { handleHook } from '../lib/hook.js'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { keyOf } from '../lib/state.js'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const id = '12345678-1234-1234-1234-123456789012'
const next = '87654321-4321-4321-4321-210987654321'
const read = command => ({ command, args: command === 'show' ? [id] : command === 'recall' ? ['project', '--titles', '--json'] : [] })
const update = { command: 'update', args: [id, '--title', '项目验收已通过', '--content', '【前因】验收。【行为】核对。【后果】通过。'] }
async function prime(memory) {
  for (const command of ['agent-config', 'recall', 'prompt', 'show']) await memory.run(read(command))
}

test('worker failures preserve the original cause and only safe diagnostic fields', async () => {
  const failure = { message: 'token=private-upstream-text', codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 502 } } }
  const work = archiveTurn({ session_id: 'p', turn_id: 't', cwd: process.cwd() }, {
    call: async () => assert.fail('failed worker must not access memory'),
    connect: options => ({
      notify() {}, close() {}, exited: new Promise(() => {}),
      async request(method, params) {
        if (method === 'config/read') return { config: {} }
        if (method === 'thread/read') return { thread: {} }
        if (method === 'thread/turns/list') return { data: [{ id: 't', items: params.itemsView === 'full' ? [{ type: 'agentMessage', text: 'proposal' }] : [] }], nextCursor: null }
        if (method === 'thread/start') return { thread: { id: 'worker' } }
        if (method === 'turn/start') options.onNotification({ method: 'turn/completed', params: { turn: { status: 'failed', error: failure } } })
        return {}
      },
    }),
  })
  await assert.rejects(work, error => {
    assert.equal(error.message, 'archive-incomplete')
    assert.equal(error.cause, failure)
    assert.deepEqual(error.archiveFailure, { status: 'failed', type: 'httpConnectionFailed', httpStatus: 502 })
    assert.ok(!JSON.stringify(error.archiveFailure).includes('private-upstream-text'))
    return true
  })
})

test('the internal deadline is distinct from cancellation by the parent', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const work = archiveTurn({ session_id: 'p', turn_id: 't', cwd: process.cwd() }, {
    call: async () => assert.fail('expired worker must not access memory'),
    connect: () => ({ notify() {}, close() {}, exited: new Promise(() => {}), request: () => new Promise(() => {}) }),
  })
  t.mock.timers.tick(280000)
  await assert.rejects(work, /archive-timeout/)
})

test('archive writes require a successful agent-config read first (CX-02 hard precondition)', async () => {
  const memory = memoryTools(async () => ({ status: 'ok', summary: { id } }))
  // recall/prompt/show alone no longer unlock writes — the mode check is executor-enforced
  for (const command of ['recall', 'prompt', 'show']) await memory.run(read(command))
  await assert.rejects(memory.run(update), /mode-unconfirmed/)
  await memory.run(read('agent-config'))
  await memory.run(update)
  await memory.run(read('show'))
  assert.deepEqual(memory.finish(JSON.stringify({ result: 'stored', ids: [id] })).records, [id])
})

test('archive tools require policy, candidates, real write receipts and readback', async () => {
  const calls = []
  let wrongShow = true
  const memory = memoryTools(async args => { calls.push(args); return { status: 'ok', summary: { id: args[0] === 'remember' || (args[0] === 'show' && args[1] === next && !wrongShow) ? next : id } } })
  await assert.rejects(memory.run(update), /read-before-write/)
  await prime(memory)
  assert.ok(calls.every(args => !args.includes('--json')))
  await memory.run(update)
  assert.throws(() => memory.finish(JSON.stringify({ result: 'stored', ids: [id] })), /archive-unverified/)
  await memory.run(read('show'))
  await assert.rejects(memory.run(update), /duplicate-write/)
  await assert.rejects(memory.run({ command: 'remember', args: ['new fact', '--title', 'title', '--parent', next] }), /shown-parent-required/)
  await memory.run({ command: 'remember', args: ['new fact', '--title', 'title', '--parent', id] })
  assert.throws(() => memory.finish(JSON.stringify({ result: 'stored', ids: [id] })), /archive-unverified/)
  await assert.rejects(memory.run({ command: 'show', args: [next] }), /invalid-readback/)
  assert.throws(() => memory.finish(JSON.stringify({ result: 'stored', ids: [id] })), /archive-unverified/)
  wrongShow = false
  await memory.run({ command: 'show', args: [next] })
  assert.deepEqual(memory.finish(JSON.stringify({ result: 'stored', ids: [id, next] })).records, [id, next])
  assert.deepEqual(memory.finish(JSON.stringify({ result: 'stored', ids: [] })).checkedRecords, [id, next])
  await memory.run({ command: 'remember', args: ['process diary', '--importance', 'trivial'] })
  assert.throws(() => memory.finish(JSON.stringify({ result: 'stored', ids: [id, next] })), /archive-unverified/)
  await memory.run({ command: 'show', args: [next] })
  assert.deepEqual(memory.finish(JSON.stringify({ result: 'stored', ids: [] })).checkedRecords, [id, next])
})

test('archive tools reject destructive operations, secrets, plan writes and unconfirmed retries', async () => {
  const call = async () => ({ status: 'ok', summary: { id } })
  const memory = memoryTools(call)
  await prime(memory)
  await assert.rejects(memory.run({ command: 'restart', args: [] }), /invalid-memory-call/)
  await assert.rejects(memory.run({ command: 'remember', args: ['fact', '--force'] }), /forbidden-memory-option/)
  await assert.rejects(memory.run({ command: 'taxonomy', args: ['--ensure', 'new'] }), /forbidden-memory-option/)
  await assert.rejects(memory.run({ command: 'agent-config', args: ['--set', 'diary_mode=verbose'] }), /forbidden-memory-option/)
  await assert.rejects(memory.run({ ...update, args: [...update.args, 'password=hidden'] }), /secret-content/)
  const plan = memoryTools(call, { readOnly: true })
  await prime(plan)
  await assert.rejects(plan.run(update), /read-only/)
  let writes = 0
  const uncertain = memoryTools(async args => {
    if (args[0] === 'update') { writes++; throw new Error('timeout') }
    return call()
  })
  await prime(uncertain)
  await assert.rejects(uncertain.run(update), /timeout/)
  await assert.rejects(uncertain.run({ ...update, args: [...update.args, '--importance', 'important'] }), /read-before-write/)
  assert.equal(writes, 1)
  assert.throws(() => uncertain.finish('{"result":"nothing-to-store","ids":[]}'), /archive-unconfirmed/)
})

test('an empty successful recall still permits policy reading and an authorized new fact', async () => {
  const memory = memoryTools(async args => args[0] === 'recall'
    ? { status: 'skip', summary: { count: 0 } }
    : { status: 'ok', summary: { id } })
  await prime(memory)
  await memory.run(update)
  await memory.run(read('show'))
  assert.equal(memory.finish(JSON.stringify({ result: 'stored', ids: [id] })).result, 'stored')
})

test('background worker reads the exact turn, exposes a memory tool and verifies completion', async () => {
  let settings
  let closed = false
  let input
  const reads = []
  const result = await archiveTurn({ session_id: 'parent', turn_id: 'target', cwd: process.cwd(), model: 'inherited-model' }, {
    call: async () => ({ status: 'ok', summary: { id } }),
    connect: options => ({
      notify() {}, close() { closed = true }, exited: new Promise(() => {}),
      async request(method, params) {
        if (method === 'config/read') return { config: { mcp_servers: { external: { enabled: true } } } }
        if (method === 'thread/read') {
          assert.equal(params.includeTurns, false)
          return { thread: { modelProvider: 'configured-provider' } }
        }
        if (method === 'thread/turns/list') {
          reads.push(params)
          assert.equal(params.limit, 1)
          assert.equal(params.sortDirection, 'desc')
          if (!params.cursor) {
            assert.equal(params.itemsView, 'notLoaded')
            return { data: [{ id: 'unrelated' }], nextCursor: 'older' }
          }
          assert.equal(params.cursor, 'older')
          return { data: [{ id: 'target', items: params.itemsView === 'full' ? [{ type: 'userMessage', content: [{ type: 'text', text: 'read-only project check' }] }, { type: 'agentMessage', text: 'checked' }] : [] }], nextCursor: null }
        }
        if (method === 'thread/start') { settings = params; return { thread: { id: 'worker' } } }
        if (method === 'turn/start') {
          input = params.input[0].text
          for (const command of ['recall', 'prompt', 'show']) {
            const response = await options.onRequest({ method: 'item/tool/call', params: { tool: 'respire_memory', arguments: read(command) } })
            assert.equal(response.success, true)
          }
          options.onNotification({ method: 'item/completed', params: { item: { type: 'agentMessage', text: JSON.stringify({ result: 'already-stored', ids: [id] }) } } })
          options.onNotification({ method: 'turn/completed', params: { turn: { status: 'completed' } } })
        }
        return {}
      },
    }),
  })
  assert.deepEqual(reads.map(page => page.itemsView), ['notLoaded', 'notLoaded', 'full'])
  assert.match(input, /read-only project check/)
  assert.ok(!input.includes('unrelated'))
  assert.equal(settings.ephemeral, true)
  assert.equal(settings.sandbox, 'read-only')
  assert.equal(settings.config.features.hooks, false)
  assert.equal(settings.config.features.apps, false)
  assert.equal(settings.config.features.shell_tool, false)
  assert.deepEqual(settings.config.mcp_servers, { external: { enabled: false } })
  assert.equal(settings.model, 'inherited-model')
  assert.equal(settings.modelProvider, 'configured-provider')
  assert.equal(settings.dynamicTools.length, 1)
  assert.equal(result.result, 'already-stored')
  assert.equal(closed, true)
})


test('missing and oversized target turns fail before any memory write', async () => {
  for (const oversized of [false, true]) {
    const result = archiveTurn({ session_id: 'parent', turn_id: 'target', cwd: process.cwd() }, {
      call: async () => { assert.fail('must not call memory') },
      connect: () => ({
        notify() {}, close() {}, exited: new Promise(() => {}),
        async request(method, params) {
          if (method === 'config/read') return { config: {} }
          if (method === 'thread/read') { assert.equal(params.includeTurns, false); return { thread: {} } }
          if (method === 'thread/turns/list') return { data: oversized ? [{ id: 'target', items: params.itemsView === 'full' ? [{ type: 'agentMessage', text: 'x'.repeat(700000) }] : [] }] : [], nextCursor: null }
          assert.notEqual(method, 'thread/start')
          return {}
        },
      }),
    })
    await assert.rejects(result, oversized ? /archive-segment-limit/ : /turn-not-readable/)
  }
})

test('Stop releases its state lock, records failure and never retries a replay', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'respire archive '))
  t.after(() => rm(dataDir, { recursive: true, force: true }))
  const event = { session_id: 'session', turn_id: 'one', cwd: process.cwd(), prompt: 'known project', hook_event_name: 'UserPromptSubmit' }
  let started
  let release
  const running = new Promise(resolve => { started = resolve })
  const wait = new Promise(resolve => { release = resolve })
  let archives = 0
  const options = { dataDir, call: async () => ({ status: 'ok', details: [] }), archive: async () => { archives++; started(); await wait; throw Object.assign(new Error('codex-request-failed'), { method: 'thread/turns/list', rpcCode: -32602, cause: { message: 'private upstream content' } }) } }
  await handleHook(event, options)
  const stop = { ...event, hook_event_name: 'Stop' }
  const work = handleHook(stop, options)
  await running
  await handleHook({ ...event, turn_id: 'two' }, options)
  assert.deepEqual(await handleHook(stop, options), {})
  release()
  const warning = (await work).systemMessage
  assert.match(warning, /codex-request-failed.*thread\/turns\/list.*-32602/)
  const state = JSON.parse(await readFile(join(dataDir, 'sessions', `${keyOf(event.session_id)}.json`), 'utf8'))
  assert.deepEqual(state.turns[keyOf(event.turn_id)].archive, { status: 'unconfirmed', error: 'codex-request-failed', request: { method: 'thread/turns/list', code: -32602 } })
  assert.ok(!JSON.stringify(state).includes('private upstream content'))
  assert.ok(!warning.includes('private upstream content'))
  assert.deepEqual(await handleHook(stop, options), {})
  assert.equal(archives, 1)
})

test('Codex JSON transport handles a real subprocess, Unicode and cancellation', async () => {
  const abort = new AbortController()
  const script = `const rl=require('node:readline').createInterface({input:process.stdin});rl.on('line',line=>{const m=JSON.parse(line);console.log(JSON.stringify(m.method==='fail'?{id:m.id,error:{code:-32602,message:'private upstream content',data:{stage:'read'}}}:{id:m.id,result:m.params}))})`
  const client = connectCodex({ signal: abort.signal, spawnProcess: (file, args, options) => {
    assert.ok(args.includes('hooks'))
    assert.ok(args.includes('mcp_servers={}'))
    return spawn(process.execPath, ['-e', script], options)
  } })
  const value = { text: '中文 "quotes"\nsecond line & $()' }
  assert.deepEqual(await client.request('echo', value), value)
  await assert.rejects(client.request('fail', {}), error => {
    assert.equal(error.message, 'codex-request-failed')
    assert.equal(error.method, 'fail')
    assert.equal(error.rpcCode, -32602)
    assert.deepEqual(error.cause, { code: -32602, message: 'private upstream content', data: { stage: 'read' } })
    return true
  })
  abort.abort()
  await assert.rejects(client.request('echo', value), /cancelled/)
  await client.exited
})

function segmentedFixture(items, { failExtraction = false, abortDuringExtraction = false, readUsers = false, receiptResult = 'already-stored' } = {}) {
  let options, activeSettings
  const settings = [], inputs = [], stages = [], memoryCalls = []
  const controller = new AbortController()
  const finish = text => {
    options.onNotification({method:'item/completed',params:{item:{type:'agentMessage',text}}})
    options.onNotification({method:'turn/completed',params:{turn:{status:'completed'}}})
  }
  return {
    settings, inputs, stages, memoryCalls,
    run: () => archiveTurn({session_id:'parent',turn_id:'target',cwd:process.cwd()},{
      signal:controller.signal,
      onProgress: async value => stages.push(value),
      call:async args => { memoryCalls.push(args[0]); return {status:'ok',summary:{id}} },
      connect: value => {
        options=value
        return { notify(){},close(){},exited:new Promise(()=>{}), async request(method,params){
          if(method==='config/read') return {config:{}}
          if(method==='thread/read') return {thread:{}}
          if(method==='thread/turns/list') return {data:[{id:'target',items:params.itemsView==='full'?items:[]}],nextCursor:null}
          if(method==='thread/start'){activeSettings=params;settings.push(params);return {thread:{id:'worker-'+settings.length}}}
          if(method==='turn/start'){
            inputs.push(params.input[0].text)
            if(activeSettings.dynamicTools.length===0){
              if(abortDuringExtraction){controller.abort();return {}}
              if(failExtraction){finish('not valid JSON');return {}}
              finish(JSON.stringify({facts:[],constraints:[]}))
            }else{
              if(readUsers){
                const payload=JSON.parse(params.input[0].text.split('\n').slice(1).join('\n'))
                for(const source of payload.unreadUserSources || []){
                  const response=await options.onRequest({method:'item/tool/call',params:{tool:'respire_turn_evidence',arguments:{sources:[source]}}})
                  assert.equal(response.success,true)
                }
              }
              for(const command of ['agent-config','recall','prompt','show']){
                const result=await options.onRequest({method:'item/tool/call',params:{tool:'respire_memory',arguments:read(command)}})
                assert.equal(result.success,true)
              }
              finish(JSON.stringify({result:receiptResult,ids:receiptResult === 'already-stored' ? [id] : []}))
            }
          }
          return {}
        }}
      }
    })
  }
}

test('segmented archival cannot finish without reviewing original user evidence', async () => {
  const items = [{ type: 'userMessage', content: [{ type: 'text', text: 'User authorization boundary. '.repeat(11000) }] }, { type: 'agentMessage', text: 'Acknowledged.' }]
  for (const receiptResult of ['already-stored', 'nothing-to-store']) {
    const unread = segmentedFixture(items, { receiptResult })
    await assert.rejects(unread.run(), /archive-user-evidence-unread/)
    assert.ok(unread.memoryCalls.every(command => !['remember', 'update'].includes(command)))
    const reviewed = segmentedFixture(items, { readUsers: true, receiptResult })
    assert.equal((await reviewed.run()).result, receiptResult)
  }
})

test('oversized dialogue is extracted without memory access then archived once', async () => {
  const items=[{type:'userMessage',content:[{type:'text',text:'No deployment'}]},{type:'agentMessage',text:'discussion '.repeat(27000)}]
  const fixture=segmentedFixture(items)
  const result=await fixture.run()
  assert.ok(fixture.settings.length>2)
  assert.ok(fixture.settings.slice(0,-1).every(x=>x.dynamicTools.length===0))
  assert.equal(fixture.settings.at(-1).dynamicTools[0].name,'respire_memory')
  assert.deepEqual(fixture.memoryCalls,['agent-config','recall','prompt','show'])
  assert.equal(result.result,'already-stored')
  assert.ok(result.context.chunks>1)
  assert.equal(result.context.extractedChunks,result.context.chunks)
  assert.ok(fixture.inputs.every(x=>x.length<128000))
})

test('failed or cancelled extraction never exposes memory writes', async () => {
  const items=[{type:'agentMessage',text:'discussion '.repeat(27000)}]
  for(const mode of [{failExtraction:true},{abortDuringExtraction:true}]){
    const fixture=segmentedFixture(items,mode)
    await assert.rejects(fixture.run(),/invalid-extraction|cancelled/)
    assert.equal(fixture.memoryCalls.length,0)
    assert.ok(fixture.settings.every(x=>x.dynamicTools.length===0))
  }
})

test('Stop persists bounded progress and known IDs after a failed extraction or archival', async t => {
  const dataDir=await mkdtemp(join(tmpdir(),'respire progress '))
  t.after(()=>rm(dataDir,{recursive:true,force:true}))
  const event={session_id:'progress',turn_id:'one',cwd:process.cwd(),prompt:'project',hook_event_name:'UserPromptSubmit'}
  const progress={stage:'extracting',chunks:3,extractedChunks:1,coverage:'partial'}
  const failure={status:'failed',type:'httpConnectionFailed',httpStatus:502}
  const options={dataDir,call:async()=>({status:'ok',details:[]}),archive:async(event,{onProgress})=>{
    await onProgress(progress)
    const state=JSON.parse(await readFile(join(dataDir,'sessions',keyOf('progress')+'.json'),'utf8'))
    assert.deepEqual(state.turns[keyOf('one')].archive.progress,progress)
    throw Object.assign(new Error('invalid-extraction'),{archiveProgress:progress,archiveRecords:[id],archiveFailure:failure,cause:{message:'token=private-upstream-text'}})
  }}
  await handleHook(event,options)
  await handleHook({...event,hook_event_name:'Stop'},options)
  const state=JSON.parse(await readFile(join(dataDir,'sessions',keyOf('progress')+'.json'),'utf8'))
  assert.equal(state.turns[keyOf('one')].archive.status,'unconfirmed')
  assert.deepEqual(state.turns[keyOf('one')].archive.progress,progress)
  assert.deepEqual(state.turns[keyOf('one')].archive.records,[id])
  assert.deepEqual(state.turns[keyOf('one')].archive.failure,failure)
  assert.ok(!JSON.stringify(state).includes('private-upstream-text'))
})

test('segmented archival requires original long user evidence before writing', async () => {
  const items=[{type:'userMessage',content:[{type:'text',text:'Do not deploy. '.repeat(20000)}]},{type:'agentMessage',text:'Proposal only.'}]
  let settings, finalPayload, realWrites=0
  const result=await archiveTurn({session_id:'p',turn_id:'t',cwd:process.cwd()},{
    call:async args=>{if(args[0]==='update')realWrites++;return {status:'ok',summary:{id}}},
    connect:options=>({
      notify(){},close(){},exited:new Promise(()=>{}),
      async request(method,params){
        if(method==='config/read')return {config:{}}
        if(method==='thread/read')return {thread:{}}
        if(method==='thread/turns/list')return {data:[{id:'t',items:params.itemsView==='full'?items:[]}],nextCursor:null}
        if(method==='thread/start'){settings=params;return {thread:{id:'w'}}}
        if(method==='turn/start'){
          let final
          if(settings.dynamicTools.length===0)final=JSON.stringify({facts:[],constraints:[]})
          else{
            finalPayload=JSON.parse(params.input[0].text.split('\n').slice(1).join('\n'))
            for(const command of ['agent-config','recall','prompt','show'])await options.onRequest({method:'item/tool/call',params:{tool:'respire_memory',arguments:read(command)}})
            const blocked=await options.onRequest({method:'item/tool/call',params:{tool:'respire_memory',arguments:update}})
            assert.equal(blocked.success,false)
            assert.match(blocked.contentItems[0].text,/read-user-evidence-before-write/)
            for(const source of finalPayload.unreadUserSources){
              const evidence=await options.onRequest({method:'item/tool/call',params:{tool:'respire_turn_evidence',arguments:{sources:[source]}}})
              assert.equal(evidence.success,true)
            }
            const written=await options.onRequest({method:'item/tool/call',params:{tool:'respire_memory',arguments:update}})
            assert.equal(written.success,true)
            await options.onRequest({method:'item/tool/call',params:{tool:'respire_memory',arguments:read('show')}})
            final=JSON.stringify({result:'stored',ids:[id]})
          }
          options.onNotification({method:'item/completed',params:{item:{type:'agentMessage',text:final}}})
          options.onNotification({method:'turn/completed',params:{turn:{status:'completed'}}})
        }
        return {}
      }
    })
  })
  assert.equal(realWrites,1)
  assert.ok(finalPayload.unreadUserSources.length>0)
  assert.equal(result.result,'stored')
})

test('archive cancellation reaches an in-flight memory command', async () => {
  const controller=new AbortController()
  let receivedSignal
  let stopped=false
  const call=async (args, options)=>{
    if(args[0]!=='update')return {status:'ok',summary:{id}}
    receivedSignal=options?.signal
    controller.abort()
    if(!receivedSignal)throw new Error('missing-call-signal')
    if(receivedSignal.aborted){stopped=true;throw new Error('cancelled')}
    throw new Error('signal-not-aborted')
  }
  const work=archiveTurn({session_id:'p',turn_id:'t',cwd:process.cwd()},{
    signal:controller.signal,call,
    connect:options=>({notify(){},close(){},exited:new Promise(()=>{}),async request(method,params){
      if(method==='config/read')return {config:{}}
      if(method==='thread/read')return {thread:{}}
      if(method==='thread/turns/list')return {data:[{id:'t',items:params.itemsView==='full'?[{type:'agentMessage',text:'confirmed fact'}]:[]}],nextCursor:null}
      if(method==='thread/start')return {thread:{id:'w'}}
      if(method==='turn/start'){
        for(const command of ['agent-config','recall','prompt','show'])await options.onRequest({method:'item/tool/call',params:{tool:'respire_memory',arguments:read(command)}})
        await options.onRequest({method:'item/tool/call',params:{tool:'respire_memory',arguments:update}})
      }
      return {}
    }})
  })
  await assert.rejects(work,/cancelled/)
  assert.ok(receivedSignal)
  assert.equal(stopped,true)
})

test('late extraction notifications cannot complete the next extraction before it starts', async () => {
  const controller=new AbortController()
  let workers=0, settings, finalWorkerStarted=false
  const items=[{type:'agentMessage',text:'discussion '.repeat(27000)}]
  const work=archiveTurn({session_id:'p',turn_id:'t',cwd:process.cwd()},{
    signal:controller.signal,call:async()=>{assert.fail('must not access memory')},
    connect:options=>({notify(){},close(){},exited:new Promise(()=>{}),async request(method,params){
      if(method==='config/read')return {config:{}}
      if(method==='thread/read')return {thread:{}}
      if(method==='thread/turns/list')return {data:[{id:'t',items:params.itemsView==='full'?items:[]}],nextCursor:null}
      if(method==='thread/start'){
        settings=params;workers++
        if(workers===2){
          options.onNotification({method:'item/completed',params:{threadId:'w1',item:{type:'agentMessage',text:JSON.stringify({facts:[],constraints:[]})}}})
          options.onNotification({method:'turn/completed',params:{threadId:'w1',turn:{status:'completed'}}})
        }
        return {thread:{id:'w'+workers}}
      }
      if(method==='turn/start'){
        if(settings.dynamicTools.length){finalWorkerStarted=true;controller.abort();return {}}
        if(workers===1){
          options.onNotification({method:'item/completed',params:{threadId:'w1',item:{type:'agentMessage',text:JSON.stringify({facts:[],constraints:[]})}}})
          options.onNotification({method:'turn/completed',params:{threadId:'w1',turn:{status:'completed'}}})
        }else if(workers===2){
          setTimeout(()=>controller.abort(),30)
        }else{
          // A later worker means the incomplete second extraction was incorrectly accepted.
          finalWorkerStarted=true;controller.abort()
        }
      }
      return {}
    }})
  })
  await assert.rejects(work,/cancelled/)
  assert.equal(workers,2)
  assert.equal(finalWorkerStarted,false)
})

test('diary reads are bounded and never count as verified main-memory evidence', async () => {
  let args
  const memory = memoryTools(async input => {
    args = input
    return input[0].startsWith('diary-')
      ? { status: 'ok', details: { items: [{ source_id: id, text: '建议切换认证方式', evidence_state: 'reference' }] } }
      : { status: 'ok', summary: { id } }
  })
  for (const command of ['agent-config', 'recall', 'prompt']) await memory.run(read(command))
  const doc = await memory.run({ command: 'diary-search', args: ['认证'] })
  assert.deepEqual(args, ['diary-search', '认证', '--limit', '5', '--max-chars', '4000', '--mode', 'hybrid'])
  assert.equal(doc.details.items[0].evidence_state, 'reference')
  await memory.run({ command: 'diary-fragment', args: [id, 'd1.0.80.full-version-locator'] })
  assert.deepEqual(args, ['diary-fragment', id, 'd1.0.80.full-version-locator', '--neighbors', '0', '--max-chars', '4000'])
  await assert.rejects(memory.run(update), /read-before-write/)
  await memory.run(read('show'))
  await memory.run(update)
  await memory.run({ command: 'diary-fragment', args: [id, 'd1.0.80.full-version-locator'] })
  assert.throws(() => memory.finish(JSON.stringify({ result: 'stored', ids: [id] })), /archive-unverified/)
  await memory.run(read('show'))
  assert.deepEqual(memory.finish(JSON.stringify({ result: 'stored', ids: [id] })).records, [id])
  await memory.run({ command: 'diary-search', args: ['😀'.repeat(500)] })
  await assert.rejects(memory.run({ command: 'diary-search', args: ['😀'.repeat(501)] }), /bounded-diary-query/)
  await assert.rejects(memory.run({ command: 'diary-search', args: ['认证', '--max-chars', '999999'] }), /bounded-diary/)
  await assert.rejects(memory.run({ command: 'diary-fragment', args: [id, 'part', '--neighbors', '99'] }), /bounded-diary/)
  let calls = 0
  const unsupported = memoryTools(async () => { calls++; throw new Error('diary-unsupported') })
  for (const command of ['diary-search', 'diary-fragment']) {
    await assert.rejects(unsupported.run({ command, args: command === 'diary-search' ? ['认证'] : [id, 'part'] }), /diary-unsupported/)
  }
  assert.equal(calls, 1)
});
test('unexpected oversized diary responses fail closed instead of flooding model context', async () => {
  const memory = memoryTools(async () => ({status:'ok',details:{items:[{text:'x'.repeat(9000)}]}}));
  await assert.rejects(memory.run({command:'diary-search',args:['query']}), /diary-output-too-large/);
});
