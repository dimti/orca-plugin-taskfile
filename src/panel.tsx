// No build step: Orca strips the types and compiles the JSX when the panel loads.
import {
  atom,
  Badge,
  Button,
  Callout,
  Card,
  Collapsible,
  EmptyState,
  Heading,
  IconButton,
  Input,
  List,
  ListItem,
  on,
  plugin,
  read,
  Row,
  set,
  Spinner,
  Stack,
  Text,
  update,
  type PanelContext
} from 'orca'
import './protocol'
import type { RunStatus } from './protocol'
import { STATUS_LABELS } from './status'

type TaskInfo = { name: string; description: string }
type Group = { key: string; title: string; tasks: TaskInfo[] }
/** One task's run in its own terminal tab, as the worker reports it. */
type TaskState = {
  task: string
  terminalId: string
  startedAt: number
  status: RunStatus
}

/** What the worker last answered; null until then. */
const tasks = atom<TaskInfo[] | null>(null)
const workspaceName = atom<string | null>(null)
/** The name `workspace.changed` reports; kept apart from the path the badge shows. */
const displayName = atom<string | null>(null)
const error = atom<string | null>(null)
const loading = atom(false)
/** The task whose request is in flight, to keep one press at a time. */
const busyTask = atom<string | null>(null)
/** Tasks that have been run this panel, newest first: one card each, parallel runs are fine. */
const states = atom<TaskState[]>([])
/** Kept across panel runs. */
const filter = atom('filter', '', { persist: 'plugin' })
/** false marks a collapsed group; groups are open unless the person collapsed them. */
const collapsed = atom('collapsed', {} as Record<string, boolean>, { persist: 'plugin' })

const UNGROUPED = '__flat__'
const STATES_KEPT = 10

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function refresh(force = false): Promise<void> {
  set(loading, true)
  set(error, null)
  try {
    const answer = await plugin.request('taskfile.list', { force })
    set(tasks, answer.tasks)
    set(workspaceName, answer.workspaceName)
    set(displayName, answer.displayName)
    if (answer.error) set(error, answer.error)
  } catch (failure) {
    set(error, message(failure))
  } finally {
    set(loading, false)
  }
}

/** First run opens the task's terminal tab; a later press restarts it there. */
async function run(task: string): Promise<void> {
  if (read(busyTask) !== null) return
  set(busyTask, task)
  try {
    await plugin.request('taskfile.run', { task })
  } catch (failure) {
    set(error, message(failure))
  } finally {
    set(busyTask, null)
  }
}

async function stop(task: string): Promise<void> {
  if (read(busyTask) !== null) return
  set(busyTask, task)
  try {
    await plugin.request('taskfile.stop', { task })
  } catch (failure) {
    set(error, message(failure))
  } finally {
    set(busyTask, null)
  }
}

async function focusTerminal(task: string): Promise<void> {
  if (read(busyTask) !== null) return
  set(busyTask, task)
  try {
    const result = await plugin.request('taskfile.focus', { task })
    if (!result.focused) {
      set(error, result.reason ?? 'Не удалось поднять вкладку терминала')
    }
  } catch (failure) {
    set(error, message(failure))
  } finally {
    set(busyTask, null)
  }
}

/** Closes the run's terminal tab; the worker then drops the card from «Запуски». */
async function closeRun(task: string): Promise<void> {
  if (read(busyTask) !== null) return
  set(busyTask, task)
  try {
    await plugin.request('taskfile.close', { task })
  } catch (failure) {
    set(error, message(failure))
  } finally {
    set(busyTask, null)
  }
}

/** Opens (or reveals) the workspace's Taskfile.yml tab in the editor. */
async function openFile(): Promise<void> {
  try {
    await plugin.request('taskfile.ensureFile')
  } catch (failure) {
    set(error, message(failure))
  }
}

