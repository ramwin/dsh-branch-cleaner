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
import { dirname, isAbsolute, join, relative, resolve as resolvePath } from 'node:path'
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
 * Parse the script's `--json` output.
 *
 * One JSON object per repository, one per line: a single line normally, and one
 * line per repository under `--recurse-submodules`. Every diagnostic goes to
 * stderr in JSON mode, but a stray git warning can still land on stdout, so
 * only `{`-prefixed lines are considered.
 *
 * @param stdout - captured standard output.
 * @returns one report per repository, top-level first.
 */
export function parseReports(stdout) {
  const reports = []
  for (const line of String(stdout ?? '').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('{')) continue
    try {
      reports.push(JSON.parse(trimmed))
    } catch {
      /* not a report line */
    }
  }
  if (reports.length === 0) throw new Error('branch-cleaner: the cleanup script produced no JSON report')
  return reports
}

/**
 * Parse a single-repository run.
 * @param stdout - captured standard output.
 * @returns the first (top-level) report.
 */
export function parseReport(stdout) {
  return parseReports(stdout)[0]
}

/** Normalize one branch row so the canonical output schema always holds. */
function toBranch(row, index, repo) {
  const object = row && typeof row === 'object' ? row : {}
  return {
    repo,
    name: String(object.name ?? `branch-${index}`),
    action: object.action === 'delete' ? 'delete' : 'keep',
    status: String(object.status ?? 'skip'),
    reason: String(object.reason ?? ''),
  }
}

/** Repository label relative to the top-level repository, `.` for itself. */
function repoLabel(root, repo) {
  const path = String(repo ?? '')
  if (path === '' || root === '') return '.'
  const rel = relative(root, path)
  return rel === '' ? '.' : rel
}

/**
 * Fold the per-repository reports into the tool's canonical value: branches are
 * flattened and tagged with the repository they belong to, counters are summed.
 * @param reports - one parsed report per repository, top-level first.
 * @param mode - the requested mode.
 */
export function toValue(reports, mode) {
  const list = Array.isArray(reports) ? reports : [reports]
  const top = list[0] && typeof list[0] === 'object' ? list[0] : {}
  const root = String(top.repo ?? '')
  const count = (source, group, field) => {
    const value = source?.[group] && typeof source[group] === 'object' ? source[group][field] : 0
    return Number.isFinite(Number(value)) ? Number(value) : 0
  }
  const totals = { local: 0, remote: 0 }
  const failures = { local: 0, remote: 0 }
  const branches = []
  const remoteBranches = []
  for (const report of list) {
    const source = report && typeof report === 'object' ? report : {}
    const repo = repoLabel(root, source.repo)
    totals.local += count(source, 'deleted', 'local')
    totals.remote += count(source, 'deleted', 'remote')
    failures.local += count(source, 'failed', 'local')
    failures.remote += count(source, 'failed', 'remote')
    for (const [index, row] of (Array.isArray(source.local) ? source.local : []).entries()) {
      branches.push(toBranch(row, index, repo))
    }
    for (const [index, row] of (Array.isArray(source.remote) ? source.remote : []).entries()) {
      remoteBranches.push(toBranch(row, index, repo))
    }
  }
  return {
    repo: root,
    base: String(top.base ?? ''),
    backup: String(top.backup ?? ''),
    mode: mode === 'delete' ? 'delete' : 'report',
    deleted: totals,
    failed: failures,
    branches,
    remoteBranches,
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
 *
 * With more than one repository (submodule recursion), only deletable rows are
 * listed — a full listing of every protected branch in forty submodules is
 * noise, and the model can call again with a narrower `repo`.
 * @param value - canonical tool value.
 */
export function summarize(value) {
  const local = tally(value.branches)
  const repos = new Set(value.branches.map((branch) => branch.repo))
  const multi = repos.size > 1 || (repos.size === 1 && !repos.has('.'))
  const label = (repo) => (multi && repo !== '.' ? `${repo}: ` : '')
  const lines = [
    `冗余分支${value.mode === 'delete' ? '清理' : '体检'}: ${value.repo || '(unknown repo)'} (基线 ${value.base || '?'})`,
    `本地分支 ${value.branches.length} 个: 可删 ${local.deletable}, 保留 ${local.kept}`,
  ]
  for (const branch of value.branches) {
    if (multi && branch.action !== 'delete') continue
    lines.push(`  ${branch.action === 'delete' ? '-' : '·'} ${label(branch.repo)}${branch.name} — ${branch.reason}`)
  }
  if (multi && local.kept > 0) lines.push(`  其余 ${local.kept} 个未合并/受保护的分支已略过`)
  if (value.remoteBranches.length > 0) {
    const remote = tally(value.remoteBranches)
    lines.push(`远程分支 ${value.remoteBranches.length} 个: 可删 ${remote.deletable}, 保留 ${remote.kept}`)
    for (const branch of value.remoteBranches) {
      if (multi && branch.action !== 'delete') continue
      lines.push(`  ${branch.action === 'delete' ? '-' : '·'} ${label(branch.repo)}origin/${branch.name} — ${branch.reason}`)
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
      description: 'Shorthand for squash + patches + gone + prune. It does NOT include remote.',
    },
    remote: {
      type: 'boolean',
      description: 'Also delete merged branches on origin. Dangerous, only effective with mode=delete, and never implied by all.',
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
              repo: { type: 'string', required: true },
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
              repo: { type: 'string', required: true },
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
    let reports
    try {
      reports = parseReports(stdout)
    } catch (error) {
      const tail = stderr.trim().slice(-2000)
      throw new Error(`${error.message}${tail === '' ? '' : `\n--- stderr ---\n${tail}`}`)
    }
    return toValue(reports, args.mode)
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
