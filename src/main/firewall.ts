/**
 * Windows firewall rules for the quiz server.
 *
 * The app can install them itself, but only when the instructor asks for it:
 * the install needs an elevation prompt, so it is never automatic and never
 * silent. setup-firewall.bat does the same thing manually.
 *
 * Only these constants ever reach a command line. Nothing from the renderer
 * is interpolated, so there is no injection path into an elevated shell.
 */
import { execFile } from 'node:child_process'
import { PORT_RANGE } from '../shared/types'
import type { FirewallInstallResult, FirewallStatus } from '../shared/types'

/** mDNS discovery port, used by phones browsing for the app. */
export const MDNS_PORT = 5353
/** Rules apply to every network profile, matching setup-firewall.bat. */
export const FIREWALL_PROFILE = 'any'

/** The manual fallback, shipped next to the app in a packaged build. */
export const FIREWALL_SETUP_FILE = 'setup-firewall.bat'

export interface FirewallRule {
  name: string
  protocol: 'TCP' | 'UDP'
  port: string
}

/** The only rules this app manages. Names must match setup-firewall.bat. */
export const FIREWALL_RULES: readonly FirewallRule[] = [
  { name: 'Quiz LAN Server', protocol: 'TCP', port: PORT_RANGE },
  { name: 'Quiz LAN Discovery', protocol: 'UDP', port: String(MDNS_PORT) }
]

/**
 * Arguments for the read-only "does this rule exist" query. Needs no admin.
 *
 * The quotes around the name are deliberate, and execFile must be given
 * `windowsVerbatimArguments` (see CHECK_OPTIONS) or they are not needed and
 * actively harmful.
 *
 * Why: Node's default Windows argument handling escapes an inner `"` as `\"`.
 * netsh then receives the backslashes as part of the name and rejects it with
 * "A specified value is not valid", so a rule that plainly exists is reported
 * missing. With verbatim arguments Node passes the string to CreateProcess
 * untouched, our quotes are the ones netsh sees, and the spaces inside
 * "Quiz LAN Server" stay inside one argument.
 *
 * This is the fallback path only. The primary check is buildCheckScript, which
 * does not depend on the text netsh prints.
 *
 * Pure: given rules it returns a string array, with no process or shell involved.
 */
export function buildCheckArgs(rule: FirewallRule): string[] {
  return ['advfirewall', 'firewall', 'show', 'rule', `name="${rule.name}"`]
}

/**
 * Options for the read-only netsh query. See buildCheckArgs.
 */
export const CHECK_OPTIONS: { windowsVerbatimArguments: boolean } = {
  windowsVerbatimArguments: true
}

/**
 * Classify the output of the read-only netsh query.
 *
 * netsh is unreliable about exit codes here: `show rule` with no name at all is
 * a usage error and still exits 1, so a non-zero exit alone cannot be read as
 * "missing". The wording is the dependable signal:
 *
 * - a rule that exists prints a "Rule Name:" line
 * - a rule that does not prints "No rules match the specified criteria"
 * - a quoting or syntax problem prints "A specified value is not valid" or
 *   "The number of arguments provided is not valid"
 *
 * Both of those first two are localized. On a Windows in another language the
 * text is different, so this classification cannot be trusted there - which is
 * why it is only the fallback and buildCheckScript is the primary check.
 *
 * Anything we do not recognise is 'unknown', which must not be shown to the
 * instructor as a missing rule: that would tell them to click a button when
 * their firewall may well be fine.
 *
 * Pure: takes netsh's stdout, returns a state.
 */
export function classifyCheckOutput(stdout: string): 'present' | 'missing' | 'unknown' {
  const text = stdout.toLowerCase()
  if (/rule name:/u.test(text)) return 'present'
  if (/no rules match/u.test(text)) return 'missing'
  return 'unknown'
}

/**
 * The PowerShell script that reports which rules exist.
 *
 * It uses the NetSecurity cmdlets instead of parsing netsh output, because
 * netsh's wording is translated: on a non-English Windows "No rules match the
 * specified criteria" is a different sentence, and the label in front of the
 * rule name is translated too. The old text matching then read every rule as
 * "unknown", which meant the app could never tell whether the firewall was
 * ready and could never offer the fix - the phone simply could not connect.
 *
 * The cmdlets return objects, not prose, so their output does not change with
 * the system language. The lookup is by display name, because that is the
 * field netsh's `name=` sets: the internal Name of a netsh-created rule is a
 * GUID, and -Name on this cmdlet actually matches the InstanceID, so a lookup
 * by -Name finds nothing at all.
 *
 * Each line of output is "PRESENT <name>", "MISSING <name>" or
 * "UNKNOWN <name>". The rule names come from FIREWALL_RULES and are escaped
 * for PowerShell, so nothing the renderer can influence ends up in the script.
 *
 * Pure: given rules it returns a string, with no process or shell involved.
 */
