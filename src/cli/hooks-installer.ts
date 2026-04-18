// SPDX-License-Identifier: Apache-2.0
import path from 'node:path'
import os from 'node:os'
import { readFileSync, writeFileSync, copyFileSync, lstatSync, realpathSync, statSync, renameSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * Claude Code hooks installer for ccRecall.
 *
 * Mirrors the install-daemon / uninstall-daemon pattern: a single CLI
 * subcommand writes SessionStart + SessionEnd entries into the user's
 * `~/.claude/settings.json` instead of making them hand-edit JSON.
 *
 * Design decisions (see .claude/pi-plans/fix-dogfood-issues-0-1-3.md):
 * - HOOKS_DIR resolution uses `import.meta.url` only, so npm/pnpm/yarn/npx
 *   global installs all work without asking the package manager for a path.
 * - Merge is idempotent: re-running install is a no-op; stale entries whose
 *   basename matches ours (but path changed, e.g. after nvm switch) get
 *   rewritten in place rather than appended.
 * - Uninstall is strict: removes only entries whose command exactly matches
 *   the current HOOKS_DIR. Anything else (user-modified commands, stale paths
 *   from other reasons) is left alone to avoid surprise deletions.
 * - Atomic write: read+parse → backup → temp file → rename. An mtime recheck
 *   right before rename catches concurrent edits.
 */

const HOOK_FILENAMES = {
  SessionStart: 'session-start.mjs',
  SessionEnd: 'session-end.mjs',
} as const

type HookEvent = keyof typeof HOOK_FILENAMES
const HOOK_EVENTS: HookEvent[] = ['SessionStart', 'SessionEnd']

export interface HookCommand {
  type: 'command'
  command: string
}

export interface HookBlock {
  hooks: HookCommand[]
}

export interface ClaudeSettings {
  hooks?: Partial<Record<HookEvent, HookBlock[]>> & Record<string, HookBlock[] | undefined>
  [key: string]: unknown
}

export interface HookPaths {
  sessionStart: string
  sessionEnd: string
  hooksDir: string
}

export interface HookPathOverrides {
  hooksDir?: string
  nodeBin?: string
}

/** Resolve absolute paths for the two hook scripts. Uses `import.meta.url` as
 *  the ground truth — the CLI and the bundled hooks ship together in the same
 *  package tree, so computing the hooks dir relative to the compiled CLI file
 *  works the same across npm global, pnpm global, yarn global, npx, and
 *  running `node dist/index.js` out of a cloned repo. */
export function resolveHookPaths(overrides: HookPathOverrides = {}): HookPaths {
  const hooksDir = overrides.hooksDir ?? defaultHooksDir()
  return {
    hooksDir,
    sessionStart: path.join(hooksDir, HOOK_FILENAMES.SessionStart),
    sessionEnd: path.join(hooksDir, HOOK_FILENAMES.SessionEnd),
  }
}

function defaultHooksDir(): string {
  // When compiled: dist/cli/hooks-installer.js → ../../hooks
  // When run via tsx from source: src/cli/hooks-installer.ts → ../../hooks
  // Both layouts put the hooks dir at the same relative position, which is
  // why the URL-relative form is safe across dev and published installs.
  const here = path.dirname(fileURLToPath(import.meta.url))
  return path.resolve(here, '..', '..', 'hooks')
}

/** Build the command string we write into settings.json. Uses process.execPath
 *  rather than bare `node` so Claude Code's hook runner can't pick up a
 *  different node via PATH — same reasoning as daemon.ts using `nodeBin`. */
export function buildHookCommand(scriptPath: string, nodeBin: string = process.execPath): string {
  return `${nodeBin} ${scriptPath}`
}

export function buildHookEntry(scriptPath: string, nodeBin?: string): HookCommand {
  return { type: 'command', command: buildHookCommand(scriptPath, nodeBin) }
}

export function resolveSettingsPath(home: string = os.homedir()): string {
  return path.join(home, '.claude', 'settings.json')
}

export interface ReadSettingsResult {
  raw: string | null
  settings: ClaudeSettings
  mtimeMs: number | null
  indent: string
  followedSymlink: boolean
}

/** Read settings.json without touching the filesystem if it's missing. Throws
 *  on invalid JSON (never silently overwrites a broken-but-present config) and
 *  validates the shape of known hook event keys — a string where we expect an
 *  array means merging would corrupt the user's config. */
export function readSettings(settingsPath: string): ReadSettingsResult {
  let followedSymlink = false
  if (existsSync(settingsPath)) {
    const lst = lstatSync(settingsPath)
    if (lst.isSymbolicLink()) {
      followedSymlink = true
    }
  }

  let raw: string | null = null
  let mtimeMs: number | null = null
  if (existsSync(settingsPath)) {
    raw = readFileSync(settingsPath, 'utf8')
    mtimeMs = statSync(settingsPath).mtimeMs
  }

  if (raw === null) {
    return {
      raw: null,
      settings: {},
      mtimeMs: null,
      indent: '  ',
      followedSymlink: false,
    }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    throw new Error(
      `~/.claude/settings.json is not valid JSON — refusing to overwrite. Fix it first (original error: ${(err as Error).message})`,
      { cause: err },
    )
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('~/.claude/settings.json must be a JSON object at the top level')
  }
  const settings = parsed as ClaudeSettings

  if (settings.hooks !== undefined) {
    if (typeof settings.hooks !== 'object' || Array.isArray(settings.hooks) || settings.hooks === null) {
      throw new Error('settings.json "hooks" must be an object keyed by event name')
    }
    for (const event of HOOK_EVENTS) {
      const blocks = settings.hooks[event]
      if (blocks !== undefined && !Array.isArray(blocks)) {
        throw new Error(`settings.json hooks.${event} must be an array (got ${typeof blocks})`)
      }
    }
  }

  return {
    raw,
    settings,
    mtimeMs,
    indent: detectIndent(raw),
    followedSymlink,
  }
}

/** Detect the indent string from the first nested line of an existing JSON
 *  file. Falls back to two spaces for empty or flat files. */
export function detectIndent(raw: string): string {
  const match = raw.match(/^(\s+)"/m)
  if (match && match[1].length > 0) return match[1]
  return '  '
}

export interface MergeResult {
  settings: ClaudeSettings
  changed: boolean
  actions: Array<{ event: HookEvent; action: 'added' | 'rewritten' | 'unchanged' }>
}

/** Apply our SessionStart + SessionEnd entries to the settings object.
 *  - exact command match anywhere under the event → unchanged
 *  - any entry whose command path basename is our script → rewrite in place
 *  - otherwise → append a new HookBlock with just our entry
 *  User-authored entries under the same event are preserved; we never touch
 *  a HookBlock that doesn't have our basename. */
export function mergeHooks(settings: ClaudeSettings, paths: HookPaths, nodeBin?: string): MergeResult {
  const next: ClaudeSettings = { ...settings, hooks: { ...(settings.hooks ?? {}) } }
  const actions: MergeResult['actions'] = []
  let changed = false

  for (const event of HOOK_EVENTS) {
    const scriptPath = event === 'SessionStart' ? paths.sessionStart : paths.sessionEnd
    const expectedCommand = buildHookCommand(scriptPath, nodeBin)
    const filename = HOOK_FILENAMES[event]

    const existingBlocks = (next.hooks![event] ?? []).map((b) => ({ hooks: [...b.hooks] }))

    let eventAction: 'added' | 'rewritten' | 'unchanged' | null = null
    for (const block of existingBlocks) {
      for (let i = 0; i < block.hooks.length; i++) {
        const entry = block.hooks[i]
        if (!entry || entry.type !== 'command' || typeof entry.command !== 'string') continue
        if (entry.command === expectedCommand) {
          eventAction = 'unchanged'
          break
        }
        if (commandPointsAtScript(entry.command, filename)) {
          block.hooks[i] = { type: 'command', command: expectedCommand }
          eventAction = 'rewritten'
          changed = true
          break
        }
      }
      if (eventAction) break
    }

    if (!eventAction) {
      existingBlocks.push({ hooks: [{ type: 'command', command: expectedCommand }] })
      eventAction = 'added'
      changed = true
    }

    next.hooks![event] = existingBlocks
    actions.push({ event, action: eventAction })
  }

  return { settings: next, changed, actions }
}

/** Returns true if the command string invokes a script whose basename is the
 *  hook file we manage. Matches regardless of the node binary path or any
 *  shell quoting — we're identifying "this belongs to ccRecall" heuristically
 *  because the settings schema has no metadata slot. */
function commandPointsAtScript(command: string, filename: string): boolean {
  // Match either `.../session-start.mjs` at end, or `.../session-start.mjs ` followed by args.
  // We intentionally do NOT match commands that merely mention the filename as
  // a literal argument string — the filename must look like a script path.
  const re = new RegExp(`(?:^|[\\s/\\\\])${escapeRegex(filename)}(?:$|\\s)`)
  return re.test(command)
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export interface UninstallResult {
  settings: ClaudeSettings
  changed: boolean
  removed: Array<{ event: HookEvent; command: string }>
}

/** Strict inverse of mergeHooks: removes only entries whose command matches
 *  the current build. Stale entries from a previous install with a different
 *  HOOKS_DIR are NOT auto-cleaned — they look like user config from outside,
 *  and we'd rather err on the side of leaving them than nuking something we
 *  can't prove is ours. */
export function removeHooks(settings: ClaudeSettings, paths: HookPaths, nodeBin?: string): UninstallResult {
  const next: ClaudeSettings = { ...settings, hooks: { ...(settings.hooks ?? {}) } }
  const removed: UninstallResult['removed'] = []
  let changed = false

  for (const event of HOOK_EVENTS) {
    const scriptPath = event === 'SessionStart' ? paths.sessionStart : paths.sessionEnd
    const expectedCommand = buildHookCommand(scriptPath, nodeBin)
    const blocks = next.hooks![event]
    if (!blocks) continue

    const nextBlocks: HookBlock[] = []
    for (const block of blocks) {
      const remainingHooks = block.hooks.filter((entry) => {
        if (entry?.type === 'command' && entry.command === expectedCommand) {
          removed.push({ event, command: entry.command })
          changed = true
          return false
        }
        return true
      })
      if (remainingHooks.length > 0) {
        nextBlocks.push({ hooks: remainingHooks })
      } else if (remainingHooks.length !== block.hooks.length) {
        // emptied by removal — drop it
      } else {
        nextBlocks.push(block)
      }
    }

    if (nextBlocks.length > 0) {
      next.hooks![event] = nextBlocks
    } else {
      delete next.hooks![event]
    }
  }

  // Collapse empty hooks container so we don't leave "hooks": {} lying around
  if (next.hooks && Object.keys(next.hooks).length === 0) {
    delete next.hooks
  }

  return { settings: next, changed, removed }
}

export interface InstallHooksOptions {
  home?: string
  overrides?: HookPathOverrides
  nodeBin?: string
  dryRun?: boolean
}

export async function installHooks(opts: InstallHooksOptions = {}): Promise<void> {
  const paths = resolveHookPaths(opts.overrides)
  const settingsPath = resolveSettingsPath(opts.home)

  const read = readSettings(settingsPath)
  if (read.followedSymlink) {
    console.warn(`[install-hooks] note: ${settingsPath} is a symlink — following it`)
  }

  const merge = mergeHooks(read.settings, paths, opts.nodeBin)

  if (opts.dryRun) {
    const preview = serialize(merge.settings, read.indent)
    process.stdout.write(preview)
    if (!preview.endsWith('\n')) process.stdout.write('\n')
    return
  }

  if (!merge.changed) {
    console.log('ccRecall hooks already installed — no changes')
    for (const a of merge.actions) console.log(`  ${a.event}: ${a.action}`)
    return
  }

  writeSettingsAtomically(settingsPath, merge.settings, read)
  console.log(`Hooks written to ${settingsPath}`)
  for (const a of merge.actions) console.log(`  ${a.event}: ${a.action}`)
  console.log('Restart any running Claude Code sessions to pick up the change.')
}

export interface UninstallHooksOptions {
  home?: string
  overrides?: HookPathOverrides
  nodeBin?: string
  dryRun?: boolean
}

export async function uninstallHooks(opts: UninstallHooksOptions = {}): Promise<void> {
  const paths = resolveHookPaths(opts.overrides)
  const settingsPath = resolveSettingsPath(opts.home)

  if (!existsSync(settingsPath)) {
    console.log(`${settingsPath} does not exist — nothing to uninstall`)
    return
  }

  const read = readSettings(settingsPath)
  const removal = removeHooks(read.settings, paths, opts.nodeBin)

  if (opts.dryRun) {
    const preview = serialize(removal.settings, read.indent)
    process.stdout.write(preview)
    if (!preview.endsWith('\n')) process.stdout.write('\n')
    return
  }

  if (!removal.changed) {
    console.log('No matching ccRecall hook entries found — nothing to remove')
    return
  }

  writeSettingsAtomically(settingsPath, removal.settings, read)
  console.log(`Removed ${removal.removed.length} ccRecall hook entr${removal.removed.length === 1 ? 'y' : 'ies'} from ${settingsPath}`)
  console.log('Restart any running Claude Code sessions to pick up the change.')
}

function serialize(settings: ClaudeSettings, indent: string): string {
  return JSON.stringify(settings, null, indent)
}

/** Safe overwrite: copy the original to .bak-<ts>, write a sibling temp file,
 *  recheck mtime to catch concurrent edits, then rename over the original.
 *  Rename on the same filesystem is atomic, so readers only ever see the old
 *  or new file — never a truncated one. */
function writeSettingsAtomically(settingsPath: string, settings: ClaudeSettings, read: ReadSettingsResult): void {
  const content = serialize(settings, read.indent) + '\n'

  const realPath = read.followedSymlink ? realpathSync(settingsPath) : settingsPath

  if (read.raw !== null) {
    // ISO-8601 with `:` and `.` swapped for `-` so the filename is Windows-safe
    // and still sorts chronologically. Keep millisecond precision to avoid two
    // back-to-back install-hooks runs colliding on the same backup name and
    // silently destroying the only copy of the user's original settings.json.
    const ts = new Date().toISOString().replace(/[:.]/g, '-').replace(/Z$/, '')
    const bak = `${realPath}.bak-${ts}`
    copyFileSync(realPath, bak)
  }

  const tmp = `${realPath}.tmp-${process.pid}-${Date.now()}`
  // settings.json can contain tokens/hook paths — restrict tmp to owner-only
  // (0o600) so the brief window between write and rename isn't world-readable.
  writeFileSync(tmp, content, { encoding: 'utf8', mode: 0o600 })

  if (read.mtimeMs !== null) {
    // Concurrent-edit guard: compare mtime right before rename. An atomic file
    // was swapped under us if these don't match — bail out rather than clobber.
    const current = statSync(realPath).mtimeMs
    if (current !== read.mtimeMs) {
      throw new Error(
        `~/.claude/settings.json was modified between read and write — retry install-hooks. (${read.mtimeMs} → ${current})`,
      )
    }
  }

  renameSync(tmp, realPath)
}
