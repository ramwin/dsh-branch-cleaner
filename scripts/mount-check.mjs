/**
 * Dev-only mount check: load the plugin into a real `ToolRuntime` (no dsh web
 * needed) and dispatch `git_clean_branches` against a throwaway repository.
 *
 *   node scripts/mount-check.mjs
 *
 * It resolves `@deepseek-ai/*` from the checkout's parent `node_modules`, so it
 * only runs on a machine with a dsh install above this directory.
 */
import { Context } from '@deepseek-ai/cordis'
import * as SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import * as BranchCleaner from '../lib/index.js'

const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' }
const git = (cwd, args) =>
  execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd, encoding: 'utf8', env })

/** A repository with one merged branch and one unmerged branch. */
function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'branch-cleaner-mount.'))
  git(dir, ['init', '-q', '-b', 'main'])
  git(dir, ['config', 'user.email', 'test@example.com'])
  git(dir, ['config', 'user.name', 'Test'])
  execFileSync('bash', ['-c', "printf 'a\\n' > a.txt"], { cwd: dir })
  git(dir, ['add', '.'])
  git(dir, ['commit', '-qm', 'init'])
  git(dir, ['checkout', '-q', '-b', 'feat/merged'])
  execFileSync('bash', ['-c', "printf 'm\\n' > m.txt"], { cwd: dir })
  git(dir, ['add', '.'])
  git(dir, ['commit', '-qm', 'merged work'])
  git(dir, ['checkout', '-q', 'main'])
  git(dir, ['merge', '-q', '--no-ff', 'feat/merged', '-m', 'merge feat/merged'])
  git(dir, ['checkout', '-q', '-b', 'feat/wip'])
  execFileSync('bash', ['-c', "printf 'w\\n' > w.txt"], { cwd: dir })
  git(dir, ['add', '.'])
  git(dir, ['commit', '-qm', 'wip work'])
  git(dir, ['checkout', '-q', 'main'])
  return dir
}

/** Replace `ctx.shell` with a direct bash spawn, so the real script runs. */
const fakeShell = {
  name: 'fake-shell',
  apply(ctx) {
    ctx.provide('shell', {
      resolve: (request) => request,
      async execute(spec) {
        const done = spawnSync('bash', ['-c', spec.command], {
          cwd: spec.workdir,
          encoding: 'utf8',
          env,
        })
        return {
          result: async () => ({
            exitCode: done.status,
            signal: null,
            timedOut: false,
            aborted: false,
            timeoutMs: spec.timeoutMs,
            stdout: { text: done.stdout ?? '' },
            stderr: { text: done.stderr ?? '' },
          }),
        }
      },
    })
  },
}

const app = new Context()
await app.plugin(SystemPrompt.default ?? SystemPrompt, {})
await app.plugin(Tools, {})
await app.plugin(fakeShell)
await app.plugin(BranchCleaner, {})

const dir = makeRepo()
const signal = new AbortController().signal
const call = (callId, args) =>
  app.tools.execute({ callId, name: 'git_clean_branches', arguments: args, signal })
const text = (result) => result.content.map((block) => block.text ?? '').join('\n')

console.log('schema names:', app.tools.schemas().map((schema) => schema.name))

const report = await call('c1', { repo: dir })
console.log('\n--- report (mode=report) ---')
console.log('isError:', report.isError)
console.log(text(report))
console.log('deleted:', JSON.stringify(report.value?.deleted))

const invalid = await call('c2', { repo: 42 })
console.log('\n--- invalid arguments ---')
console.log('isError:', invalid.isError, '|', text(invalid).split('\n')[0])

const deleted = await call('c3', { repo: dir, mode: 'delete' })
console.log('\n--- delete (mode=delete) ---')
console.log(
  'isError:',
  deleted.isError,
  '| deleted:',
  JSON.stringify(deleted.value?.deleted),
  '| backup:',
  deleted.value?.backup,
)
console.log('branches now:', git(dir, ['branch', '--format=%(refname:short)']).trim().replace(/\n/g, ' '))
console.log('backup refs:', git(dir, ['for-each-ref', '--format=%(refname)', 'refs/backup/branch-cleaner/']).trim())

const keep = git(dir, ['branch', '--format=%(refname:short)']).includes('feat/wip')
rmSync(dir, { recursive: true, force: true })
if (report.isError === false && deleted.isError === false && keep && invalid.isError === true) {
  console.log('\nmount-check: OK')
  process.exit(0)
}
console.error('\nmount-check: FAILED')
process.exit(1)
