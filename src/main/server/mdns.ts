import { Bonjour, type Service } from 'bonjour-service'

export interface BonjourAdvertiser {
  stop(): void
  /** Current advertised name, or null if mDNS is unavailable. */
  readonly name: string | null
  readonly error: string | null
}

const SERVICE_TYPE = 'quiz'

/**
 * Advertises the server as quiz-<PIN> so phones can browse for it by PIN.
 * Convenience only: the QR code works without mDNS.
 */
export function advertiseServer(pin: string, port: number): BonjourAdvertiser {
  let bonjour: Bonjour | null = null
  let service: Service | null = null
  let error: string | null = null
  const name = `quiz-${pin}`

  try {
    // Registry-level failures (e.g. the name is still unregistering) land here.
    bonjour = new Bonjour({}, (err: Error) => {
      error = err.message
    })
    service = bonjour.publish({ name, type: SERVICE_TYPE, port, txt: { pin } })
    service.on?.('error', (err: Error) => {
      error = err.message
    })
  } catch (err) {
    error = err instanceof Error ? err.message : String(err)
  }

  return {
    get name() {
      return service ? name : null
    },
    get error() {
      return error
    },
    stop() {
      try {
        // Destroy (not just stop) so the name is released immediately; otherwise a
        // new session can fail with "Service name is already in use".
        service?.stop?.()
        bonjour?.destroy?.()
      } catch {
        /* nothing useful to do while shutting down */
      }
      service = null
      bonjour = null
    }
  }
}