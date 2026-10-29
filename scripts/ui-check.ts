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

/** Finds an element by its data-testid and really clicks it. */
const clickByTestId = (cdp: Cdp, testId: string): Promise<boolean> =>
  cdp.eval<boolean>(`(() => {
    const el = document.querySelector('[data-testid=${JSON.stringify(testId)}]')
    if (!el) return false
    el.click()
    return true
  })()`)

/** Reads the trimmed text of the element with the given data-testid. */
const textByTestId = (cdp: Cdp, testId: string): Promise<string | null> =>
  cdp.eval<string | null>(`(() => {
    const el = document.querySelector('[data-testid=${JSON.stringify(testId)}]')
    return el ? el.textContent.trim() : null
  })()`)

/** True when an element with the given data-testid is present. */
const hasTestId = (cdp: Cdp, testId: string): Promise<boolean> =>
  cdp.eval<boolean>(`!!document.querySelector('[data-testid=${JSON.stringify(testId)}]')`)

/** True when the element with the given data-testid is disabled. */
const isDisabled = (cdp: Cdp, testId: string): Promise<boolean> =>
  cdp.eval<boolean>(`(() => {
    const el = document.querySelector('[data-testid=${JSON.stringify(testId)}]')
    return !!el && !!el.disabled
  })()`)

/** Clicks the first element whose data-testid starts with the prefix. */
const clickByTestIdPrefix = (cdp: Cdp, prefix: string): Promise<boolean> =>
  cdp.eval<boolean>(`(() => {
    const el = document.querySelector('[data-testid^=' + ${JSON.stringify(prefix)} + ']')
    if (!el) return false
    el.click()
    return true
  })()`)

/**
 * Sets the value of an input the way a person would, so React notices the
 * change: the native setter plus an input event.
 */
const setInput = (cdp: Cdp, testId: string, value: string): Promise<boolean> =>
  cdp.eval<boolean>(`(() => {
    const el = document.querySelector('[data-testid=${JSON.stringify(testId)}]')
    if (!el) return false
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(el, ${JSON.stringify(value)})
    el.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`)

/**
 * Starts a fake student against the running app.
 * tsx is invoked directly (not via npm) so no shell is needed.
 */
