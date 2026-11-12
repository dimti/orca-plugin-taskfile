// `orca plugin check` renders the panel once per scenario, each with the worker on a fresh
// host. The workspace calls are mocked; `task --list-all` runs for real against fixtures/.
import { fileURLToPath } from 'node:url'
import { defineCheck } from 'orca/testing'

const fixtures = fileURLToPath(new URL('../fixtures', import.meta.url))

export default defineCheck({
  fresh: {},
  withTasks: {
    results: {
      'workspace.readContext': { branch: 'main', displayName: 'fixture', terminals: [] },
      'workspace.list': {
        workspaces: [
          {
            id: 'ws-check',
            kind: 'folder',
            name: 'fixture',
            path: fixtures,
            branch: 'main',
            hostId: null
          }
        ],
        truncated: false
      }
    }
  }
})
