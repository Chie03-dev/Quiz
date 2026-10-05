/**
 * Drives the real instructor UI through the Chrome DevTools Protocol.
 *
 *   npm run ui-check
 *
 * Expects the app to already be running with
 *   npx electron --remote-debugging-port=9222 .
 * Clicks the actual buttons in the renderer, so the IPC path is exercised
 * exactly as it is when a human clicks.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { resolve } from 'node:path'
import WebSocket from 'ws'
import type { StateSnapshot } from '../src/shared/types'

const CDP = 'http://127.0.0.1:9222'
const log = (ok: boolean, msg: string): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${msg}`)
  if (!ok) process.exitCode = 1
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Minimal CDP client over the page's websocket. */
class Cdp {
  private ws: WebSocket
  private id = 0
  private pending = new Map<number, (v: any) => void>()

  private constructor(ws: WebSocket) {
    this.ws = ws
    ws.on('message', (raw: WebSocket.RawData) => {
      const msg = JSON.parse(raw.toString())
      const done = this.pending.get(msg.id)
      if (done) {
        this.pending.delete(msg.id)
        done(msg.result)
      }
    })
  }

  static async attach(): Promise<Cdp> {
    const list = await (await fetch(`${CDP}/json/list`)).json()
    const page = list.find((t: any) => t.type === 'page')
    if (!page) throw new Error('no renderer page exposed on the CDP port')
    const ws = new WebSocket(page.webSocketDebuggerUrl)
    await new Promise<void>((res, rej) => ws.once('open', () => res()).once('error', rej))
    return new Cdp(ws)
  }

