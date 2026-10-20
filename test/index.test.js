import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  apply,
  buildArgs,
  buildCommand,
  createTool,
  parseReport,
  parseReports,
  shellQuote,
  summarize,
  toValue,
} from '../lib/index.js'

/** Run one command with every global git config detached, so hooks/user settings cannot interfere. */
function git(cwd, args) {
  return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
  })
}

/** A minimal repository with the branches the assertions need. */
function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-branch-cleaner-test.'))
  git(dir, ['init', '-q', '-b', 'main'])
  git(dir, ['config', 'user.email', 'test@example.com'])
  git(dir, ['config', 'user.name', 'Test'])
  git(dir, ['config', 'commit.gpgsign', 'false'])
  execFileSync('bash', ['-c', "printf 'a\\n' > a.txt"], { cwd: dir })
  git(dir, ['add', '.'])
  git(dir, ['commit', '-qm', 'init'])
  // merged branch
  git(dir, ['checkout', '-q', '-b', 'feat/merged'])
  execFileSync('bash', ['-c', "printf 'm\\n' > m.txt"], { cwd: dir })
  git(dir, ['add', '.'])
  git(dir, ['commit', '-qm', 'merged work'])
  git(dir, ['checkout', '-q', 'main'])
  git(dir, ['merge', '-q', '--no-ff', 'feat/merged', '-m', 'merge feat/merged'])
  // unmerged branch
  git(dir, ['checkout', '-q', '-b', 'feat/wip'])
  execFileSync('bash', ['-c', "printf 'w\\n' > w.txt"], { cwd: dir })
  git(dir, ['add', '.'])
  git(dir, ['commit', '-qm', 'wip work'])
  git(dir, ['checkout', '-q', 'main'])
  return dir
}

/** A fake host context whose `ctx.shell` really spawns the command. */
function fakeContext() {
  const registered = []
  const context = {
    tools: {
      register(tool) {
        registered.push(tool)
      },
    },
    shell: {
      resolve: (request) => request,
      async execute(spec) {
        const finished = spawnSync('bash', ['-c', spec.command], {
          cwd: spec.workdir,
          encoding: 'utf8',
          env: {
            ...process.env,
            GIT_CONFIG_GLOBAL: '/dev/null',
            GIT_CONFIG_SYSTEM: '/dev/null',
            GIT_TERMINAL_PROMPT: '0',
          },
        })
        return {
          result: async () => ({
            exitCode: finished.status,
            signal: null,
            timedOut: false,
            aborted: false,
            timeoutMs: spec.timeoutMs,
            stdout: { text: finished.stdout ?? '' },
            stderr: { text: finished.stderr ?? '' },
          }),
        }
      },
    },
    effect(fn) {
      fn()
      return () => {}
    },
  }
  return { context, registered }
}

test('default args only ask for JSON', () => {
  assert.deepEqual(buildArgs({}), ['--json'])
  assert.deepEqual(buildArgs({ mode: 'report' }), ['--json'])
})

test('delete mode adds --yes and detection flags pass through', () => {
  const argv = buildArgs({
    mode: 'delete',
    all: true,
    base: ' develop ',
    age: 30,
    keep: ['wip/*', ' '],
    recurseSubmodules: true,
  })
  assert.ok(argv.includes('--yes'))
  assert.ok(argv.includes('--all'))
  assert.ok(argv.includes('--recurse-submodules'))
  assert.ok(!argv.includes(' '), '空白保留规则被丢弃')
  assert.equal(argv[argv.indexOf('--base') + 1], 'develop')
  assert.equal(argv[argv.indexOf('--age') + 1], '30')
  assert.equal(argv[argv.indexOf('--keep') + 1], 'wip/*')
  assert.equal(argv.at(-1), '--json')
})

test('shell quoting survives spaces and quotes', () => {
  assert.equal(shellQuote('/tmp/a b'), "'/tmp/a b'")
  assert.equal(shellQuote("it's"), "'it'\\''s'")
  assert.ok(buildCommand({ base: 'a b' }).includes("'a b'"))
})

test('parseReport tolerates noise before the JSON line', () => {
  const stdout = 'Switched to branch main\n{"repo":"/tmp/x","base":"main","local":[]}\n'
  assert.equal(parseReport(stdout).repo, '/tmp/x')
  assert.throws(() => parseReport('nothing here'), /no JSON report/)
})

