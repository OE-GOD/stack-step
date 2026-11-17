/**
 * Basic rate limiting for the tutor function.
 *
 * It counts requests in memory, with a sliding window, at three levels:
 * - one CLIENT (one browser tab): at most 8 per minute and 60 per hour;
 * - one NETWORK (one internet address; for IPv6 the /64 network of the address): at most
 *   60 per minute and 300 per hour. A classroom or a campus Wi-Fi often shares one public
 *   address, so the limit of one student must not be the limit of the whole room;
 * - all clients together: 600 per hour (per function instance).
 *
 * The page makes a random id once per page load and sends it with every question (see
 * tutorCore.ts), so a client is "this network + this id". A request without a valid id
 * (curl, a script) counts as its network, and then the client limits apply to the whole
 * address. A client that makes up a new id for every request gains nothing beyond the
 * network limits. The network limit per hour is half of the global one on purpose: one
 * network (or one such script) can never use up the hour of everybody else.
 *
 * Be honest about what this is: BEST EFFORT. A serverless platform runs several copies
 * ("instances") of a function and starts new ones at any time. The instances do not
 * share memory, so each one counts on its own, and a new instance starts at zero. This
 * stops one student (or one script) from sending hundreds of requests through a warm
 * instance. It does not put a hard limit on what the API key can spend. A production
 * deployment adds:
 * - the platform's own rate limiting, which counts across instances: the `rateLimit`
 *   setting in the `config` of the Netlify function (netlify/functions/tutor.ts), and on
 *   Vercel a Firewall rate-limit rule for `/api/tutor` (set up in the Vercel dashboard),
 *   or a shared store for these counters (for example Upstash Redis or Vercel KV); and
 * - a monthly spend limit in the Claude Console (https://platform.claude.com). Spend
 *   limits are set for a workspace or for the whole organization, not for one key, and the
 *   default workspace cannot have one: put the tutor's key in a workspace of its own.
 *
 * This file is pure: no timers, no globals. The clock is passed in.
 */

export interface RateLimitRules {
  /** Requests one client may make in any 60 seconds. */
  perMinute: number
  /** Requests one client may make in any 60 minutes. */
  perHour: number
  /** Requests all clients of one network may make together in any 60 seconds. */
  networkPerMinute: number
  /** Requests all clients of one network may make together in any 60 minutes. */
  networkPerHour: number
  /** Requests all clients together may make in any 60 minutes (per function instance). */
  globalPerHour: number
  /**
   * How many clients, and how many networks, are remembered. The ones that were quiet the
   * longest are dropped.
   */
  maxClients: number
}

export const DEFAULT_RATE_LIMIT_RULES: RateLimitRules = {
  perMinute: 8,
  perHour: 60,
  networkPerMinute: 60,
  // Half of globalPerHour: one network can never use up the hour of everybody else.
  networkPerHour: 300,
  globalPerHour: 600,
  maxClients: 5000,
}

export interface RateLimiterOptions extends Partial<RateLimitRules> {
  /** The clock, in milliseconds. Default: Date.now. */
  now?: () => number
}

/**
 * Who is asking: one client, and the network it is on. A plain string is a client that
 * is its own network (then the client limits, which are lower, always decide).
 */
export type RateLimitWho = string | { client: string; network: string }

/** Which limit said no. */
export type RateLimitScope =
  'client-minute' | 'client-hour' | 'network-minute' | 'network-hour' | 'global-hour'

export type RateLimitDecision =
  | { allowed: true }
  | {
      allowed: false
      scope: RateLimitScope
      /** Whole seconds until the same client may try again (at least 1). */
      retryAfterSeconds: number
    }

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS

/** A name is cut to this length, so a made-up header cannot fill the memory. */
const MAX_NAME_LENGTH = 128

/**
 * The times of the accepted requests of each name, oldest first.
 *
 * The map keeps its entries in the order of their newest request: a name is taken out and
 * put back at the end on every accepted request. So the first entry is always the name
 * that was quiet the longest.
 */
type Counters = Map<string, number[]>

