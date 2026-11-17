import { describe, expect, it } from 'vitest'
import {
  DEFAULT_RATE_LIMIT_RULES,
  RateLimiter,
  clientIpFromHeaders,
  networkOf,
  type RateLimitDecision,
  type RateLimitWho,
} from './rateLimit.js'

const SECOND = 1000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE

/** A start time that is not zero, so mistakes with "time 0" show up. */
const START = 1_700_000_000_000

function refusal(decision: RateLimitDecision): Extract<RateLimitDecision, { allowed: false }> {
  if (decision.allowed) throw new Error('Expected the request to be refused.')
  return decision
}

/** Make `count` requests, `gap` milliseconds apart, and return the decisions. */
function burst(
  limiter: RateLimiter,
  client: RateLimitWho,
  count: number,
  from: number,
  gap = 0,
): RateLimitDecision[] {
  return Array.from({ length: count }, (_, index) => limiter.check(client, from + index * gap))
}

/** Client `name` of network `network`, as the function names them. */
function browser(network: string, name: string): RateLimitWho {
  return { client: `${network}|${name}`, network }
}

describe('the default rules', () => {
  it('are 8 a minute and 60 an hour per client, 60 and 300 per network, 600 for everybody', () => {
    expect(DEFAULT_RATE_LIMIT_RULES).toEqual({
      perMinute: 8,
      perHour: 60,
      networkPerMinute: 60,
      networkPerHour: 300,
      globalPerHour: 600,
      maxClients: 5000,
    })
  })

  it('let no single network use up the hour of everybody', () => {
    expect(DEFAULT_RATE_LIMIT_RULES.networkPerHour).toBeLessThanOrEqual(
      DEFAULT_RATE_LIMIT_RULES.globalPerHour / 2,
    )
  })
})

describe('the limit per minute', () => {
  it('allows 8 requests in one minute and refuses the 9th', () => {
    const limiter = new RateLimiter()
    const decisions = burst(limiter, '10.0.0.1', 9, START, SECOND)
    expect(decisions.slice(0, 8).every((decision) => decision.allowed)).toBe(true)
    expect(decisions[8]).toEqual({
      allowed: false,
      scope: 'client-minute',
      // The first request was at START. The 9th comes 8 s later, so 52 s are left.
      retryAfterSeconds: 52,
    })
  })

  it('has room again exactly when the oldest request is one minute old', () => {
    const limiter = new RateLimiter()
    burst(limiter, '10.0.0.1', 8, START, SECOND)
    expect(limiter.check('10.0.0.1', START + MINUTE - 1).allowed).toBe(false)
    expect(limiter.check('10.0.0.1', START + MINUTE).allowed).toBe(true)
    // That request took the place of the one from START. The next place opens 1 s later.
    expect(refusal(limiter.check('10.0.0.1', START + MINUTE)).retryAfterSeconds).toBe(1)
    expect(limiter.check('10.0.0.1', START + MINUTE + SECOND).allowed).toBe(true)
  })

  it('slides: 8 requests spread over two clock minutes are still 8 in 60 seconds', () => {
    const limiter = new RateLimiter()
    // 4 at the end of one clock minute and 4 at the start of the next one.
    burst(limiter, '10.0.0.1', 4, START + 55 * SECOND, SECOND)
    burst(limiter, '10.0.0.1', 4, START + 61 * SECOND, SECOND)
    expect(limiter.check('10.0.0.1', START + 70 * SECOND).allowed).toBe(false)
  })

  it('does not count a refused request', () => {
    const limiter = new RateLimiter()
    burst(limiter, '10.0.0.1', 8, START)
    // A client that keeps asking while it is refused…
    for (let second = 1; second < 60; second += 1) {
      expect(limiter.check('10.0.0.1', START + second * SECOND).allowed).toBe(false)
    }
    // …is still let in again after one minute.
    expect(limiter.check('10.0.0.1', START + MINUTE).allowed).toBe(true)
  })

  it('rounds the wait up to whole seconds and never says 0', () => {
    const limiter = new RateLimiter()
    burst(limiter, '10.0.0.1', 8, START)
    expect(refusal(limiter.check('10.0.0.1', START + 1)).retryAfterSeconds).toBe(60)
    expect(refusal(limiter.check('10.0.0.1', START + 59_001)).retryAfterSeconds).toBe(1)
    expect(refusal(limiter.check('10.0.0.1', START + 59_999)).retryAfterSeconds).toBe(1)
  })
})

