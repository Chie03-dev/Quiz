/**
 * The meaning side of the search: vectors of a text.
 *
 * The app runs a small embedding model through llama.cpp. The model is a
 * separate download (about 25 MB) and is only used when it is there: without
 * it the search works on words alone.
 *
 * llama.cpp serves embeddings over HTTP, so the engine is started as a
 * server, asked for the vectors, and kept running for the session.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createServer } from 'node:net'

import type { Embedder } from './types'

/** How long the server may take to come up. */
const STARTUP_TIMEOUT_MS = 60_000
/** How long one request may take. */
const REQUEST_TIMEOUT_MS = 60_000
/** The ports the embedding server tries, one after the other. */
const PORT_RANGE = [18080, 18081, 18082, 18083, 18084]

/** A port that is free right now. */
export function findFreePort(preferred: number[] = PORT_RANGE): Promise<number | null> {
  return new Promise((resolve) => {
    let index = 0
    const tryNext = (): void => {
      if (index >= preferred.length) {
        resolve(null)
        return
      }
      const port = preferred[index]
      index++
      const server = createServer()
      server.once('error', () => {
        server.close()
        tryNext()
      })
      server.once('listening', () => {
        server.close(() => resolve(port))
      })
      server.listen(port, '127.0.0.1')
    }
    tryNext()
  })
}

export interface LlamaEmbedderOptions {
  /** The llama-server binary. */
  binaryPath: string
  /** The embedding model file. */
  modelPath: string
  /** The port the server listens on; one is picked when this is empty. */
  port?: number
  /** How many threads the server may use. */
  threads?: number
}

/**
 * An embedder that only starts when it is needed.
 *
 * The embedding model can be downloaded long after the app started, so the
 * embedder is asked whether it can work every time, and the server is only
 * started when the answer is yes.
 */
export class LazyEmbedder implements Embedder {
  private inner: Embedder | null = null

  constructor(private readonly create: () => Embedder | null) {}

  /** True when the embedding model and the engine are there. */
  ready(): boolean {
    return this.current() !== null
  }

  /** The vectors of the texts; empty when there is no embedding model. */
  async embed(texts: string[]): Promise<number[][]> {
    const embedder = this.current()
    if (!embedder) return []
    return embedder.embed(texts)
  }

  /** Stops the embedding server, when it is running. */
  stop(): void {
    this.inner?.stop?.()
    this.inner = null
  }

  /** The embedder, made when there is one. */
  private current(): Embedder | null {
    if (this.inner) return this.inner
    const made = this.create()
    if (made) this.inner = made
    return made
  }
}

/**
 * An embedder that asks a local llama.cpp server for the vectors.
 */
export class LlamaEmbedder implements Embedder {
  private server: ChildProcess | null = null
  private starting: Promise<boolean> | null = null
  private lastError = ''
  private port: number | null = null

  constructor(private readonly opts: LlamaEmbedderOptions) {}

  /** True when the binary and the model are there. */
  ready(): boolean {
    return existsSync(this.opts.binaryPath) && existsSync(this.opts.modelPath)
  }

  /** The reason the embedder does not work, when it does not. */
  get error(): string {
    return this.lastError
  }

  /** The vectors of the texts, in the same order. */
  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return []
    if (!this.ready()) {
      this.lastError = 'The embedding model is not there.'
      return []
    }

    const up = await this.start()
    if (!up || !this.port) return []

    try {
      const response = await fetch(`http://127.0.0.1:${this.port}/v1/embeddings`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ input: texts, model: 'local' }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      })
      if (!response.ok) {
        this.lastError = `The embedding server answered with ${response.status}.`
        return []
      }
      const body = (await response.json()) as { data?: { embedding: number[] }[] }
      const vectors = body.data ?? []
      return texts.map((_, i) => vectors[i]?.embedding ?? [])
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err)
      return []
    }
  }

  /** Starts the server if it is not running yet. */
  private async start(): Promise<boolean> {
    if (this.server) return true
    if (this.starting) return this.starting
    this.starting = this.launch()
    const ok = await this.starting
    this.starting = null
    return ok
  }

  /** Starts llama-server and waits until it answers. */
  private async launch(): Promise<boolean> {
    const port = this.opts.port ?? (await findFreePort()) ?? PORT_RANGE[0]
    this.port = port
    const args = [
      '-m',
      this.opts.modelPath,
      '--embedding',
      '--pooling',
      'mean',
      '--port',
      String(port),
      '--host',
      '127.0.0.1',
      '-c',
      '2048',
      '-t',
      String(this.opts.threads ?? 4)
    ]

    let child: ChildProcess
    try {
      child = spawn(this.opts.binaryPath, args, { windowsHide: true })
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err)
      return false
    }

    this.server = child
    child.on('exit', () => {
      this.server = null
    })
    child.on('error', (err) => {
      this.lastError = err.message
      this.server = null
    })

    const deadline = Date.now() + STARTUP_TIMEOUT_MS
    while (Date.now() < deadline) {
      if (!this.server) return false
      try {
        const health = await fetch(`http://127.0.0.1:${port}/health`, {
          signal: AbortSignal.timeout(2000)
        })
        if (health.ok) return true
      } catch {
        // Not up yet.
      }
      await new Promise((resolve) => setTimeout(resolve, 400))
    }

    this.lastError = 'The embedding server did not start in time.'
    this.stop()
    return false
  }

  /** Stops the server. */
  stop(): void {
    if (!this.server) return
    this.server.kill()
    this.server = null
  }
}