export class RateLimiter {
  private readonly rules: RateLimitRules
  private readonly now: () => number
  private readonly clients: Counters = new Map()
  private readonly networks: Counters = new Map()
  /** The times of all accepted requests, oldest first, never more than `globalPerHour`. */
  private readonly all: number[] = []

  constructor(options: RateLimiterOptions = {}) {
    const { now, ...rules } = options
    this.rules = { ...DEFAULT_RATE_LIMIT_RULES, ...rules }
    this.now = now ?? Date.now
  }

  /**
   * Ask if `who` may make a request at time `at` (milliseconds; default: the clock).
   * An allowed request is counted. A refused request is not counted, so a client that
   * keeps trying is not locked out for longer.
   */
  check(who: RateLimitWho, at: number = this.now()): RateLimitDecision {
    const decision = this.peek(who, at)
    if (decision.allowed) this.record(who, at)
    return decision
  }

  /**
   * The same question as `check`, but nothing is counted. The function asks this before
   * it reads a request, and counts the request only once it has passed every check.
   */
  peek(who: RateLimitWho, at: number = this.now()): RateLimitDecision {
    const { client, network } = namesOf(who)
    const hourAgo = at - HOUR_MS
    this.forgetBefore(hourAgo)
    const clientHits = timesOf(this.clients, client, hourAgo)
    const networkHits = timesOf(this.networks, network, hourAgo)

    // Every limit that is reached, with the moment it has room again.
    const blocks: { scope: RateLimitScope; freeAt: number }[] = []
    const perMinute = (scope: RateLimitScope, hits: readonly number[], limit: number): void => {
      const recent = hits.filter((time) => time > at - MINUTE_MS)
      if (recent.length >= limit) blocks.push({ scope, freeAt: first(recent) + MINUTE_MS })
    }
    const perHour = (scope: RateLimitScope, hits: readonly number[], limit: number): void => {
      if (hits.length >= limit) blocks.push({ scope, freeAt: first(hits) + HOUR_MS })
    }
    perMinute('client-minute', clientHits, this.rules.perMinute)
    perHour('client-hour', clientHits, this.rules.perHour)
    perMinute('network-minute', networkHits, this.rules.networkPerMinute)
    perHour('network-hour', networkHits, this.rules.networkPerHour)
    perHour('global-hour', this.all, this.rules.globalPerHour)

    if (blocks.length === 0) return { allowed: true }
    // The client has to wait for the limit that gets room last.
    const longest = blocks.reduce((worst, block) => (block.freeAt > worst.freeAt ? block : worst))
    return {
      allowed: false,
      scope: longest.scope,
      retryAfterSeconds: Math.max(1, Math.ceil((longest.freeAt - at) / 1000)),
    }
  }

  /** How many clients are remembered right now. */
  get trackedClients(): number {
    return this.clients.size
  }

  /** How many networks are remembered right now. */
  get trackedNetworks(): number {
    return this.networks.size
  }

  /** Count one request (after `peek` said yes). */
  private record(who: RateLimitWho, at: number): void {
    const { client, network } = namesOf(who)
    this.all.push(at)
    for (const [counters, name] of [
      [this.clients, client],
      [this.networks, network],
    ] as const) {
      const hits = counters.get(name) ?? []
      hits.push(at)
      // Take the name out and put it back, so it moves to the end of the map.
      counters.delete(name)
      counters.set(name, hits)
      while (counters.size > this.rules.maxClients) {
        const quietest = counters.keys().next()
        if (quietest.done === true) break
        counters.delete(quietest.value)
      }
    }
  }

  /** Drop the global times, and the names that have nothing newer than `time`. */
  private forgetBefore(time: number): void {
    dropUpTo(this.all, time)
    for (const counters of [this.clients, this.networks]) {
      // The map is in the order of the newest request, so the names with nothing left are
      // all at the front. Stop at the first name that still has a newer request.
      for (const [name, hits] of counters) {
        if (last(hits) > time) break
        counters.delete(name)
      }
    }
  }
}

