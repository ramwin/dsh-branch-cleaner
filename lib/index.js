/**
 * dsh-branch-cleaner — host half.
 *
 * Registers one model-facing tool, `git_clean_branches`, which runs the bundled
 * `assets/delete_redundant_branch.sh` in a repository and reports which branches
 * are redundant: merged, squash-merged, patch-equivalent (rebase/cherry-pick),
 * upstream-gone, or carrying a merged PR.
 *
 * The tool never switches branches, never rebases and never touches the working
 * tree; `mode: 'report'` (the default) only lists, and `mode: 'delete'` backs up
 * every deleted branch under `refs/backup/branch-cleaner/<timestamp>/`.
 *
 * @module dsh-branch-cleaner
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import { dirname, isAbsolute, join, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Cordis plugin name; must match the id used by `cordis.patch.yml`. */
export const name = 'branch-cleaner'

/** Required host services: the tool registry and the shell executor. */
export const inject = ['tools', 'shell']

/** Package root (this file lives in `<root>/lib/`). */
const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

/** The cleanup script shipped inside the npm package. */
export const SCRIPT_PATH = join(PACKAGE_ROOT, 'assets', 'delete_redundant_branch.sh')

/** Default and maximum cooperative time budget for one run. */
const DEFAULT_TIMEOUT_MS = 300_000
const MAX_TIMEOUT_MS = 900_000

const MODES = ['report', 'delete']

/** POSIX single-quote escaping, so a path with spaces or quotes survives `bash -c`. */
export function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

/**
 * Translate tool arguments into the script's argv.
 *
 * `mode: 'delete'` is the only thing that adds `--yes`; everything else is a
 * read-only detection knob.
 *
 * @param args - validated tool arguments.
 * @returns argv without the interpreter or script path.
 */
export function buildArgs(args = {}) {
  const argv = []
  if (args.mode === 'delete') argv.push('--yes')
  if (args.squash === true) argv.push('--squash')
  if (args.patches === true) argv.push('--patches')
  if (args.gone === true) argv.push('--gone')
  if (args.pr === true) argv.push('--gh')
  if (args.all === true) argv.push('--all')
  if (args.remote === true) argv.push('--remote')
  if (args.prune === true) argv.push('--prune')
  if (typeof args.base === 'string' && args.base.trim() !== '') argv.push('--base', args.base.trim())
  if (Number.isInteger(args.age) && args.age > 0) argv.push('--age', String(args.age))
  for (const pattern of Array.isArray(args.keep) ? args.keep : []) {
    if (typeof pattern === 'string' && pattern.trim() !== '') argv.push('--keep', pattern.trim())
  }
  if (args.recurseSubmodules === true) argv.push('--recurse-submodules')
  argv.push('--json')
  return argv
}

/**
 * Build the full shell command line for one run.
 * @param args - validated tool arguments.
 * @param scriptPath - script to execute; defaults to the bundled copy.
 * @returns a command string for `ctx.shell`.
 */
export function buildCommand(args = {}, scriptPath = SCRIPT_PATH) {
  const parts = ['bash', shellQuote(scriptPath)]
  for (const arg of buildArgs(args)) parts.push(shellQuote(arg))
  return parts.join(' ')
}

/**
 * Pick the last JSON object out of the script's stdout.
 *
 * The script writes every diagnostic to stderr in `--json` mode, but a git
 * warning can still land on stdout, so scan from the end instead of assuming a
 * single clean line.
 *
 * @param stdout - captured standard output.
 * @returns the parsed report.
 */
export function parseReport(stdout) {
  const lines = String(stdout ?? '').split('\n')
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index].trim()
    if (!line.startsWith('{')) continue
    try {
      return JSON.parse(line)
    } catch {
      /* keep looking further up */
    }
  }
  throw new Error('branch-cleaner: the cleanup script produced no JSON report')
}

/** Normalize one branch row so the canonical output schema always holds. */
function toBranch(row, index) {
  const object = row && typeof row === 'object' ? row : {}
  return {
    name: String(object.name ?? `branch-${index}`),
    action: object.action === 'delete' ? 'delete' : 'keep',
    status: String(object.status ?? 'skip'),
    reason: String(object.reason ?? ''),
  }
}

/**
 * Convert the script report into the tool's canonical value.
 * @param report - parsed script JSON.
 * @param mode - the requested mode.
 */
