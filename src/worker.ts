// The plugin's own worker. Orca starts it on the panel's first plugin.request and transpiles
// this file when it loads: no build step.
import { execFile } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import * as path from 'node:path'
import { promisify } from 'node:util'
import type { OrcaWorkerApi } from 'orca/worker'
import type { RunStatus } from './protocol'
import './protocol'
import { STATUS_LABELS } from './status'

const execFileAsync = promisify(execFile)

/** go-task ships as `task` and as `go-task` (Arch/Manjaro package name); tried in this order. */
const TASK_BINARIES = ['task', 'go-task']

/** How Orca knows this plugin when `plugin open` names it: `local.` for a development folder. */
const PLUGIN_KEY = 'local.taskfile-runner'

/** The panel `plugin open --panel` shows in the right sidebar. */
const PANEL_ID = 'taskfile-runner'

/** Taskfile names the tasks view opens, in preference order. */
const TASKFILES = ['Taskfile.yml', 'Taskfile.yaml', 'Taskfile.dist.yml']

/** How often the run's terminal is read, and how long the watch lasts. */
const POLL_MS = 1_000
const RUN_TIMEOUT_MS = 15 * 60_000

/** A cached task list, keyed by workspace path. Invalidation is by Taskfile mtime:
 *  switching panels (Ctrl+Shift+P) mounts the panel again and would otherwise re-spawn
 *  `go-task --list-all --json` every time — a process spawn plus a YAML parse is the lag
 *  the user feels. The Refresh button sends `force: true` to bypass this. */
type TaskCache = { mtimeMs: number; tasks: { name: string; description: string }[] }
const taskCache = new Map<string, TaskCache>()

/** The Taskfile that go-task will parse for `cwd`; the same order the editor view tries. */
function findTaskfile(cwd: string): string | null {
  return TASKFILES.map((name) => path.join(cwd, name)).find((candidate) => existsSync(candidate)) ?? null
}

/** The binary that answered last: the machine-wide choice, kept between panel calls. */
let taskBinary: string | null = null

/** Rises on every `activate`: streams of a stopped worker never outlive it. */
let generation = 0

/** How a run marks its own terminal output; every run gets fresh marks, so restarts in one
 *  terminal buffer never mistake an older run's answer for theirs. */
type RunMarks = { ok: string; fail: string; stop: string; wrap: string }

/** One run of one task in one workspace, in the task's own terminal tab. */
type TaskRun = {
  task: string
  workspaceId: string
  terminalId: string
  startedAt: number
  runId: number
  status: RunStatus
  marks: RunMarks
  stopSent: boolean
}

const taskRuns = new Map<string, TaskRun>()
let runCounter = 0

const runKey = (workspaceId: string, task: string): string => `${workspaceId}\u0000${task}`

function findRunEntry(workspaceId: string | null, task: string): [string, TaskRun] | null {
  if (workspaceId) {
    const key = runKey(workspaceId, task)
    const exact = taskRuns.get(key)
    if (exact) return [key, exact]
  }
  // The workspace may have lost focus since the run; the task name still finds it.
  for (const [key, run] of taskRuns) {
    if (run.task === task) return [key, run]
  }
  return null
}

/** Runs the Orca CLI; tests replace it to stay out of the live app. Never the bare `orca`
 *  name: outside Orca it is the GNOME screen reader. */
export type CliRunner = (args: string[]) => Promise<{ ok: boolean; out: string }>
let cliRunner: CliRunner | null = null

/** Tests keep the CLI out of the live app; passing `null` restores the real one. */
export function setCliRunnerForTests(runner: CliRunner | null): void {
  cliRunner = runner
}

async function runOrcaCli(args: string[]): Promise<{ ok: boolean; out: string }> {
  if (cliRunner) return cliRunner(args)
  // Package layouts move: try every known home of the CLI, PATH last. Never the bare
  // `orca` name: outside Orca it is the GNOME screen reader.
  const candidates = [
    process.env.ORCA_CLI_COMMAND,
    '/opt/stably-orca/resources/bin/orca-ide',
    path.join(homedir(), '.local', 'bin', 'orca-ide'),
    path.join(homedir(), '.config', 'orca', 'linux-orca-cli-shim', 'orca'),
    '/usr/bin/orca-ide',
    'orca-ide'
  ].filter((candidate): candidate is string => Boolean(candidate))
  for (const binary of candidates) {
    try {
      const { stdout } = await execFileAsync(binary, args, { timeout: 15_000 })
      return { ok: true, out: stdout }
    } catch {
      // Try the next candidate.
    }
  }
  return { ok: false, out: '' }
}