export function buildCheckScript(rules: readonly FirewallRule[]): string {
  const names = rules.map((r) => `'${r.name.replace(/'/g, "''")}'`).join(',')
  return [
    "$ErrorActionPreference = 'SilentlyContinue'",
    "if (-not (Get-Command Get-NetFirewallRule -ErrorAction SilentlyContinue)) { Write-Output 'UNSUPPORTED'; exit 0 }",
    `$names = @(${names})`,
    'foreach ($n in $names) {',
    '  $r = @(Get-NetFirewallRule -DisplayName $n -ErrorAction SilentlyContinue)',
    '  if ($r.Count -eq 0) { $r = @(Get-NetFirewallRule -ErrorAction SilentlyContinue | Where-Object { $_.Name -eq $n }) }',
    "  if ($r.Count -gt 0) { Write-Output ('PRESENT ' + $n) } else { Write-Output ('MISSING ' + $n) }",
    '}'
  ].join('\n')
}

/** What the check script said about each rule. */
export interface FirewallProbe {
  present: string[]
  missing: string[]
  unknown: string[]
}

/**
 * Read the check script's output.
 *
 * Lines that are not in the expected shape are ignored: a stray warning from
 * PowerShell must not turn a rule into "unknown". A rule that was never
 * mentioned stays in none of the lists, and the caller treats that as unknown.
 *
 * Pure: takes stdout, returns the probe.
 */
export function parseCheckOutput(stdout: string): FirewallProbe {
  const probe: FirewallProbe = { present: [], missing: [], unknown: [] }
  for (const raw of stdout.split(/\r?\n/u)) {
    const match = /^(PRESENT|MISSING|UNKNOWN)\s+(.+)$/u.exec(raw.trim())
    if (!match) continue
    const name = match[2].trim()
    if (!name) continue
    if (match[1] === 'PRESENT') probe.present.push(name)
    else if (match[1] === 'MISSING') probe.missing.push(name)
    else probe.unknown.push(name)
  }
  return probe
}

/**
 * The netsh commands that add the given rules.
 *
 * Separated by ";" rather than "&&", because this string is decoded and run by
 * Windows PowerShell 5.1 (powershell.exe), where "&&" is not valid at all: it is
 * a parse error, so the whole command fails to run and no rule is added. Each
 * netsh is invoked through the call operator "&".
 *
 * ";" means a failing netsh does not stop the later ones, which is what we want
 * here: an absent rule, a renamed rule or a transient netsh error should not
 * prevent the remaining rules from being installed. Success is decided by
 * reading the firewall back afterwards, not by any exit code.
 *
 * No delete steps. The caller only passes rules that checkFirewallRules() found
 * missing, so there is nothing to delete, and netsh exits non-zero when no rule
 * matches - which would stop the chain before the add ran.
 *
 * Pure: takes rules, returns a string, with no process or shell involved.
 */
export function buildInstallCommand(rules: readonly FirewallRule[]): string {
  return rules.map((r) => `& ${buildInstallCommands([r])[0]}`).join('; ')
}

/**
 * The same commands as buildInstallCommand, one per line.
 *
 * This is what the instructor sees and can copy into an administrator terminal
 * when the app could not raise its own prompt, so it has to be runnable as
 * typed: no call operator, no ";" chain, one complete command per line.
 *
 * Pure: takes rules, returns an array of strings.
 */
export function buildInstallCommands(rules: readonly FirewallRule[]): string[] {
  return rules.map(
    (r) =>
      `netsh advfirewall firewall add rule name="${r.name}" dir=in action=allow protocol=${r.protocol} localport=${r.port} profile=${FIREWALL_PROFILE}`
  )
}

/**
 * Encode a command for `powershell.exe -EncodedCommand`.
 *
 * PowerShell expects base64 of the UTF-16LE bytes. Base64 uses only letters,
 * digits, `+`, `/` and `=`, so it holds no spaces or quote characters and
 * survives being handed to Start-Process -ArgumentList intact. That is the point:
 * a raw command line gets re-split on whitespace, which strips the quotes from a
 * rule name like "Quiz LAN Server" and makes netsh fail.
 *
 * Pure: takes a string, returns a string.
 */
export function encodePowerShell(command: string): string {
  return Buffer.from(command, 'utf16le').toString('base64')
}

/** How long a check result stays fresh, so opening a screen does not respawn a shell. */
const CHECK_TTL_MS = 5000

let cache: { at: number; status: FirewallStatus } | null = null

/** Forget the cached check, so the next call really asks Windows again. */
export function clearFirewallCache(): void {
  cache = null
}

/**
 * Ask Windows whether each rule exists.
 *
 * `Get-NetFirewallRule` needs no admin rights. The output is classified rather
 * than trusted blindly: a rule that is neither found nor reported is
 * 'unknown', never 'missing', so the instructor is not sent to install a rule
 * they already have.
 */
