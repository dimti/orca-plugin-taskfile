// Pure helpers shared by the Taskfile editor view (src/editor/tasks.ts) and its tests: which
// document lines name which task. No Orca, no DOM: the editor brings the text and the names.

/** Where each task name is defined in a Taskfile.yml text: name -> 0-based line number.
 *  A task is a `name:` key on its own line; the worker's `task --list-all --json` names are the
 *  truth, and the first matching line wins (nested keys come after their task's own line). */
export function taskLineNumbers(text: string, names: readonly string[]): Map<string, number> {
  const wanted = new Set(names)
  const found = new Map<string, number>()
  const lines = text.split('\n')
  for (let index = 0; index < lines.length; index++) {
    const match = /^\s+([A-Za-z0-9_.:-]+):\s*(?:#.*)?$/.exec(lines[index])
    if (!match) continue
    const name = match[1]
    if (wanted.has(name) && !found.has(name)) found.set(name, index)
  }
  return found
}

/** The task defined on a line, or null. */
export function taskAtLine(text: string, names: readonly string[], line: number): string | null {
  for (const [name, at] of taskLineNumbers(text, names)) {
    if (at === line) return name
  }
  return null
}
