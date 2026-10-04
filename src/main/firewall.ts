/**
 * Windows firewall rules for the quiz server.
 *
 * The app can install them itself, but only when the instructor clicks the
 * button: the install needs an elevation prompt, so it is never automatic.
 * setup-firewall.bat does the same thing manually.
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
 * Classify the output of the read-only query.
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
 * Pure: given rules it returns a string, with no process or shell involved.
 */
export function buildInstallCommand(rules: readonly FirewallRule[]): string {
  return rules
    .map(
      (r) =>
        `& netsh advfirewall firewall add rule name="${r.name}" dir=in action=allow protocol=${r.protocol} localport=${r.port} profile=${FIREWALL_PROFILE}`
    )
    .join('; ')
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

/**
 * Ask Windows whether each rule exists.
 *
 * `netsh ... show rule` is read-only, so this needs no admin rights. The output
 * is classified rather than trusting the exit code, because netsh exits 1 for
 * usage errors too.
 */
export async function checkFirewallRules(): Promise<FirewallStatus> {
  if (process.platform !== 'win32') {
    return { ok: true, missing: [], unknown: [], supported: false }
  }

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
  return { ok: missing.length === 0, missing, unknown, supported: true }
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
  const status = await checkFirewallRules()
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
      return 'cancelled'
    }
    // Anything else: fall through to the firewall read-back below, which is the
    // only trustworthy signal. The elevated process's exit code is not visible
    // here, and netsh exits 0 even when a rule fails to add.
  }

  // Decide from the real firewall state rather than trusting the exit code.
  const after = await checkFirewallRules()
  return after.ok ? 'installed' : 'failed'
}