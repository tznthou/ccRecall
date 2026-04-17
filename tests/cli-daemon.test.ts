import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import {
  resolveDaemonPaths,
  generatePlist,
  installDaemon,
  uninstallDaemon,
} from '../src/cli/daemon'

let tmpHome: string

beforeEach(async () => {
  tmpHome = await mkdtemp(path.join(os.tmpdir(), 'ccrecall-daemon-'))
})

afterEach(async () => {
  await rm(tmpHome, { recursive: true, force: true })
})

describe('resolveDaemonPaths', () => {
  it('derives paths from home + script path', () => {
    const paths = resolveDaemonPaths({
      home: '/Users/alice',
      scriptPath: '/opt/ccrecall/dist/index.js',
      nodeBin: '/usr/local/bin/node',
    })
    expect(paths.launchAgentsDir).toBe('/Users/alice/Library/LaunchAgents')
    expect(paths.logsDir).toBe('/Users/alice/Library/Logs/ccrecall')
    expect(paths.plistPath).toBe('/Users/alice/Library/LaunchAgents/com.tznthou.ccrecall.plist')
    expect(paths.nodeBin).toBe('/usr/local/bin/node')
    expect(paths.ccrecallJs).toBe('/opt/ccrecall/dist/index.js')
  })

  it('falls back to process.execPath for nodeBin when not given', () => {
    const paths = resolveDaemonPaths({ home: '/h', scriptPath: '/s.js' })
    expect(paths.nodeBin).toBe(process.execPath)
  })
})

describe('generatePlist', () => {
  const paths = {
    launchAgentsDir: '/Users/alice/Library/LaunchAgents',
    logsDir: '/Users/alice/Library/Logs/ccrecall',
    plistPath: '/Users/alice/Library/LaunchAgents/com.tznthou.ccrecall.plist',
    nodeBin: '/usr/local/bin/node',
    ccrecallJs: '/opt/ccrecall/dist/index.js',
  }

  it('includes label, program arguments, RunAtLoad, KeepAlive', () => {
    const xml = generatePlist(paths)
    expect(xml).toContain('<string>com.tznthou.ccrecall</string>')
    expect(xml).toContain('<string>/usr/local/bin/node</string>')
    expect(xml).toContain('<string>/opt/ccrecall/dist/index.js</string>')
    expect(xml).toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/)
    expect(xml).toMatch(/<key>KeepAlive<\/key>\s*<true\/>/)
  })

  it('routes stdout/stderr to ~/Library/Logs/ccrecall', () => {
    const xml = generatePlist(paths)
    expect(xml).toContain('/Users/alice/Library/Logs/ccrecall/ccrecall.out.log')
    expect(xml).toContain('/Users/alice/Library/Logs/ccrecall/ccrecall.err.log')
  })

  it('uses default port 7749 when not specified', () => {
    const xml = generatePlist(paths)
    expect(xml).toMatch(/<key>CCRECALL_PORT<\/key>\s*<string>7749<\/string>/)
  })

  it('honours custom port and dbPath', () => {
    const xml = generatePlist(paths, { port: 9999, dbPath: '/var/ccrecall.db' })
    expect(xml).toMatch(/<string>9999<\/string>/)
    expect(xml).toContain('<string>/var/ccrecall.db</string>')
  })

  it('escapes XML special characters in paths', () => {
    const xml = generatePlist({
      ...paths,
      ccrecallJs: '/opt/ccrecall & co/dist/index.js',
    })
    expect(xml).toContain('/opt/ccrecall &amp; co/dist/index.js')
    expect(xml).not.toContain('/opt/ccrecall & co/') // bare & must not appear
  })

  it('produces valid XML declaration and plist doctype', () => {
    const xml = generatePlist(paths)
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true)
    expect(xml).toContain('<!DOCTYPE plist PUBLIC')
  })
})

describe('installDaemon dry-run', () => {
  it('dry-run prints plist without touching the filesystem', async () => {
    const chunks: string[] = []
    const origWrite = process.stdout.write.bind(process.stdout)
    process.stdout.write = ((c: string | Uint8Array): boolean => {
      chunks.push(typeof c === 'string' ? c : Buffer.from(c).toString())
      return true
    }) as typeof process.stdout.write
    try {
      await installDaemon({
        dryRun: true,
        overrides: {
          home: tmpHome,
          scriptPath: '/opt/ccrecall/dist/index.js',
          nodeBin: '/usr/local/bin/node',
        },
      })
    } finally {
      process.stdout.write = origWrite
    }

    const output = chunks.join('')
    expect(output).toContain('com.tznthou.ccrecall')
    expect(output).toContain('/opt/ccrecall/dist/index.js')

    // No plist file or LaunchAgents dir should have been created.
    await expect(stat(path.join(tmpHome, 'Library', 'LaunchAgents'))).rejects.toThrow()
  })
})

describe('platform guard', () => {
  const origPlatform = process.platform

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: origPlatform })
  })

  it('install-daemon rejects non-darwin platforms with a helpful message', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux' })
    await expect(installDaemon({ dryRun: true })).rejects.toThrow(/macOS only/)
  })

  it('uninstall-daemon rejects non-darwin platforms', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    await expect(uninstallDaemon()).rejects.toThrow(/macOS only/)
  })
})

describe('installDaemon full install + uninstall (skipLaunchctl)', () => {
  it('writes plist under overridden home and is removable', async () => {
    if (process.platform !== 'darwin') return  // skip on non-macOS CI

    const scriptPath = path.join(tmpHome, 'fake-ccrecall.js')
    const { writeFile } = await import('node:fs/promises')
    await writeFile(scriptPath, '// fake', 'utf8')

    const overrides = { home: tmpHome, scriptPath, nodeBin: process.execPath }

    // skipLaunchctl so the test doesn't register anything with the real
    // user-session launchd or pollute `launchctl list`.
    await installDaemon({ overrides, port: 17749, skipLaunchctl: true })

    const plistPath = path.join(tmpHome, 'Library', 'LaunchAgents', 'com.tznthou.ccrecall.plist')
    const content = await readFile(plistPath, 'utf8')
    expect(content).toContain('com.tznthou.ccrecall')
    expect(content).toContain('<string>17749</string>')

    await uninstallDaemon({ overrides, skipLaunchctl: true })
    await expect(stat(plistPath)).rejects.toThrow()
  })
})
