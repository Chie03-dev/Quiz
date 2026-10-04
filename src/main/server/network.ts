import os from 'node:os'

export interface LanAddress {
  ip: string
  /** Higher is a better match for a phone on the same Wi-Fi. */
  score: number
  iface: string
}

function scoreIp(ip: string): number {
  const parts = ip.split('.').map(Number)
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p))) return 0
  if (ip.startsWith('192.168.')) return 100 // home Wi-Fi, best case
  if (ip.startsWith('10.')) return 90
  const third = parts[2]
  if (third >= 16 && third <= 31) return 80
  if (ip.startsWith('169.254.')) return 0 // link-local, useless for phones
  return 10
}

/** All usable LAN IPv4 addresses, best match first. Loopback and link-local are skipped. */
export function listLanAddresses(): LanAddress[] {
  const out: LanAddress[] = []
  for (const [iface, infos] of Object.entries(os.networkInterfaces())) {
    for (const info of infos ?? []) {
      if (info.family !== 'IPv4' || info.internal) continue
      const score = scoreIp(info.address)
      if (score === 0) continue
      out.push({ ip: info.address, score, iface })
    }
  }
  return out.sort((a, b) => b.score - a.score)
}

export function bestLanIp(): string | null {
  return listLanAddresses()[0]?.ip ?? null
}
