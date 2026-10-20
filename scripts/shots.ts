/**
 * Captures screenshots of the instructor screens for visual review.
 *
 *   npx tsx scripts/shots.ts
 *
 * Expects the app to already be running with
 *   npx electron . --remote-debugging-port=9222 .
 */
import { writeFileSync } from 'node:fs'
import WebSocket from 'ws'

const CDP = 'http://127.0.0.1:9222'
const OUT = 'shots'
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

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

  async eval<T>(expr: string): Promise<T> {
    const r = await this.send('Runtime.evaluate', {
      expression: expr,
      returnByValue: true,
      awaitPromise: true
    })
    if (r?.exceptionDetails) throw new Error(r.exceptionDetails.text)
    return r?.result?.value as T
  }

  /** Sets the window size so the whole shell is visible in the shot. */
  async resize(width: number, height: number): Promise<void> {
    await this.send('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false
    })
  }

  async shot(name: string): Promise<void> {
    const r = await this.send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(`${OUT}/${name}.png`, Buffer.from(r.data, 'base64'))
    console.log(`wrote ${OUT}/${name}.png`)
  }

  close(): void {
    this.ws.close()
  }
}

const click = (cdp: Cdp, testId: string): Promise<boolean> =>
  cdp.eval<boolean>(`(() => {
    const el = document.querySelector('[data-testid=${JSON.stringify(testId)}]')
    if (!el) return false
    el.click()
    return true
  })()`)

async function main(): Promise<void> {
  const cdp = await Cdp.attach()
  try {
    await cdp.resize(1440, 900)
    await sleep(500)

    // Dashboard
    await click(cdp, 'nav-dashboard')
    await sleep(400)
    await cdp.shot('1-dashboard')

    // Library
    await click(cdp, 'nav-quizzes')
    await sleep(600)
    await cdp.shot('2-library')

    // Editor: open the first quiz
    const opened = await cdp.eval<boolean>(`(() => {
      const el = document.querySelector('[data-testid^="open-"]')
      if (!el) return false
      el.click()
      return true
    })()`)
    if (opened) {
      await sleep(800)
      await cdp.shot('3-editor')
    }

    // Back to the dashboard
    await click(cdp, 'nav-dashboard')
    await sleep(400)
    await cdp.shot('4-dashboard')

    // The meme tray at the bottom of the dashboard column.
    await cdp.eval(`(() => {
      const el = document.querySelector('.shell__content')
      if (el) el.scrollTop = el.scrollHeight
      return true
    })()`)
    await sleep(400)
    await cdp.shot('5-memes')
  } finally {
    cdp.close()
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