export async function checkFirewallRules(force = false): Promise<FirewallStatus> {
  if (process.platform !== 'win32') {
    return { ok: true, missing: [], unknown: [], supported: false }
  }
  if (!force && cache && Date.now() - cache.at < CHECK_TTL_MS) return cache.status

  let status: FirewallStatus
  const probe = await probeWithPowerShell(FIREWALL_RULES)
  if (probe) {
    // A rule the script never mentioned is unknown, not missing.
    const mentioned = new Set([...probe.present, ...probe.missing, ...probe.unknown])
    const unknown = [...probe.unknown]
    for (const rule of FIREWALL_RULES) {
      if (!mentioned.has(rule.name)) unknown.push(rule.name)
    }
    status = {
      ok: probe.missing.length === 0 && unknown.length === 0,
      missing: probe.missing,
      unknown,
      supported: true
    }
  } else {
    status = await checkWithNetsh()
  }

  cache = { at: Date.now(), status }
  return status
}

/**
 * The primary check: one PowerShell process for all rules.
 *
 * Returns null when the script could not be run or said nothing we understand,
 * so the caller can fall back to the netsh text check.
 */
async function probeWithPowerShell(rules: readonly FirewallRule[]): Promise<FirewallProbe | null> {
  const script = encodePowerShell(buildCheckScript(rules))
  const stdout = await new Promise<string>((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', script],
      { windowsVerbatimArguments: true, timeout: 20000 },
      (_e, out) => resolve(out ?? '')
    )
  })
  const probe = parseCheckOutput(stdout)
  const total = probe.present.length + probe.missing.length + probe.unknown.length
  return total === 0 ? null : probe
}

/**
 * The fallback check: one netsh per rule, classifying the text it prints.
 *
 * Only used when the cmdlets are unavailable. It reads netsh's wording, which
 * is localized, so on a non-English Windows it can only ever answer 'unknown'.
 */
async function checkWithNetsh(): Promise<FirewallStatus> {
  const missing: string[] = []
  const unknown: string[] = []
  for (const rule of FIREWALL_RULES) {
    const state = await new Promise<'present' | 'missing' | 'unknown'>((resolve) => {
      execFile('netsh', buildCheckArgs(rule), CHECK_OPTIONS, (_e, stdout) => {
        resolve(classifyCheckOutput(stdout ?? ''))
      })
    })
    if (state === 'missing') missing.push(rule.name)
    // 'unknown' means netsh did something we do not recognise. Do not claim the
    // rule is missing; that would nag the instructor to install a rule they
    // probably already have.
    else if (state === 'unknown') unknown.push(rule.name)
  }
  return { ok: missing.length === 0 && unknown.length === 0, missing, unknown, supported: true }
}

/**
 * Install the missing rules via an elevated process, prompting for UAC.
 *
 * Only ever called from the instructor's click. Re-checks afterwards, because
 * the elevated command can fail even after the user said yes, and the user can
 * decline the prompt entirely.
 */
export async function installFirewallRules(): Promise<FirewallInstallResult> {
  if (process.platform !== 'win32') return 'failed'

  // Only touch what is absent, so an existing rule is never re-added and no
  // duplicate can be created. There is no delete step: these rules were just
  // found missing, so there is nothing to delete, and netsh exits non-zero when
  // no rule matches.
  const status = await checkFirewallRules(true)
  const toInstall = FIREWALL_RULES.filter((r) => status.missing.includes(r.name))
  if (toInstall.length === 0) return 'installed'

  // The netsh commands travel as base64 of UTF-16LE, so there are no spaces or
  // quotes for Start-Process to re-split. Nothing from the renderer is in it:
  // every character comes from the constants above.
  const encoded = encodePowerShell(buildInstallCommand(toInstall))
  const ps = [
    'Start-Process',
    "-FilePath 'powershell.exe'",
    `-ArgumentList '-NoProfile','-NonInteractive','-EncodedCommand','${encoded}'`,
    '-Verb RunAs',
    '-Wait'
  ].join(' ')

  const err = await new Promise<Error | null>((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', ps],
      (e) => resolve(e)
    )
  })

  if (err) {
    // Start-Process itself failing means the elevation prompt was declined.
    const msg = `${(err as { stderr?: string }).stderr ?? ''} ${err.message}`
    if (/canceled by the user|operation is canceled|access is denied/i.test(msg)) {
      clearFirewallCache()
      return 'cancelled'
    }
    // Anything else: fall through to the firewall read-back below, which is the
    // only trustworthy signal. The elevated process's exit code is not visible
    // here, and netsh exits 0 even when a rule fails to add.
  }

  // Decide from the real firewall state rather than trusting the exit code.
  const after = await checkFirewallRules(true)
  return after.ok ? 'installed' : 'failed'
}