/** Brings the run's terminal tab to the front. Best effort: the run works without it. */
async function bringToFront(orca: OrcaWorkerApi, terminalId: string): Promise<void> {
  const result = await runOrcaCli(['terminal', 'switch', '--terminal', terminalId, '--json'])
  if (!result.ok) orca.log(`Не удалось поднять вкладку терминала ${terminalId}: Orca CLI недоступен`)
}

/** Shows the plugin's panel in the right sidebar. Best effort everywhere. */
async function showPanel(): Promise<{ shown: boolean; reason?: string }> {
  const result = await runOrcaCli(['plugin', 'open', PLUGIN_KEY, '--panel', PANEL_ID, '--json'])
  return result.ok ? { shown: true } : { shown: false, reason: 'Orca CLI недоступен' }
}

/** The focused workspace, resolved by matching readContext against workspace.list.
 *  The context's `workspaceId` is unique, so it decides; name+branch matched the
 *  first of two workspaces that share a displayName (intai and nixos-configs both
 *  show "master"), and stays only as the pre-1.7 fallback. */
async function focusedWorkspace(
  orca: Omit<OrcaWorkerApi, 'panels'> | OrcaWorkerApi
): Promise<{ id: string; path: string; displayName: string } | null> {
  if (!orca.host.has('workspace.readContext') || !orca.host.has('workspace.list')) return null
  const context = await orca.host.call('workspace.readContext')
  if (!context) return null
  const listed = await orca.host.call('workspace.list')
  if ('workspaceId' in context && context.workspaceId) {
    const byId = listed.workspaces.find((workspace) => workspace.id === context.workspaceId)
    if (byId) return { id: byId.id, path: byId.path, displayName: byId.name }
  }
  const byName = listed.workspaces.filter((workspace) => workspace.name === context.displayName)
  if (byName.length === 0) return null
  const withBranch = byName.find(
    (workspace) => context.branch && workspace.branch === context.branch
  )
  if (!withBranch) return null
  return { id: withBranch.id, path: withBranch.path, displayName: withBranch.name }
}

type RawTask = { name?: string; desc?: string; location?: { line?: number } }

/** Runs `<binary> --list-all --json` in the workspace. Tasks come back name-sorted;
 * location.line puts them back into Taskfile.yml order. */
async function runTaskList(
  binary: string,
  cwd: string
): Promise<{ name: string; description: string }[]> {
  const { stdout } = await execFileAsync(binary, ['--list-all', '--json'], {
    cwd,
    maxBuffer: 4 * 1024 * 1024,
    timeout: 15_000
  })
  const parsed = JSON.parse(stdout) as { tasks?: RawTask[] }
  if (!Array.isArray(parsed.tasks)) {
    throw new Error(`${binary} ответил не go-task JSON`)
  }
  return parsed.tasks
    .filter((task) => typeof task.name === 'string')
    .map((task) => ({
      name: task.name as string,
      description: task.desc ?? '',
      line: task.location?.line ?? Number.MAX_SAFE_INTEGER
    }))
    .sort((a, b) => a.line - b.line)
    .map((task) => ({ name: task.name, description: task.description }))
}

/** Finds the first candidate that answers like go-task; caches the winner in `taskBinary`. */
async function detectAndList(
  candidates: string[],
  cwd: string
): Promise<{ binary: string; tasks: { name: string; description: string }[] }> {
  const failures: string[] = []
  for (const binary of candidates) {
    try {
      const tasks = await runTaskList(binary, cwd)
      taskBinary = binary
      return { binary, tasks }
    } catch (error) {
      failures.push(`${binary}: ${message(error)}`)
    }
  }
  throw new Error(failures.join('; '))
}

function listCandidates(extra?: string[]): string[] {
  const candidates = taskBinary ? [taskBinary, ...TASK_BINARIES] : [...TASK_BINARIES]
  const withExtra = extra ? [...extra, ...candidates] : candidates
  return [...new Set(withExtra)]
}

