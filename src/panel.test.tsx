// `orca plugin test .` runs this in Node with the same runtime and checks Orca uses.
import { assert, hostError, mockHost, mount, test } from 'orca/testing'
import * as panel from './panel'

const tasks = [
  { name: 'build', description: 'Собрать проект' },
  { name: 'deploy', description: 'Задеплоить всё' },
  { name: 'deploy:api', description: 'Задеплоить api' },
  { name: 'env:ssh', description: 'SSH в окружение' },
  { name: 'env:stop', description: 'Остановить окружение' }
]

const listAnswer = () => ({ workspaceName: '/repo/demo', displayName: 'demo', tasks, error: null })

test('groups ":" tasks and runs one on click', async () => {
  const started: string[] = []
  const host = mockHost({
    requests: {
      'taskfile.list': listAnswer,
      'taskfile.run': ({ task }) => {
        started.push(task)
        return { terminalId: 'term-1' }
      }
    }
  })
  const view = await mount(panel, { host })

  // The env group and the deploy namespace group exist; bare deploy joined its namespace.
  assert.equal(view.find({ text: /env \(2\)/ }) !== null, true)
  assert.equal(view.find({ text: /deploy \(2\)/ }) !== null, true)
  assert.equal(view.find({ text: /Общие \(1\)/ }) !== null, true)
  // Groups follow the order tasks were mentioned in, not the alphabet.
  const labels = view.findAll({ type: 'Collapsible' }).map((element) => element.label)
  assert.deepEqual(labels, ['Общие (1)', 'deploy (2)', 'env (2)'])
  // Inside a group the row shows the short name and the description.
  const ssh = view.find({ label: 'ssh' })
  assert.equal(ssh !== null && ssh.text.includes('SSH в окружение'), true)

  await view.press({ label: 'ssh' })
  assert.deepEqual(started, ['env:ssh'])
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.refusals, [])
  await view.unmount()
})