  send(method: string, params: unknown = {}): Promise<any> {
    const id = ++this.id
    return new Promise((res) => {
      this.pending.set(id, res)
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }

  /** Evaluates an expression in the page and returns its JSON value. */
  async eval<T>(expr: string): Promise<T> {
    const r = await this.send('Runtime.evaluate', {
      expression: expr,
      returnByValue: true,
      awaitPromise: true
    })
    if (r?.exceptionDetails) throw new Error(r.exceptionDetails.text)
    return r?.result?.value as T
  }

  close(): void {
    this.ws.close()
  }
}

/** Reads the state the renderer currently holds. */
const readUi = (cdp: Cdp): Promise<StateSnapshot | null> =>
  cdp.eval<StateSnapshot | null>('window.quiz.getState()')

/** Finds an element by its visible label and really clicks it. */
const clickByLabel = (cdp: Cdp, label: string, selector = 'button'): Promise<boolean> =>
  cdp.eval<boolean>(`(() => {
    const el = [...document.querySelectorAll(${JSON.stringify(selector)})]
      .find((b) => b.textContent.trim() === ${JSON.stringify(label)})
    if (!el) return false
    el.click()
    return true
  })()`)

/**
 * Starts a fake student against the running app.
 * tsx is invoked directly (not via npm) so no shell is needed.
 */
function joinStudent(name: string, pin: string, ip: string, port: number, answer = false): ChildProcess {
  const tsx = resolve('node_modules', '.bin', process.platform === 'win32' ? 'tsx.cmd' : 'tsx')
  const argv = ['scripts/fake-student.ts', '--pin', pin, '--name', name, '--ip', ip, '--port', String(port)]
  if (answer) argv.push('--answer')
  return spawn(tsx, argv, { stdio: 'ignore', shell: process.platform === 'win32' })
}

/**
 * Polls until fn returns something truthy. Returns the narrowed, non-null value
 * or throws on timeout.
 */
async function waitFor<T>(fn: () => Promise<T | null | undefined>, ms = 15_000): Promise<NonNullable<T>> {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    const v = await fn()
    if (v) return v as NonNullable<T>
    await sleep(250)
  }
  throw new Error('timed out')
}

async function main(): Promise<void> {
  const cdp = await Cdp.attach()
  const kids: ChildProcess[] = []

  try {
    const before = await readUi(cdp)
    if (!before) throw new Error('renderer has no state; is the app running?')
    const { pin, port, selectedIp, addresses } = before.server
    console.log(`UI session PIN ${pin} on ${selectedIp}:${port}`)

    // --- two students join the real running app ---
    kids.push(joinStudent('Alice', pin, selectedIp, port))
    kids.push(joinStudent('Bob', pin, selectedIp, port))
    const two = await waitFor(async () => {
      const s = await readUi(cdp)
      return s && s.students.length === 2 ? s : null
    })
    log(two.students.every((s) => s.status === 'connected'), 'two students show as CONNECTED in the UI')

    // --- Kick button ---
    log(await clickByLabel(cdp, 'Kick'), 'Kick button was found and clicked')
    const one = await waitFor(async () => {
      const s = await readUi(cdp)
      return s && s.students.length === 1 ? s : null
    })
    log(one.students[0].name === 'Bob', 'clicking Kick removed only that student')

    // --- alternate address (the UI renders each link as "ip:port") ---
    const other = addresses.find((a) => a !== selectedIp)
    if (other) {
      const label = `${other}:${port}`
      const present = await clickByLabel(cdp, label, 'a,button')
      log(present, `the alternate address ${label} is clickable in the UI`)
      if (present) {
        const switched = await waitFor(async () => {
          const s = await readUi(cdp)
          return s && s.server.selectedIp === other ? s : null
        })
        log(switched.server.selectedIp === other, 'UI switches the advertised address')
        // The selected address is shown as plain text, not a link, so there is
        // no in-UI way back; do it over the preload API instead.
        await cdp.eval(`window.quiz.selectIp(${JSON.stringify(selectedIp)})`)
        await waitFor(async () => ((await readUi(cdp))!.server.selectedIp === selectedIp))
        log(true, 'the address can be switched back')
      }
    } else {
      log(true, 'only one LAN address; switch skipped')
    }

    // --- New session button ---
    log(await clickByLabel(cdp, 'New session'), 'New session button was found and clicked')
    const fresh = await waitFor(async () => {
      const s = await readUi(cdp)
      return s && s.server.pin !== pin ? s : null
    })
    log(fresh.server.pin !== pin, `New session issues a new PIN (${pin} -> ${fresh.server.pin})`)
    log(fresh.students.length === 0, 'New session empties the lobby in the UI')
    log(fresh.server.port === port, 'New session keeps the same port')

    // --- Start quiz: disabled with nobody in the lobby ---
    const lobbyWithNone = await readUi(cdp)
    log(lobbyWithNone!.quiz.status === 'lobby', 'the fresh UI is in the lobby state')
    const fresh2 = await cdp.eval<{ status: string; status2: string }>(`(() => {
      const btn = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Start quiz')
      return { status: btn ? 'found' : 'missing', status2: btn && btn.disabled ? 'disabled' : 'enabled' }
    })()`)
    log(fresh2.status === 'found', 'the Start quiz button is rendered')
    log(fresh2.status2 === 'disabled', 'Start quiz is disabled with zero connected students')

    // --- two students join, then the quiz runs ---
    const freshPin = fresh.server.pin
    kids.push(joinStudent('Cara', freshPin, selectedIp, port, true))
    kids.push(joinStudent('Dan', freshPin, selectedIp, port))
    const joined2 = await waitFor(async () => {
      const s = await readUi(cdp)
      return s && s.students.length === 2 ? s : null
    })
    log(
      joined2.students.every((s) => s.status === 'connected'),
      'two fresh students are connected'
    )
    log(await clickByLabel(cdp, 'Start quiz'), 'Start quiz is clickable once students are connected')
    const askedConfirm = await clickByLabel(cdp, 'Start for 2 students?')
    log(askedConfirm, 'Start quiz asks for confirmation before starting')
    const running = await waitFor(async () => {
      const s = await readUi(cdp)
      return s && s.quiz.status === 'running' ? s : null
    })
    log(running.quiz.status === 'running', 'the lobby switches to the running view')
    log(running.quiz.endsAt !== null && running.quiz.endsAt > Date.now(), 'the running view carries an endsAt')
    log(running.quiz.questions.length === 8, `all 8 questions are listed (${running.quiz.questions.length})`)
    const hasCountdown = await cdp.eval<boolean>(
      `!!document.querySelector('.countdown') && document.querySelector('.countdown').textContent.trim().length > 0`
    )
    log(hasCountdown, 'the running view shows a countdown')

    // Cara answers every question as soon as quiz_start arrives.
    const answered = await waitFor(async () => {
      const s = await readUi(cdp)
      const cara = s?.students.find((x) => x.name === 'Cara')
      return cara && s!.quiz.answeredByStudent[cara.id] === 8 ? s : null
    })
    log(
      answered.quiz.questions.every((q) => q.answered === 1),
      'the per-question counts follow the fake student that answered'
    )

    log(await clickByLabel(cdp, 'End quiz now'), 'the End quiz now button is present')
    log(await clickByLabel(cdp, 'Yes, end it'), 'ending the quiz asks for confirmation')
    const ended = await waitFor(async () => {
      const s = await readUi(cdp)
      return s && s.quiz.status === 'ended' ? s : null
    })
    log(ended.quiz.status === 'ended', 'the UI switches to the ended view')
    log(ended.quiz.endReason === 'instructor', 'the ended view knows why it ended')
    const heading = await cdp.eval<string>(`document.querySelector('.topbar h1').textContent.trim()`)
    log(heading === 'Quiz ended', `the ended view says "Quiz ended" (${heading})`)
    const shownText = await cdp.eval<string>(`document.body.textContent.toLowerCase()`)
    log(
      !shownText.includes('score') && !shownText.includes('point:'),
      'the ended view shows counts only, never scores'
    )

    log(await clickByLabel(cdp, 'New session'), 'New session is available on the ended view')

    console.log('done')
  } finally {
    for (const k of kids) k.kill()
    cdp.close()
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})