describe('the limit per hour', () => {
  it('allows 60 requests in one hour and refuses the 61st', () => {
    const limiter = new RateLimiter()
    // One request per minute never touches the per-minute limit.
    const decisions = burst(limiter, '10.0.0.1', 60, START, MINUTE)
    expect(decisions.every((decision) => decision.allowed)).toBe(true)

    const at = START + 59 * MINUTE + 30 * SECOND
    expect(limiter.check('10.0.0.1', at)).toEqual({
      allowed: false,
      scope: 'client-hour',
      // The oldest request (START) leaves the window 30 s later.
      retryAfterSeconds: 30,
    })
    expect(limiter.check('10.0.0.1', START + HOUR).allowed).toBe(true)
  })

  it('reports the longer wait when both limits are reached', () => {
    const limiter = new RateLimiter()
    // 52 requests early in the hour, then 8 in one burst: 60 in the hour, 8 in the minute.
    burst(limiter, '10.0.0.1', 52, START, 10 * SECOND)
    const late = START + 50 * MINUTE
    burst(limiter, '10.0.0.1', 8, late)
    expect(limiter.check('10.0.0.1', late + SECOND)).toEqual({
      allowed: false,
      scope: 'client-hour',
      retryAfterSeconds: 10 * 60 - 1,
    })
  })
})

describe('clients are counted apart', () => {
  it('lets a second client in while the first one is refused', () => {
    const limiter = new RateLimiter()
    burst(limiter, '10.0.0.1', 8, START)
    expect(limiter.check('10.0.0.1', START + 1).allowed).toBe(false)
    expect(limiter.check('10.0.0.2', START + 1).allowed).toBe(true)
    expect(limiter.check('2001:db8::1', START + 1).allowed).toBe(true)
  })

  it('keeps separate limiters apart (each function instance has its own)', () => {
    const one = new RateLimiter()
    const two = new RateLimiter()
    burst(one, '10.0.0.1', 8, START)
    expect(one.check('10.0.0.1', START).allowed).toBe(false)
    expect(two.check('10.0.0.1', START).allowed).toBe(true)
  })
})

