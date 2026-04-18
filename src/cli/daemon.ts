// SPDX-License-Identifier: Apache-2.0
import path from 'node:path'
import os from 'node:os'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { mkdir, writeFile, rm, realpath, lstat, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

/**
 * macOS launchd installer for ccRecall.
 *
 * Produces a per-user LaunchAgent plist under ~/Library/LaunchAgents that
 * keeps ccRecall running across reboots + auto-restarts on crash. Logs land
 * in ~/Library/Logs/ccrecall/. Linux/Windows equivalents are Phase 5.
 */

const LABEL = 'com.tznthou.ccrecall'
const DEFAULT_PORT = 7749

export interface DaemonPaths {
  launchAgentsDir: string
  logsDir: string
  plistPath: string
  nodeBin: string
  ccrecallJs: string
}

export interface DaemonPathOverrides {
  home?: string
  scriptPath?: string
  nodeBin?: string
}

/** Resolve absolute paths for plist generation. `scriptPath` defaults to the
 *  directory-relative dist/index.js so `node dist/index.js install-daemon`
 *  plants a plist that re-executes the same binary. */
export function resolveDaemonPaths(overrides: DaemonPathOverrides = {}): DaemonPaths {
  const home = overrides.home ?? os.homedir()
  const launchAgentsDir = path.join(home, 'Library', 'LaunchAgents')
  const logsDir = path.join(home, 'Library', 'Logs', 'ccrecall')
  const plistPath = path.join(launchAgentsDir, `${LABEL}.plist`)
  const nodeBin = overrides.nodeBin ?? process.execPath
  const ccrecallJs = overrides.scriptPath ?? defaultScriptPath()
  return { launchAgentsDir, logsDir, plistPath, nodeBin, ccrecallJs }
}

function defaultScriptPath(): string {
  // When bundled as an npm bin, process.argv[1] points at the symlinked bin
  // file. Resolve to the real dist/index.js so launchd spawns the actual file.
  const argv1 = process.argv[1]
  if (argv1 && argv1.endsWith('.js')) return argv1
  // Fallback: compute relative to this module (e.g. during `pnpm dev`).
  const here = fileURLToPath(import.meta.url)
  return path.resolve(path.dirname(here), '..', 'index.js')
}

/** Escape text for safe embedding inside a <string> XML element. */
function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export interface PlistOptions {
  port?: number
  dbPath?: string
}

export function generatePlist(paths: DaemonPaths, opts: PlistOptions = {}): string {
  const port = opts.port ?? DEFAULT_PORT
  const outLog = path.join(paths.logsDir, 'ccrecall.out.log')
  const errLog = path.join(paths.logsDir, 'ccrecall.err.log')
  const envEntries: Array<[string, string]> = [
    ['CCRECALL_PORT', String(port)],
  ]
  if (opts.dbPath) envEntries.push(['CCRECALL_DB_PATH', opts.dbPath])

  const envXml = envEntries
    .map(([k, v]) => `    <key>${escapeXml(k)}</key>\n    <string>${escapeXml(v)}</string>`)
    .join('\n')

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapeXml(LABEL)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(paths.nodeBin)}</string>
    <string>${escapeXml(paths.ccrecallJs)}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${escapeXml(outLog)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(errLog)}</string>
  <key>EnvironmentVariables</key>
  <dict>
${envXml}
  </dict>
</dict>
</plist>
`
}

export interface InstallOptions extends PlistOptions {
  dryRun?: boolean
  /** Skip the launchctl load/unload calls — used by tests so the install flow
   *  can be exercised without touching the user's real LaunchAgents state. */
  skipLaunchctl?: boolean
  overrides?: DaemonPathOverrides
}

/** Refuse to touch a plist that isn't ours. Protects against clobbering an
 *  unrelated LaunchAgent when `$HOME` points somewhere unexpected (sudo, test
 *  harness, compromised env) and against following a symlink out of the user's
 *  LaunchAgents directory. "Managed" = regular file whose content contains
 *  our Label. Non-existent path is OK (first install). */
async function assertManagedPlist(plistPath: string): Promise<void> {
  const stats = await lstat(plistPath).catch(() => null)
  if (!stats) return
  if (stats.isSymbolicLink()) {
    throw new Error(`refuse to touch symlink at ${plistPath} — remove it manually if you're sure it's ccRecall's`)
  }
  if (!stats.isFile()) {
    throw new Error(`refuse to touch non-regular file at ${plistPath}`)
  }
  const content = await readFile(plistPath, 'utf8').catch(() => '')
  if (!content.includes(`<string>${LABEL}</string>`)) {
    throw new Error(`refuse to overwrite unmanaged plist at ${plistPath} (Label does not match ${LABEL})`)
  }
}