/** Runs once before the first render; what it pushes to `subscriptions` ends with the panel. */
export function setup(ctx: PanelContext): void {
  ctx.subscriptions.push(
    on('workspace.changed', ({ context }) => {
      const name = context ? context.displayName : null
      // Terminals opening and closing also fire; refresh only when the workspace moved.
      if (name !== read(displayName) || read(tasks) === null) void refresh(true)
    }),
    plugin.on('taskfile.status', (progress) => {
      update(states, (list) => {
        const next = [
          {
            task: progress.task,
            terminalId: progress.terminalId,
            startedAt: progress.startedAt,
            status: progress.status
          },
          ...list.filter((entry) => entry.task !== progress.task)
        ]
        return next.slice(0, STATES_KEPT)
      })
    }),
    // The run's terminal closed (from the card's button or on its own): its card goes away.
    plugin.on('taskfile.closed', ({ task }) => {
      update(states, (list) => list.filter((entry) => entry.task !== task))
    })
  )
  // No auto-open of the file: even an already open tab would steal focus every time. The
  // header's button opens it on demand instead.
  void refresh()
}

/** Split tasks into ":"-groups: `vm:ssh` -> group `vm`; a bare `decrypt` joins `decrypt:*` when
 * those exist; tasks without a colon and without a matching namespace stay ungrouped. Groups
 * keep the order of their first mention: the worker hands tasks over in Taskfile.yml order. */
function groupTasks(all: TaskInfo[], query: string): Group[] {
  const lower = query.toLowerCase()
  const matches = (task: TaskInfo) =>
    lower === '' ||
    task.name.toLowerCase().includes(lower) ||
    task.description.toLowerCase().includes(lower)
  const filtered = all.filter(matches)
  const hasNamespace = new Set(
    filtered
      .filter((task) => task.name.includes(':'))
      .map((task) => task.name.slice(0, task.name.indexOf(':')))
  )
  const groups = new Map<string, TaskInfo[]>()
  for (const task of filtered) {
    const colon = task.name.indexOf(':')
    const key =
      colon === -1
        ? hasNamespace.has(task.name)
          ? task.name
          : UNGROUPED
        : task.name.slice(0, colon)
    const bucket = groups.get(key)
    if (bucket) bucket.push(task)
    else groups.set(key, [task])
  }
  return [...groups.entries()].map(([key, bucket]) => ({
    key,
    title: `${key === UNGROUPED ? 'Общие' : key} (${bucket.length})`,
    tasks: bucket
  }))
}

/** Inside a ":"-group the row shows the short name; a bare task keeps its full name. */
function shortName(group: Group, task: TaskInfo): string {
  return group.key === UNGROUPED || task.name === group.key
    ? task.name
    : task.name.slice(group.key.length + 1)
}

/** Group state: open unless the person collapsed it; the task name escapes the group key. */
function toggleGroup(group: Group, open: boolean): void {
  update(collapsed, (previous) => {
    const next = { ...previous }
    if (open) delete next[group.key]
    else next[group.key] = true
    return next
  })
}

/** Every group of the workspace's tasks, collapsed or opened at once. */
function setAllCollapsed(collapse: boolean): void {
  const all = read(tasks)
  if (all === null) return
  const keys = groupTasks(all, '').map((group) => group.key)
  update(collapsed, (previous) => {
    const next = { ...previous }
    for (const key of keys) {
      if (collapse) next[key] = true
      else delete next[key]
    }
    return next
  })
}

/** Read(): the workspace name is a path; the last segment is what the badge shows. */
function baseName(path: string): string {
  const trimmed = path.replace(/\/+$/, '')
  return trimmed.slice(trimmed.lastIndexOf('/') + 1)
}

function statusTone(status: RunStatus): 'neutral' | 'success' | 'danger' | 'warning' {
  switch (status) {
    case 'ok':
      return 'success'
    case 'failed':
    case 'gone':
      return 'danger'
    case 'stopped':
    case 'timeout':
      return 'warning'
    default:
      return 'neutral'
  }
}