describe('the clients of one network (a classroom behind one address)', () => {
  it('each get their own 8 a minute', () => {
    const limiter = new RateLimiter()
    burst(limiter, browser('198.51.100.40', 'a'), 8, START)
    expect(refusal(limiter.check(browser('198.51.100.40', 'a'), START + 1)).scope).toBe(
      'client-minute',
    )
    expect(limiter.check(browser('198.51.100.40', 'b'), START + 1).allowed).toBe(true)
  })

  it('share 60 a minute between them', () => {
    const limiter = new RateLimiter()
    for (let student = 0; student < 30; student += 1) {
      const decisions = burst(limiter, browser('198.51.100.40', `s${student}`), 2, START + student)
      expect(decisions.every((decision) => decision.allowed)).toBe(true)
    }
    expect(limiter.check(browser('198.51.100.40', 'late'), START + 10 * SECOND)).toEqual({
      allowed: false,
      scope: 'network-minute',
      retryAfterSeconds: 50,
    })
    // Another network is not affected.
    expect(limiter.check(browser('203.0.113.7', 'late'), START + 10 * SECOND).allowed).toBe(true)
  })

  it('share 300 an hour between them', () => {
    const limiter = new RateLimiter({ networkPerHour: 5, globalPerHour: 1000 })
    for (let student = 0; student < 5; student += 1) {
      expect(limiter.check(browser('n', `s${student}`), START + student * MINUTE).allowed).toBe(
        true,
      )
    }
    expect(limiter.check(browser('n', 'next'), START + 30 * MINUTE)).toEqual({
      allowed: false,
      scope: 'network-hour',
      retryAfterSeconds: 30 * 60,
    })
    expect(DEFAULT_RATE_LIMIT_RULES.networkPerHour).toBe(300)
  })

  it('cannot use up the hour of another network, even with a new client name every time', () => {
    // A script on one address asks once a second and makes up a new page id each time
    // (easy with curl). Measured before the fix: all 600 places of the hour went to it in
    // ten minutes, and a student on another address was then told to wait 40 minutes.
    const limiter = new RateLimiter()
    let scriptAllowed = 0
    for (let second = 0; second < 20 * 60; second += 1) {
      const decision = limiter.check(
        browser('203.0.113.66', `id-${second}`),
        START + second * SECOND,
      )
      if (decision.allowed) scriptAllowed += 1
    }
    expect(scriptAllowed).toBe(DEFAULT_RATE_LIMIT_RULES.networkPerHour)
    // The script is now refused for its network, not for everybody…
    expect(refusal(limiter.check(browser('203.0.113.66', 'id-x'), START + 20 * MINUTE)).scope).toBe(
      'network-hour',
    )
    // …and a student on another address still gets in.
    expect(limiter.check(browser('198.51.100.40', 'student'), START + 20 * MINUTE)).toEqual({
      allowed: true,
    })
  })

  it('needs two whole networks to fill the hour of everybody', () => {
    const limiter = new RateLimiter()
    // Two networks, each with 300 requests in 50 minutes (one every 10 s, a new id each time).
    for (let index = 0; index < 300; index += 1) {
      for (const network of ['a', 'b']) {
        const decision = limiter.check(browser(network, `id-${index}`), START + index * 10 * SECOND)
        expect(decision.allowed).toBe(true)
      }
    }
    expect(refusal(limiter.check(browser('c', 'student'), START + 55 * MINUTE)).scope).toBe(
      'global-hour',
    )
  })

  it('do not lose their own room to a request that the network limit refused', () => {
    const limiter = new RateLimiter({ perMinute: 3, networkPerMinute: 3 })
    burst(limiter, browser('n', 'a'), 3, START)
    // 'b' is refused three times because the network is full…
    for (let tries = 0; tries < 3; tries += 1) {
      expect(refusal(limiter.check(browser('n', 'b'), START + 1)).scope).toBe('network-minute')
    }
    // …and still has all 3 of its own when the network has room again. (Had the refused
    // requests been counted for 'b', it would have to wait until START + 1 minute + 1 ms.)
    const later = burst(limiter, browser('n', 'b'), 3, START + MINUTE)
    expect(later.every((decision) => decision.allowed)).toBe(true)
  })

  it('cannot get past the network limit with made-up client names', () => {
    const limiter = new RateLimiter()
    let allowed = 0
    for (let index = 0; index < 500; index += 1) {
      if (limiter.check(browser('198.51.100.40', `fake-${index}`), START + index).allowed) {
        allowed += 1
      }
    }
    expect(allowed).toBe(60)
  })

  it('a plain name is a client that is its own network: the client limits decide', () => {
    const limiter = new RateLimiter()
    expect(burst(limiter, '10.0.0.1', 9, START).filter((d) => d.allowed)).toHaveLength(8)
    expect(refusal(limiter.check('10.0.0.1', START)).scope).toBe('client-minute')
  })
})

describe('peek', () => {
  it('gives the same answer as check, and counts nothing', () => {
    const limiter = new RateLimiter({ perMinute: 2 })
    for (let tries = 0; tries < 10; tries += 1) {
      expect(limiter.peek('a', START)).toEqual({ allowed: true })
    }
    expect(limiter.trackedClients).toBe(0)
    burst(limiter, 'a', 2, START)
    expect(limiter.peek('a', START + SECOND)).toEqual(limiter.check('a', START + SECOND))
    expect(refusal(limiter.peek('a', START + SECOND)).retryAfterSeconds).toBe(59)
  })
})

describe('the ceiling for everybody', () => {
  it('refuses the 601st request of an hour, whoever sends it', () => {
    const limiter = new RateLimiter()
    // 100 clients, 6 requests each, all in the first minutes of the hour.
    for (let client = 0; client < 100; client += 1) {
      const decisions = burst(limiter, `10.0.${client}.1`, 6, START + client * SECOND, 100)
      expect(decisions.every((decision) => decision.allowed)).toBe(true)
    }
    const at = START + 10 * MINUTE
    expect(limiter.check('10.9.9.9', at)).toEqual({
      allowed: false,
      scope: 'global-hour',
      retryAfterSeconds: 50 * 60,
    })
    // Also a client that has made no request yet is not remembered when it is refused.
    expect(limiter.trackedClients).toBe(100)
    // One place opens when the very first request is one hour old.
    expect(limiter.check('10.9.9.9', START + HOUR).allowed).toBe(true)
    expect(limiter.check('10.9.9.8', START + HOUR).allowed).toBe(false)
  })

  it('uses the rules it is given', () => {
    const limiter = new RateLimiter({ perMinute: 2, perHour: 3, globalPerHour: 4 })
    expect(burst(limiter, 'a', 3, START).map((decision) => decision.allowed)).toEqual([
      true,
      true,
      false,
    ])
    expect(limiter.check('a', START + MINUTE).allowed).toBe(true)
    expect(refusal(limiter.check('a', START + 2 * MINUTE)).scope).toBe('client-hour')
    expect(limiter.check('b', START + 2 * MINUTE).allowed).toBe(true)
    expect(refusal(limiter.check('c', START + 2 * MINUTE)).scope).toBe('global-hour')
  })
})

