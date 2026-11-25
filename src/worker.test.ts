// Runs src/worker.ts's activate(orca) with the orca object Orca passes, over a mock host.
// The mock host answers the workspace calls; `task --list-all` runs for real against fixtures/.
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, assert, beforeEach, hostError, mockHost, mountWorker, test } from 'orca/testing'
import type { TestWorker } from 'orca/testing'
import * as main from './worker'

const fixtures = fileURLToPath(new URL('../fixtures', import.meta.url))
const goTaskAvailable = spawnSync('go-task', ['--version']).status === 0

/** A run's marks live in its command as printf halves; tests reassemble what reached the
 *  host. The halves are the point: a typed line must never hold a whole mark. */
function marksOf(command: string): { ok: string; fail: string } {
  const groups = [...command.matchAll(/printf '\\n%s%s\\n' '([^']+)' '([^']+)'/g)]
  assert.equal(groups.length, 2, `команда без меток запуска: ${command}`)
  return { ok: groups[0][1] + groups[0][2], fail: groups[1][1] + groups[1][2] }
}

/** The stop marker is typed the same way; reassemble it too. */
function stopMarkOf(text: string): string {
  const match = /^printf '\\n%s%s\\n' '([^']+)' '([^']+)'$/.exec(text)
  assert.ok(match, `нет метки остановки: ${text}`)
  return match![1] + match![2]
}

function hostResults(read: unknown) {
  return {
    'workspace.readContext': { branch: 'main', displayName: 'fixture', terminals: [] },
    'workspace.list': {
      workspaces: [
        {
          id: 'ws-1',
          kind: 'folder',
          name: 'fixture',
          path: fixtures,
          branch: 'main',
          hostId: null
        }
      ],
      truncated: false
    },
    'terminal.create': { terminalId: 'term-1' },
    'terminal.read': read,
    'terminal.sendText': { accepted: true },
    'editor.open': { opened: true }
  }
}

const host = mockHost({ results: hostResults({ lines: [], truncated: false }) })

// Every run tries to bring its tab to the front through the CLI; tests must never reach it.
beforeEach(() => {
  main.setCliRunnerForTests(async () => ({ ok: true, out: '' }))
})
afterEach(() => {
  main.setCliRunnerForTests(null)
})

/** The watcher posts on its own clock; waits (bounded) until a post carries `status`. */
async function untilStatus(worker: TestWorker, status: string): Promise<void> {
  for (let i = 0; i < 300; i++) {
    const posts = worker.posts.filter((post) => post.event === 'taskfile.status')
    if (posts.some((post) => (post.payload as { status: string }).status === status)) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.fail(`воркер не прислал статус ${status}`)
}

type Status = { task: string; terminalId: string; startedAt: number; status: string }

function lastStatus(worker: TestWorker): Status {
  const posts = worker.posts.filter((post) => post.event === 'taskfile.status')
  return posts[posts.length - 1].payload as Status
}

test('lists the fixture workspace tasks', async () => {
  const worker = await mountWorker(main, { host })
  const listed = await worker.request('taskfile.list')
  assert.equal(listed.workspaceName, fixtures)
  assert.equal(listed.displayName, 'fixture')
  assert.equal(listed.error, null)
  // location.line puts tasks back into Taskfile.yml order: build, then test, then the db group.
  const names = listed.tasks.map((task) => task.name)
  assert.deepEqual(names, ['build', 'test', 'db:migrate'])
  const build = listed.tasks.find((task) => task.name === 'build')
  assert.equal(build ? build.description : '', 'Собрать проект')
  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
})

test('serves a second list from the cache when the Taskfile has not changed', async () => {
  const worker = await mountWorker(main, { host })
  const first = await worker.request('taskfile.list')
  // Mutate the cached task list in place: a second call that hits the cache returns the
  // same array reference; a call that bypasses the cache rebuilds it from go-task.
  assert.ok(first.tasks, 'первый list вернул задачи')
  const cachedTasks = first.tasks
  const second = await worker.request('taskfile.list')
  assert.equal(second.tasks, cachedTasks, 'повторный list без force отдаёт кеш (тот же массив)')
  const forced = await worker.request('taskfile.list', { force: true })
  assert.notEqual(forced.tasks, cachedTasks, 'list с force обходит кеш и пересобирает список')
  assert.deepEqual(
    forced.tasks.map((task) => task.name),
    ['build', 'test', 'db:migrate'],
    'принудительный список совпадает с go-task'
  )
  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
})

test("picks the focused workspace by id when two workspaces share a displayName", async () => {
  // Regression: two workspaces of different projects both showed displayName
  // "master", and the name+branch match picked whichever came first in
  // workspace.list — so the bar's Taskfile panel served the wrong project's tasks.
  // The context's workspaceId is unique, so it decides; name+branch stays the
  // pre-1.7 fallback.
  const dir = mkdtempSync(path.join(tmpdir(), 'taskfile-twins-'))
  writeFileSync(path.join(dir, 'Taskfile.yml'), "version: '3'\ntasks:\n  mine:\n    desc: соседний близнец\n")
  const twinHost = mockHost({
    results: {
      'workspace.readContext': {
        workspaceId: 'identity:wt2:local:twin-b',
        branch: 'main',
        displayName: 'master',
        terminals: []
      },
      'workspace.list': {
        workspaces: [
          { id: 'identity:wt2:local:twin-a', kind: 'worktree', name: 'master', path: path.join(dir, 'a'), branch: 'main', hostId: null },
          { id: 'identity:wt2:local:twin-b', kind: 'worktree', name: 'master', path: dir, branch: 'main', hostId: null }
        ],
        truncated: false
      },
      'terminal.create': { terminalId: 'term-1' },
      'terminal.read': { lines: [], truncated: false },
      'terminal.sendText': { accepted: true },
      'editor.open': { opened: true }
    }
  })
  const worker = await mountWorker(main, { host: twinHost })
  const listed = await worker.request('taskfile.list')
  assert.equal(listed.displayName, 'master')
  assert.equal(listed.workspaceName, dir)
  assert.deepEqual(
    listed.tasks.map((task) => task.name),
    ['mine'],
    'выбран близнец с точным workspaceId, а не первый с тем же displayName'
  )
  await worker.deactivate()
  rmSync(dir, { recursive: true, force: true })
})

test('runs a task in a fresh terminal with its own run marks', async () => {
  const worker = await mountWorker(main, { host })
  const started = await worker.request('taskfile.run', { task: 'build' })
  assert.equal(started.terminalId, 'term-1')
  const created = host.callsOf('terminal.create') as {
    workspaceId: string
    title: string
    command: string
  }[]
  assert.equal(created.length, 1)
  assert.equal(created[0].workspaceId, 'ws-1')
  assert.match(
    created[0].command,
    /^task build && printf '\\n%s%s\\n' '[^']+' '[^']+' \|\| printf '\\n%s%s\\n' '[^']+' '[^']+'$/
  )
  // A first run types nothing anywhere: the terminal is created already running the task.
  assert.equal(host.callsOf('terminal.sendText').length, 0)
  assert.equal(lastStatus(worker).status, 'running')
  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
})

test('falls back to go-task when task is missing (Arch/Manjaro package name)', async () => {
  if (!goTaskAvailable) return // go-task not on PATH: nothing to fall back to
  const worker = await mountWorker(main, { host })
  const listed = await worker.request('taskfile.list', {
    binaries: ['definitely-not-a-task', 'go-task']
  })
  assert.equal(listed.error, null)
  await worker.request('taskfile.run', { task: 'build' })
  const created = host.callsOf('terminal.create') as { command: string }[]
  // This host is shared: the previous test's `task build` comes first.
  assert.match(created[created.length - 1].command, /^go-task build && printf /)
  await worker.deactivate()
})

test('refuses a task name that cannot go into a shell command', async () => {
  const worker = await mountWorker(main, { host })
  await assert.rejects(() => worker.request('taskfile.run', { task: 'build; rm -rf /' }))
  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
})

test('restarts the task in the same terminal once the run answers', async () => {
  let lines: string[] = []
  const worker = await mountWorker(main, {
    host: mockHost({ results: hostResults(() => ({ lines, truncated: false })) })
  })
  const first = await worker.request('taskfile.run', { task: 'build' })
  const created = worker.host.callsOf('terminal.create') as { command: string }[]
  const marks = marksOf(created[0].command)
  lines = [`   ${created[0].command}`, 'done', marks.ok]
  await untilStatus(worker, 'ok')

  const second = await worker.request('taskfile.run', { task: 'build' })
  assert.equal(second.terminalId, first.terminalId)
  // No second tab: the command goes into the task's own terminal again.
  assert.equal(worker.host.callsOf('terminal.create').length, 1)
  const typed = worker.host.callsOf('terminal.sendText') as { text: string; enter?: boolean }[]
  assert.equal(typed.length, 1)
  assert.equal(typed[0].enter, true)
  assert.match(typed[0].text, /^(go-)?task build && printf /)
  // The restart carries fresh marks, so the old answer cannot end the new run.
  assert.notEqual(marksOf(typed[0].text).ok, marks.ok)
  await worker.deactivate()
})

test('a run whose terminal died gets a fresh tab instead of a failed sendText', async () => {
  // The first run's tab was closed, killing the pty: `terminal.read` answers ok
  // with an empty tail (Orca keeps the buffer), but `terminal.sendText` is
  // refused with terminal_not_writable. The restart must fall back to a new tab.
  const results = hostResults({ lines: [], truncated: false })
  const worker = await mountWorker(main, {
    host: mockHost({
      results: {
        ...results,
        'terminal.sendText': () => {
          throw hostError('action_failed', 'terminal_not_writable')
        }
      }
    })
  })
  const first = await worker.request('taskfile.run', { task: 'build' })
  assert.equal(first.terminalId, 'term-1')
  const second = await worker.request('taskfile.run', { task: 'build' })
  // The dead run left a readable terminal, so the restart tried it first…
  assert.equal(worker.host.callsOf('terminal.sendText').length, 1)
  // …and the refusal landed the command in a fresh terminal instead.
  const created = worker.host.callsOf('terminal.create') as { workspaceId: string; title: string; command: string }[]
  assert.equal(created.length, 2)
  assert.match(
    created[1].command,
    /^(go-)?task build && printf '\\n%s%s\\n' '[^']+' '[^']+' \|\| printf '\\n%s%s\\n' '[^']+' '[^']+'$/
  )
  await worker.deactivate()
})

test('stops a task with an interrupt and its stop mark', async () => {
  const worker = await mountWorker(main, {
    host: mockHost({ results: hostResults({ lines: [], truncated: false }) })
  })
  await worker.request('taskfile.run', { task: 'build' })
  await worker.request('taskfile.stop', { task: 'build' })
  const typed = worker.host.callsOf('terminal.sendText') as { text: string; enter?: boolean }[]
  // Ctrl+C to the task, then a marker that only lands when the shell is free again.
  assert.equal(typed[0].text, '\u0003')
  assert.equal(typed[0].enter, undefined)
  assert.match(typed[1].text, /^printf '\\n%s%s\\n' '[^']+' '[^']+'$/)
  assert.equal(typed[1].enter, true)
  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
})

test('reports stopped when the stop mark lands', async () => {
  let lines: string[] = []
  const worker = await mountWorker(main, {
    host: mockHost({ results: hostResults(() => ({ lines, truncated: false })) })
  })
  await worker.request('taskfile.run', { task: 'build' })
  await worker.request('taskfile.stop', { task: 'build' })
  const typed = worker.host.callsOf('terminal.sendText') as { text: string }[]
  const stop = stopMarkOf(typed[1].text)
  lines = ['^C', stop]
  await untilStatus(worker, 'stopped')
  assert.equal(lastStatus(worker).task, 'build')
  await worker.deactivate()
})

test('an interrupted task that answers failed counts as stopped', async () => {
  let lines: string[] = []
  const worker = await mountWorker(main, {
    host: mockHost({ results: hostResults(() => ({ lines, truncated: false })) })
  })
  await worker.request('taskfile.run', { task: 'build' })
  const created = worker.host.callsOf('terminal.create') as { command: string }[]
  const marks = marksOf(created[0].command)
  await worker.request('taskfile.stop', { task: 'build' })
  // Some shells finish the command line after ^C and report the task as failed.
  lines = ['^C', marks.fail]
  await untilStatus(worker, 'stopped')
  await worker.deactivate()
})

test('reports a failed run when the failure mark lands', async () => {
  let lines: string[] = []
  const worker = await mountWorker(main, {
    host: mockHost({ results: hostResults(() => ({ lines, truncated: false })) })
  })
  await worker.request('taskfile.run', { task: 'build' })
  const created = worker.host.callsOf('terminal.create') as { command: string }[]
  const marks = marksOf(created[0].command)
  lines = ['task: не удалось', marks.fail]
  await untilStatus(worker, 'failed')
  await worker.deactivate()
})

test('reports the run as gone when its terminal cannot be read', async () => {
  const worker = await mountWorker(main, {
    host: mockHost({
      results: hostResults(() => {
        throw hostError('unavailable', 'терминал закрыт')
      })
    })
  })
  await worker.request('taskfile.run', { task: 'build' })
  await untilStatus(worker, 'gone')
  // A terminal closed on its own drops the run's card from the panel too.
  const closed = worker.posts.filter((post) => post.event === 'taskfile.closed')
  assert.deepEqual(closed.map((post) => post.payload), [{ task: 'build' }])
  await worker.deactivate()
})

test('closes the run terminal through the CLI and forgets the run', async () => {
  const calls: string[][] = []
  main.setCliRunnerForTests(async (args) => {
    calls.push(args)
    return { ok: true, out: '' }
  })
  const worker = await mountWorker(main, { host: mockHost({ results: hostResults({ lines: [], truncated: false }) }) })
  await worker.request('taskfile.run', { task: 'build' })
  const result = await worker.request('taskfile.close', { task: 'build' })
  assert.deepEqual(result, { closed: true })
  // The run itself brought the tab forward, then the close asks for the whole tab.
  assert.deepEqual(calls, [
    ['terminal', 'switch', '--terminal', 'term-1', '--json'],
    ['terminal', 'close', '--terminal', 'term-1', '--tab', '--json']
  ])
  // The panel hears the run is gone, and a second close finds no run.
  const closed = worker.posts.filter((post) => post.event === 'taskfile.closed')
  assert.deepEqual(closed.map((post) => post.payload), [{ task: 'build' }])
  await assert.rejects(() => worker.request('taskfile.close', { task: 'build' }))
  await worker.deactivate()
})

test('falls back to typing exit when the CLI cannot close the terminal', async () => {
  main.setCliRunnerForTests(async () => ({ ok: false, out: '' }))
  const worker = await mountWorker(main, { host: mockHost({ results: hostResults({ lines: [], truncated: false }) }) })
  await worker.request('taskfile.run', { task: 'build' })
  const result = await worker.request('taskfile.close', { task: 'build' })
  assert.deepEqual(result, { closed: true })
  const typed = worker.host.callsOf('terminal.sendText') as { terminalId: string; text: string; enter?: boolean }[]
  assert.deepEqual(typed, [{ terminalId: 'term-1', text: 'exit', enter: true }])
  await worker.deactivate()
})

test('counts an already-gone terminal as closed', async () => {
  main.setCliRunnerForTests(async () => ({ ok: false, out: '' }))
  const worker = await mountWorker(main, {
    host: mockHost({
      results: {
        ...hostResults({ lines: [], truncated: false }),
        'terminal.sendText': () => {
          throw hostError('unavailable', 'терминал закрыт')
        }
      }
    })
  })
  await worker.request('taskfile.run', { task: 'build' })
  const result = await worker.request('taskfile.close', { task: 'build' })
  assert.deepEqual(result, { closed: true })
  await worker.deactivate()
})

test('brings the task terminal to the front through the Orca CLI', async () => {
  const calls: string[][] = []
  main.setCliRunnerForTests(async (args) => {
    calls.push(args)
    return { ok: true, out: '' }
  })
  const worker = await mountWorker(main, { host: mockHost({ results: hostResults({ lines: [], truncated: false }) }) })
  await worker.request('taskfile.run', { task: 'build' })
  const focused = await worker.request('taskfile.focus', { task: 'build' })
  assert.equal(focused.focused, true)
  // Once on the run itself, once for the button; both name the task's terminal.
  assert.deepEqual(calls, [
    ['terminal', 'switch', '--terminal', 'term-1', '--json'],
    ['terminal', 'switch', '--terminal', 'term-1', '--json']
  ])
  await worker.deactivate()
})

test('says so when the Orca CLI cannot bring the tab forward', async () => {
  main.setCliRunnerForTests(async () => ({ ok: false, out: '' }))
  const worker = await mountWorker(main, { host: mockHost({ results: hostResults({ lines: [], truncated: false }) }) })
  await worker.request('taskfile.run', { task: 'build' })
  const focused = await worker.request('taskfile.focus', { task: 'build' })
  assert.equal(focused.focused, false)
  assert.equal(typeof focused.reason, 'string')
  await worker.deactivate()
})

test('refuses to stop or focus a task that is not running', async () => {
  const worker = await mountWorker(main, { host: mockHost({ results: hostResults({ lines: [], truncated: false }) }) })
  await assert.rejects(() => worker.request('taskfile.stop', { task: 'build' }))
  await assert.rejects(() => worker.request('taskfile.focus', { task: 'build' }))
  await worker.deactivate()
})

test('shows the panel in the right sidebar on its command', async () => {
  const calls: string[][] = []
  main.setCliRunnerForTests(async (args) => {
    calls.push(args)
    return { ok: true, out: '' }
  })
  const worker = await mountWorker(main, { host })
  const shown = String(await worker.command('taskfile.openPanel'))
  assert.equal(shown.includes('Оснастка'), true)
  assert.deepEqual(calls, [
    ['plugin', 'open', 'local.taskfile-runner', '--panel', 'taskfile-runner', '--json']
  ])
  await worker.deactivate()
})

test('shows the panel for the tasks view through its request', async () => {
  const calls: string[][] = []
  main.setCliRunnerForTests(async (args) => {
    calls.push(args)
    return { ok: true, out: '' }
  })
  const worker = await mountWorker(main, { host })
  const result = await worker.request('taskfile.showPanel')
  assert.equal(result.shown, true)
  assert.deepEqual(calls, [
    ['plugin', 'open', 'local.taskfile-runner', '--panel', 'taskfile-runner', '--json']
  ])
  // Without the CLI the view still works; it just gets told so.
  main.setCliRunnerForTests(async () => ({ ok: false, out: '' }))
  const failed = await worker.request('taskfile.showPanel')
  assert.equal(failed.shown, false)
  assert.equal(typeof failed.reason, 'string')
  await worker.deactivate()
})

test('opens the workspace Taskfile in an editor tab on request', async () => {
  const worker = await mountWorker(main, { host })
  const result = await worker.request('taskfile.ensureFile')
  assert.equal(result.opened, true)
  const calls = worker.host.callsOf('editor.open') as { workspaceId: string; path: string }[]
  assert.equal(calls.length, 1)
  assert.equal(calls[0].workspaceId, 'ws-1')
  // editor.open takes a path relative to the workspace root.
  assert.equal(calls[0].path, 'Taskfile.yml')
  await worker.deactivate()
})

test('says so when there is no Taskfile to open', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'taskfile-ensure-'))
  const worker = await mountWorker(main, {
    host: mockHost({
      results: {
        'workspace.readContext': { branch: 'main', displayName: 'tmp', terminals: [] },
        'workspace.list': {
          workspaces: [
            { id: 'ws-tmp', kind: 'folder', name: 'tmp', path: dir, branch: 'main', hostId: null }
          ],
          truncated: false
        },
        'editor.open': { opened: true }
      }
    })
  })
  const result = await worker.request('taskfile.ensureFile')
  assert.equal(result.opened, false)
  assert.equal(typeof result.reason, 'string')
  await worker.deactivate()
  rmSync(dir, { recursive: true, force: true })
})