test('parseReports reads one report per repository', () => {
  const stdout = [
    '{"repo":"/top","base":"main","local":[]}',
    '=== 子模块 sub ===',
    '{"repo":"/top/sub","base":"main","local":[]}',
  ].join('\n')
  assert.deepEqual(parseReports(stdout).map((report) => report.repo), ['/top', '/top/sub'])
})

test('toValue normalizes a partial report', () => {
  const value = toValue({ repo: '/r', base: 'main', local: [{ name: 'x', action: 'delete', status: 'merged' }] })
  assert.equal(value.repo, '/r')
  assert.deepEqual(value.deleted, { local: 0, remote: 0 })
  assert.deepEqual(value.failed, { local: 0, remote: 0 })
  assert.deepEqual(value.remoteBranches, [])
  assert.deepEqual(value.branches[0], {
    repo: '.',
    name: 'x',
    action: 'delete',
    status: 'merged',
    reason: '',
  })
  assert.equal(value.mode, 'report')
})

test('toValue folds submodule reports and sums the counters', () => {
  const value = toValue([
    { repo: '/top', base: 'main', backup: 'refs/backup/top/', deleted: { local: 1 }, local: [{ name: 'a', action: 'delete', status: 'merged' }] },
    { repo: '/top/python/x', base: 'master', deleted: { local: 2 }, failed: { local: 1 }, local: [{ name: 'b', action: 'delete', status: 'merged' }] },
  ], 'delete')
  assert.equal(value.branches.length, 2)
  assert.deepEqual(value.branches.map((branch) => branch.repo), ['.', 'python/x'])
  assert.deepEqual(value.deleted, { local: 3, remote: 0 })
  assert.deepEqual(value.failed, { local: 1, remote: 0 })
  assert.equal(value.backup, 'refs/backup/top/')
})

test('summarize lists counts and branch reasons', () => {
  const text = summarize({
    repo: '/r',
    base: 'main',
    backup: '',
    mode: 'report',
    deleted: { local: 0, remote: 0 },
    failed: { local: 0, remote: 0 },
    branches: [
      { repo: '.', name: 'feat/merged', action: 'delete', status: 'merged', reason: '已合并到 main' },
      { repo: '.', name: 'feat/wip', action: 'keep', status: 'skip', reason: '未合并(领先 1 个提交)' },
    ],
    remoteBranches: [],
  })
  assert.match(text, /可删 1, 保留 1/)
  assert.match(text, /feat\/merged/)
  assert.match(text, /dry-run|只报告|mode=delete/)
})

test('apply registers exactly one tool', () => {
  const { context, registered } = fakeContext()
  apply(context)
  assert.equal(registered.length, 1)
  assert.equal(registered[0].name, 'git_clean_branches')
})

test('report mode finds the merged branch and leaves every branch in place', async () => {
  const dir = makeRepo()
  try {
    const tool = createTool(fakeContext().context)
    const value = await tool.execute({ repo: dir }, {})
    const merged = value.branches.find((branch) => branch.name === 'feat/merged')
    const wip = value.branches.find((branch) => branch.name === 'feat/wip')
    assert.equal(merged?.action, 'delete')
    assert.equal(merged?.status, 'merged')
    assert.equal(wip?.action, 'keep')
    assert.equal(value.mode, 'report')
    assert.equal(value.deleted.local, 0)
    // 报告模式绝不删除
    assert.match(git(dir, ['branch', '--format=%(refname:short)']), /feat\/merged/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('delete mode removes the merged branch and keeps a backup ref', async () => {
  const dir = makeRepo()
  try {
    const tool = createTool(fakeContext().context)
    const value = await tool.execute({ repo: dir, mode: 'delete' }, {})
    assert.equal(value.mode, 'delete')
    assert.equal(value.deleted.local, 1)
    assert.equal(value.failed.local, 0)
    assert.match(value.backup, /^refs\/backup\/branch-cleaner\//)
    const branches = git(dir, ['branch', '--format=%(refname:short)'])
    assert.doesNotMatch(branches, /feat\/merged/)
    assert.match(branches, /feat\/wip/, '未合并分支必须保留')
    const backups = git(dir, ['for-each-ref', '--format=%(refname)', 'refs/backup/branch-cleaner/'])
    assert.match(backups, /feat\/merged/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a non-git directory fails with the script stderr attached', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-branch-cleaner-nogit.'))
  try {
    const tool = createTool(fakeContext().context)
    await assert.rejects(tool.execute({ repo: dir }, {}), /不是 git 仓库|no JSON report/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