function namesOf(who: RateLimitWho): { client: string; network: string } {
  const { client, network } = typeof who === 'string' ? { client: who, network: who } : who
  return { client: client.slice(0, MAX_NAME_LENGTH), network: network.slice(0, MAX_NAME_LENGTH) }
}

/** The times of `name` that are newer than `hourAgo` (an empty list for a new name). */
function timesOf(counters: Counters, name: string, hourAgo: number): number[] {
  const hits = counters.get(name)
  if (hits === undefined) return []
  dropUpTo(hits, hourAgo)
  return hits
}

/** The first number of a list (0 for an empty list, which the callers never pass). */
function first(times: readonly number[]): number {
  return times[0] ?? 0
}

function last(times: readonly number[]): number {
  return times[times.length - 1] ?? Number.NEGATIVE_INFINITY
}

/** Remove the times at the start of the list that are not after `time`. */
function dropUpTo(times: number[], time: number): void {
  let keepFrom = 0
  while (keepFrom < times.length && (times[keepFrom] ?? 0) <= time) keepFrom += 1
  if (keepFrom > 0) times.splice(0, keepFrom)
}

/**
 * The address of the client, from the headers that hosting platforms set: the first
 * address of `x-forwarded-for`, else `x-nf-client-connection-ip` (Netlify), else
 * `x-real-ip`, else the word 'unknown' (all such clients then share one counter).
 *
 * Vercel overwrites `x-forwarded-for`, so a client cannot make it up there. Where a
 * platform hands the function a trusted address in another way (Netlify: `context.ip`),
 * the wrapper passes that address in and this function is not used.
 */
export function clientIpFromHeaders(headers: Headers): string {
  const candidates = [
    headers.get('x-forwarded-for')?.split(',')[0],
    headers.get('x-nf-client-connection-ip'),
    headers.get('x-real-ip'),
  ]
  for (const candidate of candidates) {
    const address = candidate?.trim().toLowerCase()
    if (address !== undefined && address !== '') return address
  }
  return 'unknown'
}

/** The longest name `networkOf` returns for text that is not an address. */
const MAX_NETWORK_LENGTH = 64

/**
 * The network of an address: what the limiter counts as one network.
 *
 * - IPv4 (also written as IPv6, `::ffff:192.0.2.7`, or with a port): the address itself.
 * - IPv6: its /64 network, for example `2001:0db8:0001:0002::/64`. One home, one phone or
 *   one server usually controls a whole /64 (2^64 addresses), so counting single IPv6
 *   addresses would let one client use as many counters as it likes.
 * - Anything else (a made-up header, 'unknown'): the text itself, cut to 64 characters.
 */
export function networkOf(address: string): string {
  let text = address.trim().toLowerCase()
  // `[2001:db8::1]:443` and `203.0.113.7:51234`: drop the brackets and the port.
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(text)
  if (bracketed !== null) text = bracketed[1] ?? text
  else if (/^\d{1,3}(?:\.\d{1,3}){3}:\d+$/.test(text)) text = text.slice(0, text.lastIndexOf(':'))
  // A zone (`fe80::1%eth0`) names a network card of the server, not the client.
  text = text.replace(/%.*$/, '')

  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(text)
  if (mapped !== null) return mapped[1] ?? text
  if (!text.includes(':') || !/^[0-9a-f:.]+$/.test(text)) return text.slice(0, MAX_NETWORK_LENGTH)

  // Write out the groups that `::` leaves out, then keep the first four (64 bits).
  const [head = '', tail = ''] = text.split('::', 2)
  const groupsOf = (part: string): string[] => (part === '' ? [] : part.split(':'))
  const left = groupsOf(head)
  const right = groupsOf(tail)
  // An IPv4 address at the end (`64:ff9b::192.0.2.33`) fills two groups.
  const width = (groups: string[]): number =>
    groups.length + (groups[groups.length - 1]?.includes('.') === true ? 1 : 0)
  const missing = Math.max(0, 8 - width(left) - width(right))
  const groups = [...left, ...Array.from({ length: missing }, () => '0'), ...right]
  const prefix = groups.slice(0, 4).map((group) => group.padStart(4, '0'))
  return `${prefix.join(':')}::/64`
}