test('opens the tasks view through the Orca CLI on its command', async () => {
  const calls: string[][] = []
  main.setCliRunnerForTests(async (args) => {
    calls.push(args)
    return { ok: true, out: '' }
  })
  const worker = await mountWorker(main, { host })
  const shown = String(await worker.command('taskfile.openTasks'))
  assert.equal(shown.includes('Taskfile.yml'), true)
  assert.deepEqual(calls, [
    [
      'plugin',
      'open',
      'local.taskfile-runner',
      '--editor',
      path.join(fixtures, 'Taskfile.yml'),
      '--json'
    ]
  ])
  await worker.deactivate()
})

test('says so when the workspace has no Taskfile to show', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'taskfile-cmd-'))
  const worker = await mountWorker(main, {
    host: mockHost({
      results: {
        'workspace.readContext': { branch: 'main', displayName: 'tmp', terminals: [] },
        'workspace.list': {
          workspaces: [
            { id: 'ws-tmp', kind: 'folder', name: 'tmp', path: dir, branch: 'main', hostId: null }
          ],
          truncated: false
        }
      }
    })
  })
  await assert.rejects(() => worker.command('taskfile.openTasks'))
  await worker.deactivate()
  rmSync(dir, { recursive: true, force: true })
})

test('reads the mark glued to output, but never the typed command', async () => {
  let lines: string[] = []
  const worker = await mountWorker(main, {
    host: mockHost({ results: hostResults(() => ({ lines, truncated: false })) })
  })
  await worker.request('taskfile.run', { task: 'build' })
  const created = worker.host.callsOf('terminal.create') as { command: string }[]
  const marks = marksOf(created[0].command)

  // The buffer holds the typed wrapper and nothing else: its marks are halves, so the run  // is still running however long the wrapper sits there.
  lines = [created[0].command]
  await new Promise((resolve) => setTimeout(resolve, 1_300))
  assert.equal(lastStatus(worker).status, 'running')

  // nixos-rebuild ends its last line without a newline: the mark lands glued to its tail.
  lines = [created[0].command, `Done. The new configuration is${marks.ok}`]
  await untilStatus(worker, 'ok')
  assert.equal(lastStatus(worker).status, 'ok')
  await worker.deactivate()
})
