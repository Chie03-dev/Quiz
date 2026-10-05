/**
 * Provisions better-sqlite3's native builds without a C++ compiler.
 *
 * The npm package only ships the prebuild for whichever Node runs the install,
 * but the app itself runs inside Electron and `npm run check` runs under plain
 * Node. This script downloads the Electron prebuild from the better-sqlite3
 * GitHub releases (install time only; the app itself never needs the network),
 * stores it as `native/electron.node` next to the package, and keeps the plain
 * Node build as the package default. `src/main/db` then picks the right binary
 * via better-sqlite3's `nativeBinding` option.
 *
 * Never runs node-gyp: if a download fails we warn instead of compiling.
 */
const { execFileSync } = require('node:child_process')
const { copyFileSync, existsSync, mkdirSync } = require('node:fs')
const { dirname, join } = require('node:path')

const pkgDir = dirname(require.resolve('better-sqlite3/package.json'))
const addonPath = join(pkgDir, 'build', 'Release', 'better_sqlite3.node')
const electronAddon = join(pkgDir, 'native', 'electron.node')

// prebuild-install is a dependency of better-sqlite3 (hoisted to the root in
// most installs, but resolve through the package as a fallback).
function resolvePrebuild() {
  try {
    return require.resolve('prebuild-install/bin.js')
  } catch {
    return require.resolve('prebuild-install/bin.js', { paths: [pkgDir] })
  }
}

function prebuild(args) {
  execFileSync(process.execPath, [resolvePrebuild(), ...args], {
    cwd: pkgDir,
    stdio: 'inherit'
  })
}

function electronVersion() {
  const electronDir = dirname(require.resolve('electron/package.json'))
  return require(join(electronDir, 'package.json')).version
}

try {
  if (!existsSync(electronAddon)) {
    prebuild(['--runtime=electron', `--target=${electronVersion()}`])
    mkdirSync(dirname(electronAddon), { recursive: true })
    copyFileSync(addonPath, electronAddon)
    console.log(`ensure-native: installed the better-sqlite3 Electron build at ${electronAddon}`)
  }
  // Restore/ensure the plain-Node build as the package default (the Electron
  // prebuild above overwrites build/Release while it runs).
  if (!existsSync(addonPath)) prebuild([])
} catch (err) {
  // Do not fail the whole install: `npm run check` still works with the Node
  // build alone, and the app reports a clear error if the Electron build is
  // missing when the library is opened.
  console.warn(`ensure-native: could not prepare the Electron SQLite build: ${err.message}`)
  console.warn('Re-run `npm install` with network access to fix it.')
}