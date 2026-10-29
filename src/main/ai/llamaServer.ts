import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

export class LlamaServer {
  private process: ChildProcess | null = null
  private port: number
  private baseUrl: string

  constructor(private modelPath: string, private enginePath: string | null) {
    this.port = 8099
    this.baseUrl = 'http://127.0.0.1:' + this.port
  }

  serverBinary(): string | null {
    const engine = this.enginePath?.trim()
    if (engine) {
      const server = join(dirname(engine), 'llama-server.exe')
      if (existsSync(server)) return server
    }
    return null
  }

  async start(): Promise<boolean> {
    const binary = this.serverBinary()
    if (!binary) return false
    if (this.process) return true
    try {
      this.process = spawn(binary, ['-m', this.modelPath, '--port', String(this.port), '-c', '2048'], { windowsHide: true })
    } catch {
      this.process = null
      return false
    }
    // wait for health
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 500))
      try {
        const res = await fetch(this.baseUrl + '/health')
        if (res.ok) return true
      } catch {
        // not ready
      }
    }
    this.stop()
    return false
  }

  async complete(prompt: string, temperature = 0, grammar?: string, nPredict = 2): Promise<{ ok: true; output: string; probs?: any } | { ok: false; error: string }> {
    try {
      const body: any = { prompt, temperature, n_predict: nPredict, n_probs: 4 }
      if (grammar) body.grammar = grammar
      const res = await fetch(this.baseUrl + '/completion', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      })
      if (!res.ok) return { ok: false, error: 'HTTP ' + res.status }
      const data = await res.json() as { content?: string; completion_probabilities?: any }
      const output = (data.content ?? '').trim()
      if (!output) return { ok: false, error: 'empty' }
      return { ok: true, output, probs: data.completion_probabilities }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  stop(): void {
    if (this.process) {
      try { this.process.kill() } catch { /* ignore */ }
      this.process = null
    }
  }
}

