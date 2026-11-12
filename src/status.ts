// One vocabulary for a run's status: the panel's badges and the Taskfile editor view read it.
// import type only: no Orca, no DOM.
import type { RunStatus } from './protocol'

export const STATUS_LABELS: Record<RunStatus, string> = {
  running: 'Выполняется…',
  ok: 'Успех',
  failed: 'Ошибка',
  stopped: 'Остановлено',
  gone: 'Терминал закрыт',
  timeout: 'Не завершилось за 15 минут'
}
