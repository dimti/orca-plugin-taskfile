// The Taskfile Runner editor: an Orca custom editor for Taskfile.yml (src/editor/tasks.ts is
// its entry). It is a full editor for the file — the text is editable right here — with the
// run controls where an editor puts them: ▶ in the gutter strip, left of the line numbers
// (■ stops the run in progress), and the run's status in a rail on the right. A Taskfile.yml
// opens in Source by Orca's own rules (its API has no way to decorate Source), so this view
// is the one place where editing and running meet. No build step: Orca transpiles this file.
import type { OrcaFrameApi } from 'orca/frame'
import type { RunStatus } from '../protocol'
import '../protocol'
import { STATUS_LABELS } from '../status'
import { taskLineNumbers } from '../tasklines'

const frame = (globalThis as unknown as { orca: OrcaFrameApi }).orca

type States = Map<string, RunStatus>

/** One text row everywhere: the gutter and the rail align with the textarea by construction. */
const LINE_HEIGHT = 20

function build(root: HTMLElement): {
  press: (handler: (task: string) => void) => void
  edit: (handler: (text: string) => void) => void
  setValue: (next: string, keepCaret: boolean) => void
  render: (names: string[], states: States, notice: string | null) => void
} {
  const style = document.createElement('style')
  style.textContent = `
    html, body, #root { height: 100%; margin: 0; }
    html, body { overflow: hidden; }
    html.light { color-scheme: light; }
    html.dark { color-scheme: dark; }
    #root {
      box-sizing: border-box; display: flex; flex-direction: column;
      height: 100%; overflow: hidden;
      font: 12px/${LINE_HEIGHT}px ui-monospace, SFMono-Regular, Menlo, monospace;
      color: var(--orca-foreground); background: var(--orca-background);
    }
    .notice {
      padding: 4px 16px; font-size: 11px; opacity: 0.8;
      border-bottom: 1px solid color-mix(in srgb, var(--orca-foreground) 12%, transparent);
    }
    .editor { flex: 1; display: flex; min-height: 0; }
    /* The gutter strip: run buttons live here, left of the line numbers, not in the text. */
    .gut {
      width: 64px; flex: none; overflow: hidden; padding-top: 8px;
      border-right: 1px solid color-mix(in srgb, var(--orca-foreground) 12%, transparent);
      background: color-mix(in srgb, var(--orca-foreground) 4%, transparent);
    }
    .grow {
      height: ${LINE_HEIGHT}px; display: flex; align-items: center; gap: 4px;
      padding: 0 6px 0 4px;
    }
    .grow.task { background: color-mix(in srgb, var(--orca-primary) 10%, transparent); }
    .play {
      border: 0; background: none; cursor: pointer; line-height: 1;
      padding: 2px 4px; font-size: 12px; border-radius: 4px;
      color: var(--orca-primary); flex: none;
    }
    .play.stop { color: var(--orca-foreground); opacity: 0.9; }
    .play:hover { background: color-mix(in srgb, var(--orca-primary) 18%, transparent); }
    .num { text-align: right; opacity: 0.45; user-select: none; flex: 1; }
    textarea.text {
      flex: 1; min-width: 0; overflow: auto; resize: none;
      box-sizing: border-box; border: 0; outline: 0; padding: 8px 12px;
      font: 12px/${LINE_HEIGHT}px ui-monospace, SFMono-Regular, Menlo, monospace;
      color: var(--orca-foreground); background: var(--orca-background);
      white-space: pre; tab-size: 2;
      scrollbar-color: color-mix(in srgb, var(--orca-foreground) 28%, transparent) transparent;
    }
    textarea.text::-webkit-scrollbar { width: 10px; height: 10px; }
    textarea.text::-webkit-scrollbar-thumb {
      background: color-mix(in srgb, var(--orca-foreground) 28%, transparent);
      border-radius: 5px;
    }
    textarea.text::-webkit-scrollbar-track { background: transparent; }
    .rail {
      width: 120px; flex: none; overflow: hidden; padding-top: 8px;
      border-left: 1px solid color-mix(in srgb, var(--orca-foreground) 12%, transparent);
    }
    .rrow {
      height: ${LINE_HEIGHT}px; display: flex; align-items: center;
      padding: 0 8px; font-size: 11px; opacity: 0.8; white-space: nowrap; overflow: hidden;
    }
    .rrow.running { color: var(--orca-primary); opacity: 1; }
  `

  const notice = document.createElement('div')
  notice.className = 'notice'
  notice.style.display = 'none'
  const editor = document.createElement('div')
  editor.className = 'editor'
  const gutter = document.createElement('div')
  gutter.className = 'gut'
  const text = document.createElement('textarea')
  text.className = 'text'
  text.setAttribute('wrap', 'off')
  text.spellcheck = false
  const rail = document.createElement('div')
  rail.className = 'rail'
  editor.append(gutter, text, rail)
  root.append(style, notice, editor)

  let onpress: (task: string) => void = () => {}
  let onedit: (value: string) => void = () => {}
  let names: string[] = []
  let states: States = new Map()

  const sync = () => {
    gutter.scrollTop = text.scrollTop
    rail.scrollTop = text.scrollTop
  }
  text.addEventListener('scroll', sync)

  const rebuild = () => {
    const value = text.value
    const at = taskLineNumbers(value, names)
    const byLine = new Map<number, string>()
    for (const [name, line] of at) byLine.set(line, name)
    const lines = value.split('\n')
    const gutRows = document.createDocumentFragment()
    const railRows = document.createDocumentFragment()
    for (let index = 0; index < lines.length; index++) {
      const task = byLine.get(index) ?? null
      const state = task ? states.get(task) : undefined
      const row = document.createElement('div')
      row.className = task ? 'grow task' : 'grow'
      if (task) {
        const running = state === 'running'
        const button = document.createElement('button')
        button.className = running ? 'play stop' : 'play'
        button.textContent = running ? '■' : '▶'
        button.title = running ? `Остановить ${task}` : `Запустить ${task}`
        button.addEventListener('click', () => onpress(task))
        row.append(button)
      }
      const num = document.createElement('span')
      num.className = 'num'
      num.textContent = String(index + 1)
      row.append(num)
      gutRows.append(row)

      const status = document.createElement('div')
      status.className = state === 'running' ? 'rrow running' : 'rrow'
      status.textContent = state ? STATUS_LABELS[state] : ''
      railRows.append(status)
    }
    gutter.replaceChildren(gutRows)
    rail.replaceChildren(railRows)
    sync()
  }

  text.addEventListener('input', () => {
    onedit(text.value)
    rebuild()
  })
  // Tab indents the YAML way; the browser would otherwise move focus away.
  text.addEventListener('keydown', (event) => {
    if (event.key !== 'Tab') return
    event.preventDefault()
    const start = text.selectionStart
    const end = text.selectionEnd
    const value = text.value
    text.value = `${value.slice(0, start)}  ${value.slice(end)}`
    text.selectionStart = text.selectionEnd = start + 2
    onedit(text.value)
    rebuild()
  })

  return {
    press: (handler) => {
      onpress = handler
    },
    edit: (handler) => {
      onedit = handler
    },
    setValue: (next, keepCaret) => {
      const start = keepCaret ? text.selectionStart : null
      const end = keepCaret ? text.selectionEnd : null
      text.value = next
      if (start !== null && end !== null) {
        text.selectionStart = Math.min(start, next.length)
        text.selectionEnd = Math.min(end, next.length)
      }
      rebuild()
    },
    render: (nextNames, nextStates, nextNotice) => {
      names = nextNames
      states = nextStates
      if (nextNotice) {
        notice.textContent = nextNotice
        notice.style.display = ''
      } else {
        notice.style.display = 'none'
      }
      rebuild()
    }
  }
}