describe('memory stays small', () => {
  it('forgets a client one hour after its last request', () => {
    const limiter = new RateLimiter()
    limiter.check('10.0.0.1', START)
    limiter.check('10.0.0.2', START + 10 * MINUTE)
    expect(limiter.trackedClients).toBe(2)

    limiter.check('10.0.0.3', START + HOUR)
    expect(limiter.trackedClients).toBe(2) // .1 is gone, .2 and .3 are kept

    limiter.check('10.0.0.3', START + HOUR + 10 * MINUTE)
    expect(limiter.trackedClients).toBe(1)
  })

  it('remembers at most `maxClients` clients and drops the quietest first', () => {
    const limiter = new RateLimiter({ maxClients: 3, globalPerHour: 1000 })
    limiter.check('a', START)
    limiter.check('b', START + 1)
    limiter.check('c', START + 2)
    limiter.check('a', START + 3) // 'a' is now the newest, 'b' the quietest
    limiter.check('d', START + 4)
    expect(limiter.trackedClients).toBe(3)

    // 'b' was dropped, so it starts from zero. 'a' was kept, so its two requests count.
    const strict = new RateLimiter({ maxClients: 3, perMinute: 2, globalPerHour: 1000 })
    strict.check('a', START)
    strict.check('b', START + 1)
    strict.check('b', START + 2)
    strict.check('c', START + 3)
    strict.check('a', START + 4)
    strict.check('d', START + 5) // drops 'b', the quietest
    expect(strict.check('a', START + 6).allowed).toBe(false)
    expect(strict.check('b', START + 7).allowed).toBe(true)
  })

  it('stays within the cap under a flood of new addresses', () => {
    const limiter = new RateLimiter({ maxClients: 50, globalPerHour: 100_000 })
    for (let index = 0; index < 5000; index += 1) {
      limiter.check(`10.${Math.floor(index / 250)}.${index % 250}.1`, START + index)
    }
    expect(limiter.trackedClients).toBe(50)
    expect(limiter.trackedNetworks).toBe(50)
  })

  it('stays within the cap under a flood of made-up client names in many networks', () => {
    const limiter = new RateLimiter({
      maxClients: 40,
      globalPerHour: 100_000,
      networkPerMinute: 100_000,
    })
    for (let index = 0; index < 3000; index += 1) {
      limiter.check(browser(`10.0.${index % 300}.1`, `fake-${index}`), START + index)
    }
    expect(limiter.trackedClients).toBe(40)
    expect(limiter.trackedNetworks).toBe(40)
  })

  it('forgets a network one hour after its last request', () => {
    const limiter = new RateLimiter()
    limiter.check(browser('n1', 'a'), START)
    limiter.check(browser('n2', 'b'), START + 10 * MINUTE)
    expect(limiter.trackedNetworks).toBe(2)
    limiter.check(browser('n3', 'c'), START + HOUR)
    expect(limiter.trackedNetworks).toBe(2)
  })

  it('cuts a very long name, so a made-up header cannot fill the memory', () => {
    const limiter = new RateLimiter({ perMinute: 1 })
    const long = 'x'.repeat(10_000)
    expect(limiter.check(`${long}-one`, START).allowed).toBe(true)
    // The same first 128 characters: the same client.
    expect(limiter.check(`${long}-two`, START).allowed).toBe(false)
  })

  it('never keeps more times than the limits allow', () => {
    const limiter = new RateLimiter()
    let allowed = 0
    // One client asks every second for three hours.
    for (let second = 0; second < 3 * 3600; second += 1) {
      if (limiter.check('10.0.0.1', START + second * SECOND).allowed) allowed += 1
    }
    // 60 per hour: the hourly limit is the one that holds.
    expect(allowed).toBe(180)
    expect(limiter.trackedClients).toBe(1)
  })
})

describe('the clock', () => {
  it('uses the injected clock when no time is passed', () => {
    let time = START
    const limiter = new RateLimiter({ perMinute: 1, now: () => time })
    expect(limiter.check('a').allowed).toBe(true)
    expect(limiter.check('a').allowed).toBe(false)
    time += MINUTE
    expect(limiter.check('a').allowed).toBe(true)
  })

  it('uses Date.now by default', () => {
    const limiter = new RateLimiter({ perMinute: 1 })
    expect(limiter.check('a').allowed).toBe(true)
    expect(refusal(limiter.check('a')).retryAfterSeconds).toBe(60)
  })
})