export default function Panel() {
  const all = read(tasks)
  const workspace = read(workspaceName)
  const failure = read(error)
  const busy = read(loading)
  const active = read(busyTask)
  const runStates = read(states)
  const collapsedGroups = read(collapsed)
  const query = read(filter).trim()

  const groups = all === null ? [] : groupTasks(all, query)

  return (
    <Stack gap="md">
      <Row justify="between" align="center">
        <Row gap="xs" align="center">
          <Heading level={2}>Taskfile</Heading>
          {workspace !== null && <Badge tone="accent">{baseName(workspace)}</Badge>}
          {busy && <Spinner label="Загрузка задач" labelHidden />}
        </Row>
        <Row gap="xs">
          <IconButton
            icon="file"
            label="Показать Taskfile.yml"
            onPress={() => void openFile()}
          />
          <IconButton icon="refresh" label="Обновить" disabled={busy} onPress={() => void refresh(true)} />
        </Row>
      </Row>
      {(all === null || all.length > 0) && (
        <Input
          label="Фильтр"
          labelHidden
          type="search"
          value={query}
          placeholder="Поиск по имени или описанию"
          onChange={(value) => set(filter, value)}
        />
      )}
      {all !== null && all.length > 0 && (
        <Row gap="xs">
          <Button variant="ghost" size="sm" icon="collapse" onPress={() => setAllCollapsed(true)}>
            Свернуть все
          </Button>
          <Button variant="ghost" size="sm" icon="expand" onPress={() => setAllCollapsed(false)}>
            Развернуть все
          </Button>
        </Row>
      )}
      {failure !== null && (
        <Callout tone="danger" title="Ошибка">
          {failure}
        </Callout>
      )}
      {runStates.length > 0 && (
        <Stack gap="sm">
          <Heading level={3}>Запуски</Heading>
          {runStates.map((entry) => (
            <Card key={entry.task} title={`task ${entry.task}`}>
              <Stack gap="sm">
                <Row gap="xs" align="center">
                  {entry.status === 'running' && <Spinner label="Выполняется" labelHidden />}
                  <Badge tone={statusTone(entry.status)}>{STATUS_LABELS[entry.status]}</Badge>
                  <Text muted size="xs">
                    {new Date(entry.startedAt).toLocaleTimeString()}
                  </Text>
                </Row>
                <Row gap="xs">
                  <Button
                    variant="outline"
                    size="sm"
                    icon="terminal"
                    disabled={active !== null}
                    onPress={() => void focusTerminal(entry.task)}
                  >
                    Показать терминал
                  </Button>
                  {entry.status === 'running' ? (
                    <Button
                      variant="outline"
                      size="sm"
                      tone="danger"
                      icon="stop"
                      disabled={active !== null}
                      onPress={() => void stop(entry.task)}
                    >
                      Остановить
                    </Button>
                  ) : (
                    <Button
                      variant="outline"
                      size="sm"
                      icon="play"
                      disabled={active !== null}
                      onPress={() => void run(entry.task)}
                    >
                      Запустить снова
                    </Button>
                  )}
                  <Button
                    variant="outline"
                    size="sm"
                    icon="close"
                    disabled={active !== null}
                    onPress={() => void closeRun(entry.task)}
                  >
                    Закрыть
                  </Button>
                </Row>
              </Stack>
            </Card>
          ))}
        </Stack>
      )}
      {all === null ? null : groups.length === 0 ? (
        query !== '' ? (
          <EmptyState title="Ничего не найдено" description="Фильтр не совпал ни с одной задачей." icon="search" />
        ) : (
          <EmptyState
            title="Задач нет"
            description="В этом воркспейсе task не нашёл задач: проверьте Taskfile.yml в корне."
            icon="hammer"
          />
        )
      ) : (
        groups.map((group) => (
          <Collapsible
            key={group.key}
            title={group.title}
            open={!collapsedGroups[group.key]}
            onChange={(open) => toggleGroup(group, open)}
          >
            <List label={group.title}>
              {group.tasks.map((task) => (
                <ListItem
                  key={task.name}
                  title={shortName(group, task)}
                  description={active === task.name ? 'Запускается…' : task.description}
                  icon="play"
                  disabled={active !== null}
                  onPress={() => void run(task.name)}
                />
              ))}
            </List>
          </Collapsible>
        ))
      )}
      <Text muted size="xs">
        Клик по задаче открывает её терминал вкладкой и запускает там task; перезапуск идёт в
        тот же терминал, статусы — в «Запусках».
      </Text>
    </Stack>
  )
}