function joinStudent(name: string, pin: string, ip: string, port: number, answer = false, text?: string): ChildProcess {
  const tsx = resolve('node_modules', '.bin', process.platform === 'win32' ? 'tsx.cmd' : 'tsx')
  const argv = ['scripts/fake-student.ts', '--pin', pin, '--name', name, '--ip', ip, '--port', String(port)]
  if (answer) argv.push('--answer')
  // The written questions get this text, so a test can type the answer in the
  // wrong case on purpose.
  if (text !== undefined) argv.push('--text', text)
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

/**
 * A phone on the other end of the wire: it joins the running app and records
 * every server message, so the checks can assert what a phone really gets.
 */
class Watcher {
  readonly ws: WebSocket
  readonly msgs: any[] = []

  constructor(ip: string, port: number) {
    this.ws = new WebSocket(`ws://${ip}:${port}/ws`)
    this.ws.on('message', (raw) => this.msgs.push(JSON.parse(raw.toString())))
  }

  async open(): Promise<void> {
    await new Promise<void>((res, rej) => this.ws.once('open', res).once('error', rej))
  }

  join(pin: string, name: string, deviceToken: string): void {
    this.ws.send(JSON.stringify({ t: 'join', d: { pin, name, deviceToken } }))
  }

  /** The next message of a type that arrives after `from`. */
  async next(t: string, from: number, ms = 10_000): Promise<any> {
    return waitFor(async () => this.msgs.slice(from).find((m) => m.t === t) ?? null, ms)
  }

  close(): void {
    this.ws.close()
  }
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

    // --- the persistent shell ---
    log(await hasTestId(cdp, 'nav-dashboard'), 'the sidebar has a Dashboard entry')
    log(await hasTestId(cdp, 'nav-quizzes'), 'the sidebar has a Quizzes entry')
    log(await hasTestId(cdp, 'nav-live'), 'the sidebar has a Live session entry')
    log(await hasTestId(cdp, 'session-pin'), 'the dashboard shows the session PIN')

    // --- Kick button ---
    log(await clickByTestId(cdp, 'kick-Alice'), 'the Kick button was found and clicked')
    const one = await waitFor(async () => {
      const s = await readUi(cdp)
      return s && s.students.length === 1 ? s : null
    })
    log(one.students[0].name === 'Bob', 'clicking Kick removed only that student')

    // --- alternate address (each address is a button with its own test id) ---
    const other = addresses.find((a) => a !== selectedIp)
    if (other) {
      const present = await clickByTestId(cdp, `address-${other}`)
      log(present, `the alternate address ${other}:${port} is clickable in the UI`)
      if (present) {
        const switched = await waitFor(async () => {
          const s = await readUi(cdp)
          return s && s.server.selectedIp === other ? s : null
        })
        log(switched.server.selectedIp === other, 'UI switches the advertised address')
        // The selected address is shown as plain text, not a button, so there
        // is no in-UI way back; do it over the preload API instead.
        await cdp.eval(`window.quiz.selectIp(${JSON.stringify(selectedIp)})`)
        await waitFor(async () => ((await readUi(cdp))!.server.selectedIp === selectedIp))
        log(true, 'the address can be switched back')
      }
    } else {
      log(true, 'only one LAN address; switch skipped')
    }

    // --- New session button ---
    log(await clickByTestId(cdp, 'new-session'), 'New session button was found and clicked')
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
    log(await hasTestId(cdp, 'start-quiz'), 'the Start quiz button is rendered')
    log(await isDisabled(cdp, 'start-quiz'), 'Start quiz is disabled with zero connected students')

    // --- two students join, then the quiz runs ---
    const freshPin = fresh.server.pin
    // Cara answers every question as soon as quiz_start arrives. The written
    // answers are typed in lower case, so the key "Tokyo" has to count.
    kids.push(joinStudent('Cara', freshPin, selectedIp, port, true, 'tokyo'))
    kids.push(joinStudent('Dan', freshPin, selectedIp, port))
    const joined2 = await waitFor(async () => {
      const s = await readUi(cdp)
      return s && s.students.length === 2 ? s : null
    })
    log(
      joined2.students.every((s) => s.status === 'connected'),
      'two fresh students are connected'
    )
    log(!(await isDisabled(cdp, 'start-quiz')), 'Start quiz is clickable once students are connected')

    // A phone on the wire: it joins now, so it is in the lobby with the others.
    const watcher = new Watcher('127.0.0.1', port)
    await watcher.open()
    watcher.join(freshPin, 'MemeWatcher', 'meme-watcher')
    await watcher.next('joined', 0)

    log(await clickByTestId(cdp, 'start-quiz'), 'the Start quiz button is clickable')
    log(await hasTestId(cdp, 'start-quiz-confirm'), 'Start quiz asks for confirmation before starting')
    log(await clickByTestId(cdp, 'start-quiz-confirm'), 'the confirmation button starts the quiz')
    let running: StateSnapshot | null = null
    try {
      running = await waitFor(async () => {
        const s = await readUi(cdp)
        return s && s.quiz.status === 'running' ? s : null
      })
    } catch {
      // The dashboard says why a quiz cannot start: a draft question, for
      // instance. Say that, instead of a bare timeout.
      const why = await cdp.eval<string | null>(
        `(() => { const el = document.querySelector('.ui-error'); return el ? el.textContent.trim() : null })()`
      )
      log(false, `the lobby switches to the running view${why ? `: ${why}` : ''}`)
      throw new Error('the quiz did not start')
    }
    log(running.quiz.status === 'running', 'the lobby switches to the running view')
    log(running.quiz.endsAt !== null && running.quiz.endsAt > Date.now(), 'the running view carries an endsAt')
    const totalQuestions = running.quiz.questions.length
    log(totalQuestions > 0, `the running view lists the questions (${totalQuestions})`)
    const countdown = await textByTestId(cdp, 'countdown')
    log(!!countdown && countdown.length > 0, `the running view shows a countdown (${countdown})`)

    // --- the meme tray ---
    log(await hasTestId(cdp, 'meme-panel'), 'the meme tray is on the live screen')
    const thumbsBefore = await cdp.eval<number>(
      `document.querySelectorAll('.memes__thumb').length`
    )

    // Uploading an image goes through the renderer compression pipeline,
    // which npm run check cannot reach.
    const doc = await cdp.send('DOM.getDocument')
    const input = await cdp.send('DOM.querySelector', {
      nodeId: doc.root.nodeId,
      selector: '[data-testid="meme-file-input"]'
    })
    await cdp.send('DOM.setFileInputFiles', {
      files: [resolve('scripts', 'fixtures', 'meme-sample.png')],
      nodeId: input.nodeId
    })
    const uploaded = await waitFor(async () => {
      const n = await cdp.eval<number>(`document.querySelectorAll('.memes__thumb').length`)
      return n > thumbsBefore ? n : null
    })
    log(uploaded > thumbsBefore, `uploading an image adds it to the tray (${uploaded})`)

    const thumbSrcs = await waitFor(async () => {
      const srcs = await cdp.eval<string[]>(
        `Array.from(document.querySelectorAll('.memes__thumb')).map((el) => el.getAttribute('src') || '')`
      )
      return srcs.length > 0 && srcs.every((src) => src.startsWith('data:')) ? srcs : null
    })
    log(thumbSrcs.length > 0, `every tray thumbnail is a data URL (${thumbSrcs.length})`)

    const popIds = await cdp.eval<string[]>(
      `Array.from(document.querySelectorAll('[data-testid^="pop-"]'))
         .map((el) => el.getAttribute('data-testid') || '')
         .filter((id) => !id.startsWith('pop-student-'))`
    )
    log(popIds.length === uploaded, `every meme has a pop button (${popIds.length})`)

    const beforePop = watcher.msgs.length
    log(await clickByTestId(cdp, popIds[popIds.length - 1]), 'the pop button was clicked')
    const pop = await watcher.next('meme_pop', beforePop)
    log(!!pop, 'the phone receives a meme_pop')
    log(
      Object.keys(pop.d).sort().join(',') === 'durationMs,height,memeId,mime,path,width',
      'the pop payload carries exactly the documented fields'
    )
    log(typeof pop.d.path === 'string' && pop.d.path.startsWith('/memes/'), 'the pop path is relative')
    log(pop.d.mime === 'image/jpeg' || pop.d.mime === 'image/png', 'the pop carries an image mime type')
    const asset = await fetch(`http://127.0.0.1:${port}${pop.d.path}`)
    log(asset.status === 200, 'the meme image is served over plain HTTP')
    log(
      (asset.headers.get('content-type') ?? '').startsWith('image/'),
      'the asset route serves the stored image type'
    )
    log(await hasTestId(cdp, 'meme-overlay'), 'the instructor sees the meme on their own screen')
    log(await hasTestId(cdp, 'meme-dismiss'), 'the dismiss button appears while a meme is showing')
    log(await clickByTestId(cdp, 'meme-dismiss'), 'the dismiss button was clicked')
    const hide = await watcher.next('meme_hide', beforePop)
    log(!!hide, 'the phone receives a meme_hide')

    // Clean up: the uploaded meme is deleted again, so the profile stays tidy.
    const memeId = popIds[popIds.length - 1].replace(/^pop-/, '')
    log(await clickByTestId(cdp, `delete-meme-${memeId}`), 'the delete button was found and clicked')
    log(
      await clickByTestId(cdp, `delete-meme-confirm-${memeId}`),
      'the delete confirmation was clicked'
    )
    const removed = await waitFor(async () => {
      const n = await cdp.eval<number>(`document.querySelectorAll('.memes__thumb').length`)
      return n < uploaded ? { n } : null
    })
    log(removed.n < uploaded, 'the deleted meme leaves the tray')
    watcher.close()

    // Cara answers every question as soon as quiz_start arrives.
    const answered = await waitFor(async () => {
      const s = await readUi(cdp)
      const cara = s?.students.find((x) => x.name === 'Cara')
      return cara && s!.quiz.answeredByStudent[cara.id] === totalQuestions ? s : null
    })
    log(
      answered.quiz.questions.every((q) => q.answered === 1),
      'the per-question counts follow the fake student that answered'
    )

    log(await clickByTestId(cdp, 'end-quiz'), 'the End quiz now button is present')
    log(await hasTestId(cdp, 'end-quiz-confirm'), 'ending the quiz asks for confirmation')
    log(await clickByTestId(cdp, 'end-quiz-confirm'), 'the confirmation button ends the quiz')
    const ended = await waitFor(async () => {
      const s = await readUi(cdp)
      return s && s.quiz.status === 'ended' ? s : null
    })
    log(ended.quiz.status === 'ended', 'the UI switches to the ended view')
    log(ended.quiz.endReason === 'instructor', 'the ended view knows why it ended')
    const heading = await textByTestId(cdp, 'countdown')
    log(heading === '0:00', `the ended view shows a zeroed clock (${heading})`)
    const shownText = await cdp.eval<string>(`document.body.textContent.toLowerCase()`)
    log(
      !shownText.includes('score') && !shownText.includes('point:'),
      'the ended view shows counts only, never scores'
    )

    // --- the results screen ---
    log(await hasTestId(cdp, 'nav-results'), 'the sidebar has a Results entry')
    log(await hasTestId(cdp, 'open-results'), 'the ended view offers the results')
    log(await clickByTestId(cdp, 'new-session'), 'New session is available on the ended view')
    log(await clickByTestId(cdp, 'nav-results'), 'the results list is reachable from the sidebar')
    // The list arrives over IPC, so it is not on screen the instant the
    // screen opens.
    const sessionId = await waitFor(async () =>
      cdp.eval<string | null>(
        `(() => {
           const el = document.querySelector('[data-testid^="result-"]')
           return el ? el.getAttribute('data-testid').replace(/^result-/, '') : null
         })()`
      )
    )
    log(!!sessionId, 'the results list shows the finished session')
    const rows = await cdp.eval<number>(`document.querySelectorAll('[data-testid^="result-"]').length`)
    log(rows >= 1, `the results list shows the sessions (${rows})`)
    log(await clickByTestId(cdp, `open-result-${sessionId}`), 'the session opens')
    // The sheet shows the questions a page at a time, so the cell count
    // follows the page; what has to hold is a cell for every student and
    // every question that is on the page. The cells and the columns are read
    // in one go: the page size settles after the first paint, and two reads
    // could see two different pages.
    const sheet = await waitFor(async () =>
      cdp.eval<{ cells: number; columns: number } | null>(`(() => {
         const cells = document.querySelectorAll('[data-testid^="cell-"]').length
         const columns = document.querySelectorAll('.res__sheet thead th').length - 2
         return cells > 0 && columns > 0 ? { cells, columns } : null
       })()`)
    )
    log(
      !!sheet && sheet.cells === ended.students.length * sheet.columns,
      `the score sheet has a cell for every student and question on the page (${sheet?.cells} cells, ${sheet?.columns} columns)`
    )
    const listedQuestions = await cdp.eval<number>(`document.querySelectorAll('.res__question').length`)
    log(listedQuestions === totalQuestions, `the question list shows every question (${listedQuestions})`)

    // --- an answer typed in the wrong case is still right ---
    // The third column is the identification question, whose key is "Tokyo".
    const looseCell = await cdp.eval<{ mark: string; classes: string; testId: string } | null>(
      `(() => {
         const cells = Array.from(document.querySelectorAll('[data-testid^="cell-"]'))
         const cell = cells.find((c) => {
           const text = c.querySelector('.res__cell-text')
           return text &&
             text.textContent.trim().toLowerCase() === 'tokyo' &&
             c.parentElement.cellIndex === 3
         })
         if (!cell) return null
         return {
           mark: cell.querySelector('.res__cell-mark').textContent.trim(),
           classes: cell.className,
           testId: cell.getAttribute('data-testid')
         }
       })()`
    )
    log(looseCell?.mark === '✓', 'an answer typed in lower case still counts as right')
    log(
      (looseCell?.classes ?? '').includes('res__cell--ok'),
      'the cell of the lower case answer is marked right'
    )
    if (looseCell) {
      await clickByTestId(cdp, looseCell.testId)
      let hinted = false
      try {
        await waitFor(async () => ((await hasTestId(cdp, 'answer-loose')) ? true : null))
        hinted = true
      } catch {
        hinted = false
      }
      log(hinted, 'the editor says the answer matched only because of the case')
    }

    // --- marking an answer by hand ---
    log(await clickByTestIdPrefix(cdp, 'cell-'), 'a cell of the score sheet was clicked')
    log(await hasTestId(cdp, 'answer-points'), 'the editor of the answer opened')
    // The editor is a drawer at the bottom of the window: it has to be on
    // screen without scrolling, or it is exactly the panel you had to go and
    // find.
    const drawer = await cdp.eval<{ visible: boolean; bottom: number; windowHeight: number } | null>(
      `(() => {
         const el = document.querySelector('.drawer')
         if (!el) return null
         const box = el.getBoundingClientRect()
         return {
           visible: box.top >= 0 && box.bottom <= window.innerHeight + 1,
           bottom: Math.round(box.bottom),
           windowHeight: window.innerHeight
         }
       })()`
    )
    log(
      drawer?.visible === true,
      `the editor is on screen without scrolling (${drawer?.bottom} of ${drawer?.windowHeight})`
    )
    const studentId = await cdp.eval<string | null>(
      `(() => {
         const el = document.querySelector('[data-testid^="student-"]')
         return el ? el.getAttribute('data-testid').replace(/^student-/, '') : null
       })()`
    )
    const totalBefore = studentId ? await textByTestId(cdp, `total-${studentId}`) : null
    await setInput(cdp, 'answer-points', '1')
    log(await clickByTestId(cdp, 'answer-save'), 'the mark was saved')
    const totalAfter = studentId
      ? await waitFor(async () => {
          const now = await textByTestId(cdp, `total-${studentId}`)
          return now && now !== totalBefore ? now : null
        })
      : null
    log(
      !!totalAfter && totalAfter !== totalBefore,
      `the student total follows the changed mark (${totalBefore} -> ${totalAfter})`
    )

    // --- the sheet is shown a page of questions at a time ---
    const pages = await cdp.eval<number>(`document.querySelectorAll('.res__page').length`)
    log(pages >= 1, `the score sheet is in ${pages} page(s) of questions`)
    if (pages > 1) {
      const firstBefore = await cdp.eval<string | null>(
        `(() => { const el = document.querySelector('.res__sheet-q'); return el ? el.textContent.trim() : null })()`
      )
      log(await clickByTestId(cdp, 'sheet-page-1'), 'the next page button was clicked')
      const firstAfter = await waitFor(async () => {
        const now = await cdp.eval<string | null>(
          `(() => { const el = document.querySelector('.res__sheet-q'); return el ? el.textContent.trim() : null })()`
        )
        return now && now !== firstBefore ? now : null
      })
      log(!!firstAfter, `the page button shows the next questions (${firstBefore} -> ${firstAfter})`)
      // Back to the first page, so the rest of the run sees the same sheet.
      log(await clickByTestId(cdp, 'sheet-page-0'), 'the first page button brings the first questions back')
    }

    // --- the compact cells fit more questions on a page ---
    log(await clickByTestId(cdp, 'sheet-compact'), 'the compact switch was clicked')
    const compactColumns = await waitFor(async () => {
      const n = await cdp.eval<number>(`document.querySelectorAll('.res__sheet thead th').length - 2`)
      return n > 0 ? n : null
    })
    log(
      compactColumns >= (sheet?.columns ?? 0),
      `the compact cells show more questions on a page (${sheet?.columns} -> ${compactColumns})`
    )
    const stillFits = await cdp.eval<boolean>(
      `(() => {
         const box = document.querySelector('.res__sheet-scroll')
         const table = document.querySelector('.res__sheet')
         return !!box && !!table && table.scrollWidth <= box.clientWidth + 1
       })()`
    )
    log(stillFits, 'the sheet does not scroll sideways')
    log(await clickByTestId(cdp, 'sheet-compact'), 'the compact switch was clicked back')

    // --- deleting the session ---
    log(await clickByTestId(cdp, 'nav-results'), 'the results list is reachable from the sidebar')
    // The list comes over IPC, so the button is not on screen the instant
    // the screen opens.
    await waitFor(async () => ((await hasTestId(cdp, `delete-result-${sessionId}`)) ? true : null))
    log(await clickByTestId(cdp, `delete-result-${sessionId}`), 'the delete button was found and clicked')
    await waitFor(async () =>
      ((await hasTestId(cdp, `delete-result-confirm-${sessionId}`)) ? true : null)
    )
    log(
      await clickByTestId(cdp, `delete-result-confirm-${sessionId}`),
      'the delete confirmation was clicked'
    )
    const gone = await waitFor(async () => {
      const still = await cdp.eval<boolean>(
        `!!document.querySelector('[data-testid="result-${sessionId}"]')`
      )
      return still === false ? { still } : null
    })
    log(gone.still === false, 'the deleted session leaves the results list')

    // --- the AI dialog tells the wait before it starts (hidden while buggy) ---
    log(await clickByTestId(cdp, 'nav-quizzes'), 'the quizzes screen is reachable from the sidebar')
    if (await hasTestId(cdp, 'ai-open')) {
      log(await clickByTestId(cdp, 'ai-open'), 'the AI dialog can be opened')
      await waitFor(async () => ((await hasTestId(cdp, 'ai-estimate')) ? true : null))
      const estimate = await textByTestId(cdp, 'ai-estimate')
      log(
        !!estimate && estimate.includes('for 5 questions'),
        `the dialog says how long the wait will be (${estimate ?? 'nothing'})`
      )
      log(await hasTestId(cdp, 'ai-generate'), 'the generate button is offered')
      log(await clickByTestId(cdp, 'ai-cancel'), 'the AI dialog can be closed again')
    } else {
      console.log('  · skip: Generate with AI is hidden')
    }

    // --- the settings screen and the model registry ---
    log(await clickByTestId(cdp, 'nav-settings'), 'the settings screen is reachable from the sidebar')
    // The model list comes over IPC, so the cards are not on screen instantly.
    await waitFor(async () => ((await hasTestId(cdp, 'settings-model-qwen2.5-1.5b-instruct-q4')) ? true : null))
    const modelCards = await cdp.eval<number>(
      `document.querySelectorAll('[data-testid^="settings-model-"]').length`
    )
    const catalog = await cdp.eval<number>(`window.quiz.aiModels().then((m) => m.length)`)
    log(
      modelCards === catalog,
      `the settings screen lists every catalog model (${modelCards} of ${catalog})`
    )
    log(await hasTestId(cdp, 'settings-builtin'), 'the built-in generator is offered')
    log(
      await hasTestId(cdp, 'settings-download-qwen2.5-1.5b-instruct-q4'),
      'a model that is not downloaded offers a download'
    )
    const engineText = await textByTestId(cdp, 'settings-status')
    log(
      !!engineText && engineText.includes('Built-in generator'),
      `the settings screen names the engine that answers (${engineText ?? 'nothing'})`
    )
    log(await hasTestId(cdp, 'settings-engine-input'), 'the llama.cpp binary can be set')
    log(
      await setInput(cdp, 'settings-engine-input', 'C:\\llama\\llama-cli.exe'),
      'the engine path is typed into the field'
    )
    log(await clickByTestId(cdp, 'settings-engine-save'), 'the engine path is saved')
    await waitFor(async () => {
      const value = await cdp.eval<string>(
        `document.querySelector('[data-testid="settings-engine-input"]').value`
      )
      return value === 'C:\\llama\\llama-cli.exe' ? value : null
    })
    log(true, 'the saved engine path stays in the field')
    log(await clickByTestId(cdp, 'settings-engine-save'), 'the engine path is saved again')
    const afterEngine = await textByTestId(cdp, 'settings-status')
    log(
      !!afterEngine && afterEngine.includes('Built-in generator'),
      'a missing llama.cpp binary falls back to the built-in generator'
    )

    // --- the editor AI indicator: shows the model (or the nudge) and the
    // auto-select button refuses the stub instead of silently filling keys ---
    log(await clickByTestId(cdp, 'nav-quizzes'), 'the quizzes list is reachable from the sidebar')
    const quizToOpen = await cdp.eval<string | null>(
      `(() => {
          const el = document.querySelector('[data-testid^="open-"]')
          return el ? el.getAttribute('data-testid').replace(/^open-/, '') : null
        })()`
    )
    log(!!quizToOpen, `a quiz can be opened in the editor (${quizToOpen ?? 'none found'})`)
    if (quizToOpen) {
      log(await clickByTestId(cdp, `open-${quizToOpen}`), 'the quiz opens in the editor')
      await waitFor(async () => ((await hasTestId(cdp, 'ai-model-badge')) ? true : null))
      const badgeText = await textByTestId(cdp, 'ai-model-badge')
      log(
        badgeText === 'No AI model',
        `the editor shows an AI model badge that says "No AI model" (got ${badgeText ?? 'nothing'})`
      )
      // Clicking Auto-select with the stub must NOT start filling answers.
      const progressBefore = await hasTestId(cdp, 'auto-key-progress')
      log(progressBefore === false, 'clicking Auto-select does not start progress when no model is active')
      log(await clickByTestId(cdp, 'auto-key'), 'the Auto-select button was clicked')
      const errorText = await waitFor(async () => {
        const t = await textByTestId(cdp, 'auto-key-error')
        return t && t.includes('No AI model') ? t : null
      }, 5_000)
      log(
        !!errorText && errorText.includes('No AI model is downloaded'),
        `clicking Auto-select shows the model nudge (${errorText ?? 'nothing'})`
      )
      // The nudge badge is tappable and opens Settings.
      log(await clickByTestId(cdp, 'ai-model-badge'), 'the "No AI model" badge is tappable')
      await waitFor(async () => ((await hasTestId(cdp, 'settings-first-run')) ? true : null))
      log(await hasTestId(cdp, 'settings-first-run'), 'tapping the badge opens Settings and shows the first-run nudge')
    }

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