test('collapses a group and keeps the choice', async () => {
  const host = mockHost({
    requests: { 'taskfile.list': listAnswer }
  })
  const view = await mount(panel, { host })
  // Collapsed it: the group's tasks stopped drawing.
  const envGroup = view.findAll({ type: 'Collapsible' }).find((element) => element.label === 'env (2)')
  assert.equal(envGroup !== undefined, true)
  await view.toggle(envGroup)
  assert.equal(view.find({ label: 'ssh' }), null)
  // Persisted for the next panel run.
  assert.equal(view.persisted.plugin['collapsed']['env'], true)
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('collapses and expands all groups at once', async () => {
  const host = mockHost({
    requests: { 'taskfile.list': listAnswer }
  })
  const view = await mount(panel, { host })
  assert.equal(view.find({ label: 'ssh' }) !== null, true)
  assert.equal(view.find({ label: 'build' }) !== null, true)

  await view.press({ text: 'Свернуть все' })
  assert.equal(view.find({ label: 'ssh' }), null)
  assert.equal(view.find({ label: 'build' }), null)

  await view.press({ text: 'Развернуть все' })
  assert.equal(view.find({ label: 'ssh' }) !== null, true)
  assert.equal(view.find({ label: 'build' }) !== null, true)
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('filters tasks across groups', async () => {
  const host = mockHost({
    requests: { 'taskfile.list': listAnswer }
  })
  const view = await mount(panel, { host })

  await view.type({ label: 'Фильтр' }, 'api')
  assert.equal(view.find({ text: /deploy \(1\)/ }) !== null, true)
  assert.equal(view.find({ text: /env \(\d+\)/ }), null)
  assert.equal(view.find({ text: /Общие \(\d+\)/ }), null)

  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('shows the error the worker answered with', async () => {
  const host = mockHost({
    requests: {
      'taskfile.list': () => ({
        workspaceName: null,
        displayName: null,
        tasks: [],
        error: 'Нет открытого воркспейса в Orca'
      })
    }
  })
  const view = await mount(panel, { host })
  assert.equal(view.find({ text: /Нет открытого воркспейса в Orca/ }) !== null, true)
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('opens the Taskfile tab only from its button', async () => {
  let ensures = 0
  const host = mockHost({
    requests: {
      'taskfile.list': listAnswer,
      'taskfile.ensureFile': () => {
        ensures += 1
        return { opened: true }
      }
    }
  })
  const view = await mount(panel, { host })
  await view.settled()
  // Opening the panel alone must not touch the editor: focus stealing is what got removed.
  assert.equal(ensures, 0)
  await view.press({ label: 'Показать Taskfile.yml' })
  assert.equal(ensures, 1)
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('shows each run status as the worker posts it', async () => {
  const host = mockHost({
    requests: {
      'taskfile.list': listAnswer,
      'taskfile.run': () => ({ terminalId: 'term-1' })
    }
  })
  const view = await mount(panel, { host })

  await view.press({ label: 'ssh' })
  // The worker posts the run as running right away: its card is up.
  await view.post('taskfile.status', {
    task: 'env:ssh',
    terminalId: 'term-1',
    startedAt: Date.now(),
    status: 'running'
  })
  assert.equal(view.find({ text: /Выполняется/ }) !== null, true)

  await view.post('taskfile.status', {
    task: 'env:ssh',
    terminalId: 'term-1',
    startedAt: Date.now(),
    status: 'ok'
  })
  assert.equal(view.find({ text: /Успех/ }) !== null, true)
  assert.equal(view.find({ text: /Выполняется/ }), null)
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.refusals, [])
  await view.unmount()
})

test('offers stop while a run is going and restart after it ends', async () => {
  const stopped: string[] = []
  const focused: string[] = []
  const host = mockHost({
    requests: {
      'taskfile.list': listAnswer,
      'taskfile.run': () => ({ terminalId: 'term-1' }),
      'taskfile.stop': ({ task }) => {
        stopped.push(task)
        return { ok: true }
      },
      'taskfile.focus': ({ task }) => {
        focused.push(task)
        return { focused: true }
      }
    }
  })
  const view = await mount(panel, { host })
  await view.press({ label: 'ssh' })
  await view.post('taskfile.status', {
    task: 'env:ssh',
    terminalId: 'term-1',
    startedAt: Date.now(),
    status: 'running'
  })

  // While it runs: the terminal can be shown and the run stopped.
  await view.press({ type: 'Button', text: 'Показать терминал' })
  assert.deepEqual(focused, ['env:ssh'])
  await view.press({ type: 'Button', text: 'Остановить' })
  assert.deepEqual(stopped, ['env:ssh'])

  // After it ends the same card restarts the task.
  await view.post('taskfile.status', {
    task: 'env:ssh',
    terminalId: 'term-1',
    startedAt: Date.now(),
    status: 'stopped'
  })
  assert.equal(view.find({ text: /Остановлено/ }) !== null, true)
  assert.equal(view.find({ type: 'Button', text: 'Остановить' }), null)
  await view.press({ type: 'Button', text: 'Запустить снова' })
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.refusals, [])
  await view.unmount()
})

test('closes a run card: its terminal closes and the card leaves the list', async () => {
  const closed: string[] = []
  const host = mockHost({
    requests: {
      'taskfile.list': listAnswer,
      'taskfile.run': () => ({ terminalId: 'term-1' }),
      'taskfile.close': ({ task }) => {
        closed.push(task)
        return { closed: true }
      }
    }
  })
  const view = await mount(panel, { host })
  await view.press({ label: 'ssh' })
  await view.post('taskfile.status', {
    task: 'env:ssh',
    terminalId: 'term-1',
    startedAt: Date.now(),
    status: 'ok'
  })
  assert.equal(view.find({ text: /task env:ssh/ }) !== null, true)

  await view.press({ type: 'Button', text: 'Закрыть' })
  assert.deepEqual(closed, ['env:ssh'])
  // The worker answers the close by dropping the card.
  await view.post('taskfile.closed', { task: 'env:ssh' })
  assert.equal(view.find({ text: /task env:ssh/ }), null)
  assert.equal(view.find({ text: /Запуски/ }), null)
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.refusals, [])
  await view.unmount()
})

test('keeps the list and the error when only workspace terminals churn', async () => {
  let lists = 0
  const host = mockHost({
    requests: {
      'taskfile.list': () => {
        lists += 1
        return listAnswer()
      },
      'taskfile.run': () => {
        throw hostError('action_failed', 'запуск не удался')
      }
    }
  })
  const view = await mount(panel, { host })
  await view.settled()
  const before = lists

  // A failed run leaves its error up...
  await view.press({ label: 'ssh' })
  assert.equal(view.find({ text: /запуск не удался/ }) !== null, true)

  // ...and terminal churn in the same workspace reloads nothing and wipes nothing.
  await view.emit('workspace.changed', {
    context: { branch: 'main', displayName: 'demo', terminals: [{ id: 'term-9' }] }
  })
  await view.settled()
  assert.equal(lists, before)
  assert.equal(view.find({ text: /запуск не удался/ }) !== null, true)

  // Moving to another workspace does reload.
  await view.emit('workspace.changed', {
    context: { branch: 'other', displayName: 'other', terminals: [] }
  })
  await view.settled()
  assert.equal(lists, before + 1)
  assert.deepEqual(view.errors, [])
  await view.unmount()
})
