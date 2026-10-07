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
 *
 * hostIp is the instructor-selected LAN address (the same one in the QR).
 * Without it, Windows publishes every adapter (VPN, WSL, …) and multicast
 * often leaves on the wrong NIC, so PIN join fails while QR still works.
 */
export function advertiseServer(pin: string, port: number, hostIp?: string): BonjourAdvertiser {
  let bonjour: Bonjour | null = null
  let service: Service | null = null
  let error: string | null = null
  const name = `quiz-${pin}`
  // SRV target with .local so phones resolve it via the A record we publish.
  const host = `${name}.local`
  const bindIp = hostIp && hostIp !== '127.0.0.1' ? hostIp : undefined

  try {
    // `interface` is a multicast-dns bind address; the package types wrongly
    // describe this argument as ServiceConfig.
    const opts = (bindIp ? { interface: bindIp } : {}) as ConstructorParameters<typeof Bonjour>[0]
    // Registry-level failures (e.g. the name is still unregistering) land here.
    bonjour = new Bonjour(opts, (err: Error) => {
      error = err.message
    })
    service = bonjour.publish({
      name,
      type: SERVICE_TYPE,
      port,
      host,
      txt: { pin },
      disableIPv6: true
    })
    if (hostIp) pinAddressRecords(service, host, hostIp)
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

/**
 * bonjour-service always emits an A record per NIC. Keep only hostIp, and
 * insert one if the library produced none (Node reporting family as 4 not
 * "IPv4" has done that).
 */
function pinAddressRecords(service: Service, host: string, hostIp: string): void {
  const original = service.records.bind(service)
  service.records = () => {
    const recs = original().filter((r) => {
      if (r.type === 'AAAA') return false
      if (r.type === 'A') return r.data === hostIp
      return true
    })
    if (!recs.some((r) => r.type === 'A')) {
      recs.push({ name: host, type: 'A', ttl: 120, data: hostIp })
    }
    return recs
  }
}