/** Task names go into a shell command: keep go-task's identifier characters only. */
function taskNameError(task: string): string | null {
  if (!/^[A-Za-z0-9_.:-]+$/.test(task)) {
    return `Недопустимое имя задачи: ${JSON.stringify(task)}`
  }
  return null
}

function newRunMarks(): RunMarks {
  const id = Math.random().toString(36).slice(2, 10)
  const ok = `__taskfile_runner_ok_${id}__`
  const fail = `__taskfile_runner_fail_${id}__`
  const stop = `__taskfile_runner_stopped_${id}__`
  return { ok, fail, stop, wrap: ` && ${echoMark(ok)} || ${echoMark(fail)}` }
}

/** Prints one mark on a fresh line, assembled from two halves: a typed line must never
 *  contain the whole mark, or the scanner would read the command itself as the answer.
 *  The fresh line keeps the mark off the tail of a command whose output ended without a
 *  newline (nixos-rebuild does exactly that). */
function echoMark(mark: string): string {
  const cut = Math.floor(mark.length / 2)
  return `printf '\\n%s%s\\n' '${mark.slice(0, cut)}' '${mark.slice(cut)}'`
}

/** The line typed into the run's terminal: the task, then the marks its run answers. */
function runCommand(binary: string, task: string, marks: RunMarks): string {
  return `${binary} ${task}${marks.wrap}`
}

/** What this run's marks say, or `running` while none has been echoed yet. A mark counts
 *  anywhere in a line: it may share one with the task's last output when that output ends
 *  without a trailing newline. The typed command cannot fake an answer — see echoMark. */
function scanStatus(lines: readonly string[], marks: RunMarks): 'running' | 'ok' | 'failed' | 'stopped' {
  let failed = false
  for (const line of lines) {
    if (line.includes(marks.ok)) return 'ok'
    if (line.includes(marks.stop)) return 'stopped'
    if (line.includes(marks.fail)) failed = true
  }
  return failed ? 'failed' : 'running'
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms) as unknown as { unref?: () => void }
    timer.unref?.()
  })
}

/** Watches one run: reads its terminal once a second and posts `taskfile.status` until the
 *  run answers one of its marks, the terminal goes away, or the 15-minute watch gives up. */
async function streamRun(orca: OrcaWorkerApi, key: string, runId: number): Promise<void> {
  const mine = generation
  const deadline = Date.now() + RUN_TIMEOUT_MS
  for (;;) {
    const run = taskRuns.get(key)
    if (!run || run.runId !== runId || mine !== generation) return
    let lines: string[]
    try {
      const read = await orca.host.call('terminal.read', { terminalId: run.terminalId, maxLines: 2000 })
      lines = read.lines
    } catch (error) {
      run.status = 'gone'
      post(orca, run)
      // The terminal is gone (closed by hand or with the tab): the run's card leaves the panel.
      taskRuns.delete(key)
      orca.panels.post('taskfile.closed', { task: run.task })
      orca.log(`Вывод ${run.task}: терминал недоступен (${message(error)})`)
      return
    }
    const scanned = scanStatus(lines, run.marks)
    const timedOut = scanned === 'running' && Date.now() >= deadline
    // A stop is a stop even when the shell reports the interrupted task as failed.
    const status: RunStatus = timedOut
      ? 'timeout'
      : scanned === 'failed' && run.stopSent
        ? 'stopped'
        : scanned
    run.status = status
    post(orca, run)
    if (status !== 'running') {
      orca.log(`Задача ${run.task}: ${STATUS_LABELS[status]}`)
      return
    }
    await sleep(POLL_MS)
  }
}