export function toValue(report, mode) {
  const source = report && typeof report === 'object' ? report : {}
  const count = (group, field) => {
    const value = source[group] && typeof source[group] === 'object' ? source[group][field] : 0
    return Number.isFinite(Number(value)) ? Number(value) : 0
  }
  return {
    repo: String(source.repo ?? ''),
    base: String(source.base ?? ''),
    backup: String(source.backup ?? ''),
    mode: mode === 'delete' ? 'delete' : 'report',
    deleted: { local: count('deleted', 'local'), remote: count('deleted', 'remote') },
    failed: { local: count('failed', 'local'), remote: count('failed', 'remote') },
    branches: (Array.isArray(source.local) ? source.local : []).map(toBranch),
    remoteBranches: (Array.isArray(source.remote) ? source.remote : []).map(toBranch),
  }
}

/** Count rows by the action the script decided on. */
function tally(rows) {
  let deletable = 0
  for (const row of rows) if (row.action === 'delete') deletable += 1
  return { deletable, kept: rows.length - deletable }
}

/**
 * Render a report as compact text for the model.
 * @param value - canonical tool value.
 */
export function summarize(value) {
  const local = tally(value.branches)
  const lines = [
    `冗余分支${value.mode === 'delete' ? '清理' : '体检'}: ${value.repo || '(unknown repo)'} (基线 ${value.base || '?'})`,
    `本地分支 ${value.branches.length} 个: 可删 ${local.deletable}, 保留 ${local.kept}`,
  ]
  for (const branch of value.branches) {
    lines.push(`  ${branch.action === 'delete' ? '-' : '·'} ${branch.name} — ${branch.reason}`)
  }
  if (value.remoteBranches.length > 0) {
    const remote = tally(value.remoteBranches)
    lines.push(`远程分支 ${value.remoteBranches.length} 个: 可删 ${remote.deletable}, 保留 ${remote.kept}`)
    for (const branch of value.remoteBranches) {
      lines.push(`  ${branch.action === 'delete' ? '-' : '·'} origin/${branch.name} — ${branch.reason}`)
    }
  }
  if (value.mode === 'delete') {
    lines.push(`已删除: 本地 ${value.deleted.local}, 远程 ${value.deleted.remote}; 失败: ${value.failed.local + value.failed.remote}`)
    if (value.backup) lines.push(`备份: ${value.backup} (恢复: git branch <name> <sha>)`)
  } else {
    lines.push('当前只报告没有删除。用户明确要求清理后, 再用 mode=delete 调用一次(删除前会自动备份)。')
  }
  return lines.join('\n')
}

/** Resolve the repository to operate on: explicit path > session workspace > process cwd. */
export function resolveRepo(args, exec) {
  const sessionCwd = exec?.agent?.session?.header?.cwd
  const base = typeof sessionCwd === 'string' && sessionCwd !== '' ? sessionCwd : process.cwd()
  const requested = typeof args?.repo === 'string' ? args.repo.trim() : ''
  if (requested === '') return base
  return isAbsolute(requested) ? requested : resolvePath(base, requested)
}

/** Clamp the cooperative timeout into a sane window. */
function clampTimeout(requested) {
  if (!Number.isInteger(requested) || requested <= 0) return DEFAULT_TIMEOUT_MS
  return Math.min(requested, MAX_TIMEOUT_MS)
}

const DESCRIPTION = [
  'Find the branches in a git repository whose work has already landed in the mainline, and optionally delete them.',
  'It detects ancestry merges, squash merges (re-merging the branch would not change the mainline), patch-equivalent branches',
  '(rebase / cherry-pick), branches whose upstream is gone, and branches whose PR is merged via gh.',
  'It never switches branches, never rebases and never touches the working tree.',
  'mode=report (default) only lists; every deletion in mode=delete is backed up under refs/backup/branch-cleaner/.',
  'Use mode=report first, and use mode=delete only when the user explicitly asked to delete branches.',
].join(' ')

/**
 * Build the tool definition bound to one host context.
 * @param context - host Cordis context carrying `tools` and `shell`.
 */
