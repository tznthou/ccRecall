import path from 'node:path'
import os from 'node:os'
import { spawn } from 'node:child_process'
import { mkdir, writeFile, rm, realpath } from 'node:fs/promises'
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

export async function installDaemon(opts: InstallOptions = {}): Promise<void> {
  if (process.platform !== 'darwin') {
    throw new Error(`install-daemon currently supports macOS only (platform: ${process.platform}). See docs/launchd.md for manual setup.`)
  }

  const paths = resolveDaemonPaths(opts.overrides)
  // If ccrecallJs came from process.argv[1], resolve symlinks so the plist
  // points at the real dist/index.js, not an npm bin symlink that may move.
  try {
    paths.ccrecallJs = await realpath(paths.ccrecallJs)
  } catch {
    // If realpath fails (file doesn't exist yet?), keep the original path —
    // the user will get a clear launchd error rather than silent install.
  }
  const plist = generatePlist(paths, { port: opts.port, dbPath: opts.dbPath })

  if (opts.dryRun) {
    process.stdout.write(plist)
    return
  }

  await mkdir(paths.launchAgentsDir, { recursive: true })
  await mkdir(paths.logsDir, { recursive: true })
  await writeFile(paths.plistPath, plist, 'utf8')

  if (!opts.skipLaunchctl) {
    await runLaunchctl(['unload', paths.plistPath]).catch(() => { /* first install — no prior load */ })
    await runLaunchctl(['load', '-w', paths.plistPath])
  }

  console.log(`ccRecall LaunchAgent installed: ${paths.plistPath}`)
  console.log(`Logs: ${paths.logsDir}/ccrecall.{out,err}.log`)
  console.log('Verify with: launchctl list | grep ccrecall')
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