function post(orca: OrcaWorkerApi, run: TaskRun): void {
  orca.panels.post('taskfile.status', {
    task: run.task,
    terminalId: run.terminalId,
    startedAt: run.startedAt,
    status: run.status
  })
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Streams watch their run id; stopping the worker ends every watch at once. */
export function deactivate(): void {
  generation += 1
}

export default function activate(orca: OrcaWorkerApi): void {
  generation += 1
  taskRuns.clear()
  orca.panels.handle('taskfile.list', async (input) => {
    try {
      const workspace = await focusedWorkspace(orca)
      if (!workspace) {
        return {
          workspaceName: null,
          displayName: null,
          tasks: [],
          error: 'Нет открытого воркспейса в Orca'
        }
      }
      const force = input?.force === true || Boolean(input?.binaries)
      const file = findTaskfile(workspace.path)
      if (!force && file) {
        try {
          const mtimeMs = statSync(file).mtimeMs
          const cached = taskCache.get(workspace.path)
          if (cached && cached.mtimeMs === mtimeMs) {
            return {
              workspaceName: workspace.path,
              displayName: workspace.displayName,
              tasks: cached.tasks,
              error: null
            }
          }
        } catch {
          // stat failed: fall through to a live list instead of guessing.
        }
      }
      const { tasks } = await detectAndList(listCandidates(input?.binaries), workspace.path)
      if (file) {
        try {
          taskCache.set(workspace.path, { mtimeMs: statSync(file).mtimeMs, tasks })
        } catch {
          // The file vanished between list and stat: nothing to cache, the list still returns.
        }
      }
      return {
        workspaceName: workspace.path,
        displayName: workspace.displayName,
        tasks,
        error: null
      }
    } catch (error) {
      const text = message(error)
      const hint = text.includes('ENOENT')
        ? `task/go-task not found: установите go-task и проверьте PATH (${text})`
        : text.includes('no Taskfile')
          ? `${text} (Taskfile.yml не найден; создайте его в корне воркспейса)`
          : text
      return { workspaceName: null, displayName: null, tasks: [], error: hint }
    }
  })

  orca.panels.handle('taskfile.run', async ({ task }) => {
    const invalid = taskNameError(task)
    if (invalid) {
      throw Object.assign(new Error(invalid), { code: 'invalid_params' })
    }
    const workspace = await focusedWorkspace(orca)
    if (!workspace) {
      throw Object.assign(new Error('Нет открытого воркспейса в Orca'), { code: 'unavailable' })
    }
    // The listing already picked the binary; if it has not run yet, a list call finds it.
    if (!taskBinary) await detectAndList(listCandidates(), workspace.path)
    const binary = taskBinary ?? 'task'
    const marks = newRunMarks()
    const command = runCommand(binary, task, marks)

    // A restart runs in the task's own terminal tab again. `terminal.read` answers
    // ok even for a terminal whose pty died with its closed tab (Orca keeps the
    // buffer), so only typing tells a reusable tab from a dead one: a refused
    // sendText means the command reached no shell, and that run gets a fresh tab.
    const previous = taskRuns.get(runKey(workspace.id, task))
    let terminalId: string | null = null
    if (previous) {
      try {
        await orca.host.call('terminal.sendText', {
          terminalId: previous.terminalId,
          text: command,
          enter: true
        })
        terminalId = previous.terminalId
      } catch {
        terminalId = null
      }
    }
    if (!terminalId) {
      const created = await orca.host.call('terminal.create', {
        workspaceId: workspace.id,
        title: `task ${task}`,
        command
      })
      terminalId = created.terminalId
    }

    const run: TaskRun = {
      task,
      workspaceId: workspace.id,
      terminalId,
      startedAt: Date.now(),
      runId: ++runCounter,
      status: 'running',
      marks,
      stopSent: false
    }
    taskRuns.set(runKey(workspace.id, task), run)
    orca.log(
      `Запущена задача ${task} через ${binary} в воркспейсе ${workspace.id} (терминал ${terminalId})`
    )
    post(orca, run)
    void streamRun(orca, runKey(workspace.id, task), run.runId).catch((error) =>
      orca.log(`Вывод ${task}: ${message(error)}`)
    )
    void bringToFront(orca, terminalId)
    return { terminalId }
  })

  orca.panels.handle('taskfile.stop', async ({ task }) => {
    const workspace = await focusedWorkspace(orca)
    const found = findRunEntry(workspace?.id ?? null, task)
    if (!found) {
      throw Object.assign(new Error(`Задача ${task} не запущена`), { code: 'unavailable' })
    }
    const run = found[1]
    run.stopSent = true
    // Ctrl+C to the task's foreground process group, then a marker that only lands once the
    // shell is free again — so a task that ignores SIGINT stays "running" honestly.
    await orca.host.call('terminal.sendText', { terminalId: run.terminalId, text: '\u0003' })
    await orca.host.call('terminal.sendText', {
      terminalId: run.terminalId,
      text: echoMark(run.marks.stop),
      enter: true
    })
    orca.log(`Остановка задачи ${task} (терминал ${run.terminalId})`)
    return { ok: true }
  })

  orca.panels.handle('taskfile.focus', async ({ task }) => {
    const workspace = await focusedWorkspace(orca)
    const found = findRunEntry(workspace?.id ?? null, task)
    if (!found) {
      throw Object.assign(new Error(`Задача ${task} не запущена`), { code: 'unavailable' })
    }
    const result = await runOrcaCli([
      'terminal',
      'switch',
      '--terminal',
      found[1].terminalId,
      '--json'
    ])
    return result.ok
      ? { focused: true }
      : { focused: false, reason: 'Orca CLI недоступен (orca-ide не найден)' }
  })

  orca.panels.handle('taskfile.close', async ({ task }) => {
    const workspace = await focusedWorkspace(orca)
    const found = findRunEntry(workspace?.id ?? null, task)
    if (!found) {
      throw Object.assign(new Error(`Задача ${task} не запущена`), { code: 'unavailable' })
    }
    const [key, run] = found
    // The tab goes away through the CLI; a terminal that is already closed is no error.
    const closed = await runOrcaCli(['terminal', 'close', '--terminal', run.terminalId, '--tab', '--json'])
    if (!closed.ok) {
      // No CLI: type `exit` into the terminal — closing the shell closes the pane.
      try {
        await orca.host.call('terminal.sendText', { terminalId: run.terminalId, text: 'exit', enter: true })
      } catch {
        // The terminal is already gone: that is a close too.
      }
    }
    taskRuns.delete(key)
    orca.panels.post('taskfile.closed', { task })
    orca.log(`Закрыт терминал задачи ${task} (${run.terminalId})`)
    return { closed: true }
  })

  // Ctrl+Shift+P (and the palette): shows the plugin's panel in the right sidebar.
  orca.commands.register('taskfile.openPanel', async () => {
    const result = await showPanel()
    if (!result.shown) {
      throw Object.assign(new Error('Orca CLI недоступен: не показать оснастку'), {
        code: 'unavailable'
      })
    }
    orca.log('Показана оснастка Taskfile')
    return 'Оснастка Taskfile — в правом баре'
  })

  // The tasks editor view calls it when it opens, so the run board is beside it at once.
  orca.panels.handle('taskfile.showPanel', async () => showPanel())

  // The panel calls it as it opens: the Taskfile tab should be there beside the run board.
  // `editor.open` opens no duplicates and steals no focus ("view stays put"), so an already
  // open file is left exactly as it is.
  orca.panels.handle('taskfile.ensureFile', async () => {
    const workspace = await focusedWorkspace(orca)
    if (!workspace) {
      return { opened: false, reason: 'Нет открытого воркспейса в Orca' }
    }
    const file = TASKFILES.find((name) => existsSync(path.join(workspace.path, name)))
    if (!file) {
      return { opened: false, reason: 'Taskfile.yml не найден в корне воркспейса' }
    }
    try {
      await orca.host.call('editor.open', { workspaceId: workspace.id, path: file })
    } catch (error) {
      return { opened: false, reason: message(error) }
    }
    orca.log(`Открыт файл задач: ${file}`)
    return { opened: true }
  })

  // Palette only: opens the workspace's Taskfile in the tasks editor view.
  // `editor.open` cannot: a Taskfile.yml always opens in Source, only `plugin open --editor`
  // lands in this plugin's own editor.
  orca.commands.register('taskfile.openTasks', async () => {
    const workspace = await focusedWorkspace(orca)
    if (!workspace) {
      throw Object.assign(new Error('Нет открытого воркспейса в Orca'), { code: 'unavailable' })
    }
    const file = TASKFILES.map((name) => path.join(workspace.path, name)).find((candidate) =>
      existsSync(candidate)
    )
    if (!file) {
      throw Object.assign(new Error('Taskfile.yml не найден в корне воркспейса'), {
        code: 'action_failed'
      })
    }
    const result = await runOrcaCli(['plugin', 'open', PLUGIN_KEY, '--editor', file, '--json'])
    if (!result.ok) {
      throw Object.assign(new Error('Orca CLI недоступен: не открыть вид задач'), {
        code: 'unavailable'
      })
    }
    orca.log(`Открыт вид задач: ${file}`)
    return `Задачи Taskfile: ${path.basename(file)}`
  })
}
