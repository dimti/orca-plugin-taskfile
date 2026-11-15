// The panel <-> worker contract, declared once: src/panel.tsx and src/worker.ts both read it.
export {}

/** How a run stands, as the worker reads it from the run's terminal. */
export type RunStatus = 'running' | 'ok' | 'failed' | 'stopped' | 'gone' | 'timeout'

declare module 'orca' {
  interface PluginRequests {
    /** Tasks of the focused workspace's Taskfile.yml, run through `task --list-all --json`.
     * `binaries` overrides which go-task binaries to try (for tests); the panel never sends it. */
    'taskfile.list': {
      input?: { binaries?: string[] }
      output: {
        workspaceName: string | null
        /** The name `workspace.readContext` and `workspace.changed` use for the workspace. */
        displayName: string | null
        tasks: { name: string; description: string }[]
        error: string | null
      }
    }
    /** Runs `task <name>` in the workspace: a new terminal tab on the first run of a task,
     *  the same terminal again on a restart. */
    'taskfile.run': { input: { task: string }; output: { terminalId: string } }
    /** Interrupts the task's process (Ctrl+C in its terminal) and reports whether it died. */
    'taskfile.stop': { input: { task: string }; output: { ok: true } }
    /** Brings the task's terminal tab to the front, through the Orca CLI. */
    'taskfile.focus': { input: { task: string }; output: { focused: boolean; reason?: string } }
    /** Closes the task's terminal tab through the Orca CLI and forgets the run; a terminal that
     *  is already gone still counts as closed. */
    'taskfile.close': { input: { task: string }; output: { closed: boolean; reason?: string } }
    /** Shows the plugin's panel in the right sidebar; the tasks view calls it on open. */
    'taskfile.showPanel': { output: { shown: boolean; reason?: string } }
    /** Makes sure the workspace's Taskfile is open in an editor tab (no duplicates, no focus). */
    'taskfile.ensureFile': { output: { opened: boolean; reason?: string } }
  }
  interface PluginPanelEvents {
    /** A task's run changed state; `status` stops being `running` when the run ends. */
    'taskfile.status': {
      task: string
      terminalId: string
      startedAt: number
      status: 'running' | 'ok' | 'failed' | 'stopped' | 'gone' | 'timeout'
    }
    /** The task's run is gone for good (terminal closed, by hand or from the panel): its card
     *  leaves the run list. */
    'taskfile.closed': { task: string }
  }
}