export function createTool(context) {
  return defineTool({
  name: 'git_clean_branches',
  description: DESCRIPTION,
  parameters: {
    mode: {
      type: 'string',
      enum: MODES,
      description: 'report (default) lists candidates only; delete really removes them (with backup).',
    },
    repo: {
      type: 'string',
      description: 'Repository path. Defaults to the session workspace; a relative path resolves against it.',
    },
    base: {
      type: 'string',
      description: 'Mainline branch to compare against. Defaults to origin/HEAD, then main/master, then the current branch.',
    },
    squash: {
      type: 'boolean',
      description: 'Also flag squash-merged branches (merging them back would not change the mainline).',
    },
    patches: {
      type: 'boolean',
      description: 'Also flag branches whose commits are patch-equivalent to commits already in the mainline (rebase/cherry-pick).',
    },
    gone: {
      type: 'boolean',
      description: 'Also flag branches whose upstream was deleted.',
    },
    pr: {
      type: 'boolean',
      description: 'Also flag branches with a merged pull request (requires an authenticated gh CLI).',
    },
    all: {
      type: 'boolean',
      description: 'Shorthand for squash + patches + gone + prune + remote.',
    },
    remote: {
      type: 'boolean',
      description: 'Also delete merged branches on origin. Dangerous and only effective with mode=delete; --all implies it.',
    },
    prune: {
      type: 'boolean',
      description: 'Run git fetch --prune first so gone upstreams are current.',
    },
    age: {
      type: 'integer',
      description: 'Only touch branches whose tip commit is at least this many days old.',
    },
    keep: {
      type: 'array',
      items: { type: 'string' },
      description: 'Extra branch-name globs to protect, e.g. "wip/*". Default protection already covers main, master, develop, release/*, hotfix/* and more.',
    },
    recurseSubmodules: {
      type: 'boolean',
      description: 'Run the same cleanup in every initialized submodule.',
    },
    timeoutMs: {
      type: 'integer',
      description: 'Cooperative time budget in milliseconds (default 300000).',
    },
  },
  output: {
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        repo: { type: 'string', required: true },
        base: { type: 'string', required: true },
        backup: { type: 'string', required: true },
        mode: { type: 'string', required: true, enum: MODES },
        deleted: {
          type: 'object',
          required: true,
          additionalProperties: false,
          properties: {
            local: { type: 'integer', required: true },
            remote: { type: 'integer', required: true },
          },
        },
        failed: {
          type: 'object',
          required: true,
          additionalProperties: false,
          properties: {
            local: { type: 'integer', required: true },
            remote: { type: 'integer', required: true },
          },
        },
        branches: {
          type: 'array',
          required: true,
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              name: { type: 'string', required: true },
              action: { type: 'string', required: true, enum: ['delete', 'keep'] },
              status: { type: 'string', required: true },
              reason: { type: 'string', required: true },
            },
          },
        },
        remoteBranches: {
          type: 'array',
          required: true,
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              name: { type: 'string', required: true },
              action: { type: 'string', required: true, enum: ['delete', 'keep'] },
              status: { type: 'string', required: true },
              reason: { type: 'string', required: true },
            },
          },
        },
      },
    },
    render: (_args, value) => [{ type: 'text', text: summarize(value) }],
  },
  // `report` is read-only unless it prunes remote-tracking refs, which mutates
  // the repository; `delete` obviously does.
  isConcurrencySafe: (args) => args.mode !== 'delete' && args.prune !== true && args.all !== true,
  presentCall: (args) => ({
    card: 'generic',
    title: args.mode === 'delete' ? 'Delete redundant branches' : 'Inspect redundant branches',
    kind: 'other',
    rawInput: { repo: args.repo, mode: args.mode ?? 'report' },
  }),
  async execute(args, exec) {
    const repo = resolveRepo(args, exec)
    const timeoutMs = clampTimeout(args.timeoutMs)
    const request = {
      command: buildCommand(args),
      workdir: repo,
      timeoutMs,
      ...(exec?.signal ? { signal: exec.signal } : {}),
    }
    const execution = await context.shell.execute(context.shell.resolve(request))
    const result = await execution.result()
    if (result.aborted === true) throw new Error('branch-cleaner: the run was cancelled')
    if (result.timedOut === true) throw new Error(`branch-cleaner: the run exceeded ${timeoutMs}ms`)
    const stdout = result.stdout?.text ?? ''
    const stderr = result.stderr?.text ?? ''
    let report
    try {
      report = parseReport(stdout)
    } catch (error) {
      const tail = stderr.trim().slice(-2000)
      throw new Error(`${error.message}${tail === '' ? '' : `\n--- stderr ---\n${tail}`}`)
    }
    return toValue(report, args.mode)
  },
  })
}

/**
 * Register the tool on the host context.
 * @param ctx - host Cordis context carrying `tools` and `shell`.
 */
export function apply(ctx) {
  const tool = createTool(ctx)
  ctx.effect(() => ctx.tools.register(tool), 'branch-cleaner: git_clean_branches tool')
}