export async function installDaemon(opts: InstallOptions = {}): Promise<void> {
  if (process.platform !== 'darwin') {
    throw new Error(`install-daemon currently supports macOS only (platform: ${process.platform}). See docs/launchd.md for manual setup.`)
  }

  const paths = resolveDaemonPaths(opts.overrides)

  // dry-run must be side-effect free: skip realpath() (can block on broken
  // symlinks or stale network mounts) and all filesystem writes. Generate the
  // plist from paths as-given and print.
  if (opts.dryRun) {
    process.stdout.write(generatePlist(paths, { port: opts.port, dbPath: opts.dbPath }))
    return
  }

  // If ccrecallJs came from process.argv[1], resolve symlinks so the plist
  // points at the real dist/index.js, not an npm bin symlink that may move.
  try {
    paths.ccrecallJs = await realpath(paths.ccrecallJs)
  } catch {
    // If realpath fails (file doesn't exist yet?), keep the original path —
    // the user will get a clear launchd error rather than silent install.
  }
  const plist = generatePlist(paths, { port: opts.port, dbPath: opts.dbPath })

  await assertManagedPlist(paths.plistPath)
  await mkdir(paths.launchAgentsDir, { recursive: true })
  await mkdir(paths.logsDir, { recursive: true })
  await writeFile(paths.plistPath, plist, 'utf8')

  if (!opts.skipLaunchctl) {
    await runLaunchctl(['unload', paths.plistPath]).catch(() => { /* first install — no prior load */ })
    await runLaunchctl(['load', '-w', paths.plistPath])
  }

  console.log(`ccRecall LaunchAgent installed: ${paths.plistPath}`)
  console.log(`Logs: ${paths.logsDir}/ccrecall.{out,err}.log`)

  if (!opts.skipLaunchctl) {
    const port = opts.port ?? DEFAULT_PORT
    const result = await verifyDaemonStarted(LABEL, port)
    console.log(formatVerifyMessage(result, port, paths.logsDir))
  }
}

export interface UninstallOptions {
  skipLaunchctl?: boolean
  overrides?: DaemonPathOverrides
}

export async function uninstallDaemon(opts: UninstallOptions = {}): Promise<void> {
  if (process.platform !== 'darwin') {
    throw new Error(`uninstall-daemon currently supports macOS only (platform: ${process.platform}).`)
  }
  const paths = resolveDaemonPaths(opts.overrides)
  await assertManagedPlist(paths.plistPath)
  if (!opts.skipLaunchctl) {
    await runLaunchctl(['unload', paths.plistPath]).catch(() => { /* already unloaded */ })
  }
  await rm(paths.plistPath, { force: true })
  console.log(`ccRecall LaunchAgent removed: ${paths.plistPath}`)
}

function runLaunchctl(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('launchctl', args, { stdio: 'ignore' })
    child.on('error', reject)
    child.on('exit', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`launchctl ${args.join(' ')} exited with code ${code}`))
    })
  })
}

/** Read the PID from `launchctl list <label>` output. Returns null when the
 *  label is unknown (no prior load) or loaded without a PID (crash-loop window).
 *  Distinguishing those two cases isn't useful for our messaging — both mean
 *  "not running right now." */
function launchctlGetPid(label: string): Promise<number | null> {
  return new Promise((resolve) => {
    const child = spawn('launchctl', ['list', label], { stdio: ['ignore', 'pipe', 'ignore'] })
    let stdout = ''
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
    child.on('error', () => resolve(null))
    child.on('exit', (code) => {
      if (code !== 0) return resolve(null)
      const match = stdout.match(/"PID"\s*=\s*(\d+)/)
      resolve(match ? parseInt(match[1], 10) : null)
    })
  })
}

/** Single-shot /health probe. Resolves to true only on a 2xx from the daemon.
 *  All failure modes (ECONNREFUSED, timeout, non-2xx) collapse to false so the
 *  caller doesn't need to distinguish them — the verify message is the same. */
function probeHealth(port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(
      { hostname: '127.0.0.1', port, path: '/health', timeout: timeoutMs },
      (res) => {
        res.resume()
        resolve(res.statusCode === 200)
      },
    )
    req.on('error', () => resolve(false))
    req.on('timeout', () => {
      req.destroy()
      resolve(false)
    })
  })
}

export interface VerifyOverrides {
  getPid?: (label: string) => Promise<number | null>
  probeHealth?: (port: number) => Promise<boolean>
  sleep?: (ms: number) => Promise<void>
}

export interface VerifyResult {
  pid: number | null
  healthy: boolean
}

/** Poll launchctl for the daemon PID with a short deadline, then best-effort
 *  /health probe. Exposed for testing so cli-daemon.test.ts can stub the two
 *  side-effectful calls and exercise the three-state reporting logic. */
export async function verifyDaemonStarted(
  label: string,
  port: number,
  opts: {
    maxWaitMs?: number
    pollIntervalMs?: number
    healthTimeoutMs?: number
    overrides?: VerifyOverrides
  } = {},
): Promise<VerifyResult> {
  const getPid = opts.overrides?.getPid ?? launchctlGetPid
  const probe = opts.overrides?.probeHealth ?? ((p: number) => probeHealth(p, opts.healthTimeoutMs ?? 1000))
  const sleep = opts.overrides?.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)))
  const maxWaitMs = opts.maxWaitMs ?? 5000
  const intervalMs = opts.pollIntervalMs ?? 500

  const deadline = Date.now() + maxWaitMs
  let pid: number | null = null
  while (Date.now() < deadline) {
    pid = await getPid(label)
    if (pid !== null) break
    await sleep(intervalMs)
  }

  if (pid === null) return { pid: null, healthy: false }
  const healthy = await probe(port)
  return { pid, healthy }
}

/** Format the three possible verify outcomes into a one-line status string.
 *  Pure function — unit-tested independently from the poll timing. */
export function formatVerifyMessage(result: VerifyResult, port: number, logsDir: string): string {
  if (result.pid !== null && result.healthy) {
    return `Daemon started (PID ${result.pid}, http://127.0.0.1:${port})`
  }
  if (result.pid !== null) {
    return `Daemon loaded (PID ${result.pid}). Initial indexing may take a few minutes — tail ${logsDir}/ccrecall.out.log`
  }
  return `Daemon install completed but no PID reported yet. Check ${logsDir}/ccrecall.err.log`
}
