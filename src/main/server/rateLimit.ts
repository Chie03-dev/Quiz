// PIN attempt throttling, per docs/protocol.md:
// "after 5 wrong PINs from one IP within 60 s, reject joins from that IP for 60 s."

const WINDOW_MS = 60_000
const MAX_ATTEMPTS = 5

export class PinRateLimiter {
  private attempts = new Map<string, number[]>()
  private blocked = new Map<string, number>()

  /** True when the IP may not try again yet. */
  isBlocked(ip: string): boolean {
    const until = this.blocked.get(ip)
    if (until === undefined) return false
    if (Date.now() >= until) {
      this.blocked.delete(ip)
      this.attempts.delete(ip)
      return false
    }
    return true
  }

  /** Records a wrong PIN. Returns true when this attempt tripped the block. */
  recordFailure(ip: string): boolean {
    const now = Date.now()
    const list = (this.attempts.get(ip) ?? []).filter((t) => now - t < WINDOW_MS)
    list.push(now)
    this.attempts.set(ip, list)
    if (list.length >= MAX_ATTEMPTS) {
      this.blocked.set(ip, now + WINDOW_MS)
      this.attempts.delete(ip)
    }
    // The 5th wrong PIN still answers BAD_PIN; the 6th one is RATE_LIMITED.
    return list.length > MAX_ATTEMPTS
  }

  /** A correct PIN clears the counters for the IP. */
  recordSuccess(ip: string): void {
    this.attempts.delete(ip)
    this.blocked.delete(ip)
  }
}
