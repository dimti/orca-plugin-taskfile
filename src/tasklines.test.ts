// `orca plugin test .` runs this in Node: the editor view's line matching, without Orca or a DOM.
import { assert, test } from 'orca/testing'
import { taskAtLine, taskLineNumbers } from './tasklines'

const taskfile = [
  'version: \'3\'',
  '',
  'tasks:',
  '  build:',
  '    desc: Собрать проект',
  '    cmds:',
  '      - npm run build',
  '',
  '  deploy:staging:',
  '    desc: Задеплоить на staging',
  '    cmds:',
  '      - ./scripts/deploy.sh staging'
].join('\n')

test('finds the lines that define each task', () => {
  const lines = taskLineNumbers(taskfile, ['build', 'deploy:staging'])
  assert.equal(lines.get('build'), 3)
  assert.equal(lines.get('deploy:staging'), 8)
})

test('ignores nested keys and unknown names', () => {
  const lines = taskLineNumbers(taskfile, ['build'])
  assert.equal(lines.size, 1)
  assert.equal(taskAtLine(taskfile, ['build'], 3), 'build')
  // `desc:`/`cmds:` lines are nested keys, never task lines.
  assert.equal(taskAtLine(taskfile, ['build', 'desc'], 4), null)
  assert.equal(taskAtLine(taskfile, ['build'], 0), null)
})