async function start(root: HTMLElement): Promise<void> {
  const document_ = frame.document
  if (!document_) {
    root.textContent = 'Этот редактор требует Orca с поддержкой документов.'
    return
  }
  const states: States = new Map()
  let names: string[] = []
  let notice: string | null = null

  const doc = await document_.session()
  const view = build(root)
  view.edit((value) => doc.change(value))
  view.setValue(String(doc.value), false)

  const draw = () => view.render(names, states, notice)

  // The worker may be starting, errored or not yet approved when the view loads; retry so a
  // failed first request does not leave the view without its play buttons forever.
  let retries = 0
  const scheduleRetry = (): void => {
    if (retries >= 60) return
    retries += 1
    setTimeout(() => void loadTasks(), 5_000)
  }

  const loadTasks = async (): Promise<void> => {
    try {
      const answer = await frame.plugin.request('taskfile.list')
      names = answer.tasks.map((task) => task.name)
      notice = answer.error
      if (answer.error) scheduleRetry()
      else retries = 0
    } catch (error) {
      names = []
      notice = error instanceof Error ? error.message : String(error)
      scheduleRetry()
    }
    draw()
  }

  view.press((task) => {
    // The worker posts `taskfile.status` as soon as the run starts or stops.
    const request =
      states.get(task) === 'running'
        ? frame.plugin.request('taskfile.stop', { task })
        : frame.plugin.request('taskfile.run', { task })
    void request.catch((error) => {
      notice = error instanceof Error ? error.message : String(error)
      draw()
    })
  })

  frame.plugin.on('taskfile.status', (progress) => {
    states.set(progress.task, progress.status)
    draw()
  })
  // The run board lives in the panel: show it beside the tasks view as the view opens.
  void frame.plugin.request('taskfile.showPanel').catch(() => {
    // Best effort: the view works fine without the sidebar.
  })
  doc.onReplace((value) => {
    view.setValue(String(value), true)
    void loadTasks()
  })
  draw()
  await loadTasks()
}

const root = document.getElementById('root')
if (root) void start(root)