describe('clientIpFromHeaders', () => {
  it('takes the first address of x-forwarded-for', () => {
    const headers = new Headers({ 'x-forwarded-for': '203.0.113.7, 70.41.3.18, 150.172.238.178' })
    expect(clientIpFromHeaders(headers)).toBe('203.0.113.7')
  })

  it('prefers x-forwarded-for, then the Netlify header, then x-real-ip', () => {
    expect(
      clientIpFromHeaders(
        new Headers({
          'x-forwarded-for': '203.0.113.7',
          'x-nf-client-connection-ip': '198.51.100.2',
          'x-real-ip': '192.0.2.9',
        }),
      ),
    ).toBe('203.0.113.7')
    expect(
      clientIpFromHeaders(
        new Headers({ 'x-nf-client-connection-ip': '198.51.100.2', 'x-real-ip': '192.0.2.9' }),
      ),
    ).toBe('198.51.100.2')
    expect(clientIpFromHeaders(new Headers({ 'x-real-ip': '192.0.2.9' }))).toBe('192.0.2.9')
  })

  it("says 'unknown' when no header has an address", () => {
    expect(clientIpFromHeaders(new Headers())).toBe('unknown')
    expect(clientIpFromHeaders(new Headers({ 'x-forwarded-for': '  ,  ' }))).toBe('unknown')
    expect(clientIpFromHeaders(new Headers({ 'x-forwarded-for': '', 'x-real-ip': ' ' }))).toBe(
      'unknown',
    )
  })

  it('skips an empty header and uses the next one', () => {
    const headers = new Headers({ 'x-forwarded-for': ' ', 'x-real-ip': '192.0.2.9' })
    expect(clientIpFromHeaders(headers)).toBe('192.0.2.9')
  })

  it('trims spaces and lower-cases, so one IPv6 address is one client', () => {
    expect(
      clientIpFromHeaders(new Headers({ 'x-forwarded-for': ' 2001:DB8::A1 , 10.0.0.1' })),
    ).toBe('2001:db8::a1')
  })
})

describe('networkOf', () => {
  it('counts an IPv4 address on its own', () => {
    expect(networkOf('203.0.113.7')).toBe('203.0.113.7')
    expect(networkOf(' 203.0.113.7 ')).toBe('203.0.113.7')
    // With a port, or written as IPv6 (Node does that for IPv4 clients of a dual-stack server).
    expect(networkOf('203.0.113.7:51234')).toBe('203.0.113.7')
    expect(networkOf('::ffff:1.2.3.4')).toBe('1.2.3.4')
    expect(networkOf('::FFFF:1.2.3.4')).toBe('1.2.3.4')
  })

  it('counts an IPv6 address by its /64 network, however it is written', () => {
    const network = '2001:0db8:0001:0002::/64'
    for (const address of [
      '2001:db8:1:2::1',
      '2001:db8:1:2:ffff::9',
      '2001:DB8:1:2::A1',
      '2001:0db8:0001:0002:0000:0000:0000:0001',
      '2001:db8:1:2:3:4:5:6',
      '[2001:db8:1:2::1]:443',
      '[2001:db8:1:2::1]',
      '2001:db8:1:2::1%eth0',
    ]) {
      expect(networkOf(address), address).toBe(network)
    }
    expect(networkOf('2001:db8:1:3::1')).toBe('2001:0db8:0001:0003::/64')
    expect(networkOf('2001:db8::1')).toBe('2001:0db8:0000:0000::/64')
    expect(networkOf('::1')).toBe('0000:0000:0000:0000::/64')
    expect(networkOf('fe80::1:2:3:4')).toBe('fe80:0000:0000:0000::/64')
  })

  it('counts an IPv4 address at the end of an IPv6 address as two groups', () => {
    expect(networkOf('64:ff9b::192.0.2.33')).toBe('0064:ff9b:0000:0000::/64')
    expect(networkOf('1:2::3:4:5:192.0.2.33')).toBe('0001:0002:0000:0003::/64')
  })

  it('leaves text that is no address as it is, cut to 64 characters', () => {
    expect(networkOf('unknown')).toBe('unknown')
    expect(networkOf('Not an address!')).toBe('not an address!')
    expect(networkOf('x'.repeat(500))).toHaveLength(64)
  })
})
