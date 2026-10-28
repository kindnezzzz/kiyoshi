// Kiyoshi Live — trading loop. ALWAYS trades real money (no dry-run mode).
// Set PORT to serve /health /status /trades and the /convert endpoints.
//
// Safety: loss guard on leftovers, 0.3% slippage cap on Uniswap legs,
// verified counterparties, a single send path with attribution tag, clean shutdown.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { formatUnits, parseUnits } from 'viem'
import { ATTRIBUTION_TAG, AGENT_ID, CORRIDORS, TOKENS, type TokenKey } from './config.js'
import { account, pub, lastTxBlock } from './wallet.js'
import { balanceOf, swap as textileSwap } from './swap.js'
import { preview } from './textile.js'
import { uniQuote, uniSwap } from './uniswap.js'
import { convertStats, handleConvert } from './convert.js'
import { flowSummary, netDeposits, updateFlows } from './flows.js'

const MAX_TRADE_USD = Number(process.env.MAX_TRADE_USD ?? '20')
const MIN_EDGE_USD = Number(process.env.MIN_EDGE_USD ?? '0.01')
const INTERVAL_MS = Number(process.env.INTERVAL_SEC ?? '60') * 1000
const MAX_FLATTEN_LOSS_BPS = BigInt(process.env.MAX_FLATTEN_LOSS_BPS ?? '50') // 0.5%
const MAX_HOLD_MS = Number(process.env.MAX_HOLD_MIN ?? '30') * 60_000
const PORT = Number(process.env.PORT ?? 0)
const ONCE = process.env.ONCE === '1'
const SLIPPAGE_BPS = 30n // 0.3%
const CELO_GAS_RESERVE = parseUnits(process.env.CELO_GAS_RESERVE ?? '150', 18) // keep gas CELO untouched
const MIN_GAS_CELO = parseUnits('15', 18)
const DATA_DIR = process.env.DATA_DIR ?? '.'
const TRADES_FILE = DATA_DIR + '/trades.jsonl'
const STATE_FILE = DATA_DIR + '/state.json'

const usd = (v: bigint) => Number(formatUnits(v, 6))
const amt = (k: TokenKey, v: bigint) => Number(formatUnits(v, TOKENS[k].decimals))
const withSlippage = (v: bigint) => (v * (10_000n - SLIPPAGE_BPS)) / 10_000n
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// Inventory left by a half-finished cycle, with what it cost, so flatten() won't dump it at a big loss.
const pending = new Map<TokenKey, { costUsdt: bigint; since: number; amount?: bigint }>()
let holdingInventory = false

function tradeableBalance(X: TokenKey, rawBal: bigint): bigint {
  if (X !== 'CELO') return rawBal
  const safeMax = rawBal > MIN_GAS_CELO ? rawBal - MIN_GAS_CELO : 0n
  const p = pending.get('CELO')
  if (p?.amount) return p.amount < safeMax ? p.amount : safeMax
  return rawBal > CELO_GAS_RESERVE ? rawBal - CELO_GAS_RESERVE : 0n
}

// ---------- ledger ----------
type Entry = Record<string, any>
const fills: Entry[] = [] // cycles and flattens (no scans), served at /trades
if (existsSync(TRADES_FILE)) {
  for (const line of readFileSync(TRADES_FILE, 'utf8').split('\n')) {
    try { const e = JSON.parse(line); if (e.event === 'cycle' || e.event === 'flatten') fills.push(e) } catch {}
  }
}
function log(entry: Entry) {
  const line = JSON.stringify({ ts: new Date().toISOString(), live: true, ...entry }, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))
  appendFileSync(TRADES_FILE, line + '\n')
  const e = JSON.parse(line)
  if (e.event === 'cycle' || e.event === 'flatten') fills.push(e)
}

const status: Entry = {
  agent: { name: 'Kiyoshi Live', wallet: account.address, erc8004AgentId: AGENT_ID, attributionTag: ATTRIBUTION_TAG },
  live: true,
  startedAt: new Date().toISOString(),
  config: { maxTradeUsd: MAX_TRADE_USD, minEdgeUsd: MIN_EDGE_USD, intervalSec: INTERVAL_MS / 1000, maxFlattenLossBps: Number(MAX_FLATTEN_LOSS_BPS), maxHoldMin: MAX_HOLD_MS / 60_000 },
  lastScan: null, equity: null, baselineEquity: null, since: null, holding: false, lastError: null,
}
function summary() {
  const cycles = fills.filter((f) => f.event === 'cycle' && typeof f.pnl === 'number')
  return {
    ...status,
    pnl: status.equity !== null ? status.equity - status.baselineEquity : null,
    realizedPnl: cycles.reduce((s, f) => s + f.pnl, 0),
    completedCycles: cycles.length,
    textileFills: fills.filter((f) => typeof f.textileUsd === 'number').length,
    convert: convertStats,
    textileVolumeUsd: fills.reduce((s, f) => s + (typeof f.textileUsd === 'number' ? f.textileUsd : 0), 0),
  }
}

// ---------- market helpers ----------
async function texPreview(sell: TokenKey, buy: TokenKey, amount: bigint): Promise<bigint | null> {
  try {
    const p = await preview({ sellToken: TOKENS[sell].address, buyToken: TOKENS[buy].address, sellAmount: amount.toString() })
    return p.status === 'preview' ? BigInt(p.buyAmount) : null
  } catch { return null }
}

async function bestExit(X: TokenKey, amount: bigint) {
  const [u, t] = await Promise.all([uniQuote(X, 'USDT', amount), texPreview(X, 'USDT', amount)])
  if (u && (!t || u.out >= t)) return { venue: 'uniswap' as const, out: u.out, fee: u.fee }
  if (t) return { venue: 'textile' as const, out: t }
  return null
}

// Read every balance at ONE block that already includes our latest tx, so equity is a consistent snapshot.
async function snapshotBlock() {
  for (let i = 0; i < 20; i++) {
    const b = await pub.getBlockNumber({ cacheTime: 0 })
    if (b >= lastTxBlock) return b
    await sleep(1000)
  }
  throw new Error('RPC is lagging behind our last transaction; skipping equity read')
}
async function readAt(token: `0x${string}`, block: bigint) {
  for (let i = 0; ; i++) {
    try { return await balanceOf(token, block) } catch (e) { if (i >= 5) throw e; await sleep(1000) }
  }
}
async function equity() {
  const block = await snapshotBlock()
  let total = usd(await readAt(TOKENS.USDT.address, block))
  for (const X of CORRIDORS) {
    const bal = tradeableBalance(X, await readAt(TOKENS[X].address, block))
    if (bal === 0n) continue
    const exit = await bestExit(X, bal)
    if (exit) total += usd(exit.out)
  }
  return total
}

// Sell leftovers from a half-finished cycle, unless that would lose more than the guard allows.
// Returns true if it sold on Textile (so the next trade waits for Textile to settle).
async function flatten() {
  let soldOnTextile = false
  holdingInventory = false
  for (const X of CORRIDORS) {
    const bal = tradeableBalance(X, await balanceOf(TOKENS[X].address))
    if (bal === 0n) { pending.delete(X); continue }
    const exit = await bestExit(X, bal)
    if (!exit || usd(exit.out) < 1) continue // dust, or below Textile's $1 minimum

    const p = pending.get(X)
    if (p) {
      const floor = (p.costUsdt * (10_000n - MAX_FLATTEN_LOSS_BPS)) / 10_000n
      const age = Date.now() - p.since
      if (exit.out < floor && age < MAX_HOLD_MS) {
        console.log(`  holding ${amt(X, bal).toFixed(4)} ${X}: best exit $${usd(exit.out).toFixed(4)} vs cost $${usd(p.costUsdt).toFixed(4)}, waiting for a better price (${Math.round(age / 60_000)}/${MAX_HOLD_MS / 60_000} min)`)
        holdingInventory = true
        continue
      }
    }

    console.log(`  flatten: ${amt(X, bal).toFixed(4)} ${X} -> ~${usd(exit.out).toFixed(4)} USDT via ${exit.venue}`)
    if (exit.venue === 'uniswap') {
      const { hash: tx, out } = await uniSwap(X, 'USDT', bal, exit.fee!, withSlippage(exit.out))
      log({ event: 'flatten', X, venue: 'uniswap', amountIn: bal, tx, usdtOut: usd(out), costUsdt: p ? usd(p.costUsdt) : null })
      pending.delete(X)
    } else {
      const r = await textileSwap(X, 'USDT', bal, withSlippage(exit.out))
      const filled = r.status === 'filled'
      log({ event: 'flatten', X, venue: 'textile', amountIn: bal, result: r, costUsdt: p ? usd(p.costUsdt) : null, ...(filled ? { tx: r.txHash, usdtOut: usd(r.received), textileUsd: usd(r.received) } : {}) })
      if (filled) { soldOnTextile = true; pending.delete(X) } else holdingInventory = true
    }
  }
  status.holding = holdingInventory
  return soldOnTextile
}

type Opp = { X: TokenKey; route: 'uni->textile' | 'textile->uni'; size: bigint; mid: bigint; out: bigint; uniFee: number; edge: number }

async function scan(size: bigint): Promise<Opp[]> {
  const opps: Opp[] = []
  for (const X of CORRIDORS) {
    const a1 = await uniQuote('USDT', X, size)
    const a2 = a1 ? await texPreview(X, 'USDT', a1.out) : null
    if (a1 && a2) opps.push({ X, route: 'uni->textile', size, mid: a1.out, out: a2, uniFee: a1.fee, edge: usd(a2) - usd(size) })

    const b1 = await texPreview('USDT', X, size)
    const b2 = b1 ? await uniQuote(X, 'USDT', b1) : null
    if (b1 && b2) opps.push({ X, route: 'textile->uni', size, mid: b1, out: b2.out, uniFee: b2.fee, edge: usd(b2.out) - usd(size) })
  }
  return opps
}

async function execute(o: Opp): Promise<number | null> {
  const X = o.X
  if (o.route === 'uni->textile') {
    const { hash: tx1, out: got } = await uniSwap('USDT', X, o.size, o.uniFee, withSlippage(o.mid))
    // Sell on Textile only if the firm quote still breaks even; otherwise hold it for flatten().
    const r = await textileSwap(X, 'USDT', got, o.size)
    const filled = r.status === 'filled'
    const pnl = filled ? usd(r.received) - usd(o.size) : null
    if (!filled) pending.set(X, { costUsdt: o.size, since: Date.now(), amount: got })
    log({ event: 'cycle', X, route: o.route, sizeUsd: usd(o.size), tx1, leg2: r.status, ...(filled ? { tx2: r.txHash, textileUsd: usd(r.received) } : {}), pnl })
    return pnl
  }
  const r = await textileSwap('USDT', X, o.size, withSlippage(o.mid))
  if (r.status !== 'filled') { log({ event: 'cycle', X, route: o.route, sizeUsd: usd(o.size), leg1: r.status, pnl: null }); return null }
  const q = await uniQuote(X, 'USDT', r.received)
  if (!q) {
    pending.set(X, { costUsdt: o.size, since: Date.now(), amount: r.received })
    log({ event: 'cycle', X, route: o.route, sizeUsd: usd(o.size), tx1: r.txHash, textileUsd: usd(o.size), leg2: 'no_uniswap_quote', pnl: null })
    return null
  }
  const { hash: tx2, out } = await uniSwap(X, 'USDT', r.received, q.fee, withSlippage(q.out))
  const pnl = usd(out) - usd(o.size)
  log({ event: 'cycle', X, route: o.route, sizeUsd: usd(o.size), tx1: r.txHash, tx2, textileUsd: usd(o.size), pnl })
  return pnl
}

async function cycle() {
  if (await flatten()) {
    console.log('  sold leftovers on Textile; letting it settle before the next trade')
    return
  }
  if (holdingInventory) {
    console.log('  holding leftover inventory; no new trades until it is sold')
    return
  }
  const cash = await balanceOf(TOKENS.USDT.address)
  const cap = parseUnits(String(MAX_TRADE_USD), 6)
  const tradeSize = cash * 90n / 100n < cap ? cash * 90n / 100n : cap
  const scanSize = tradeSize >= parseUnits('2', 6) ? tradeSize : cap

  // Try a few sizes: bigger trades move Uniswap's price, so the best dollar profit is not always at max size.
  const sizes = [...new Set([scanSize, scanSize / 2n, scanSize / 4n])].filter((s) => s >= parseUnits('2', 6))
  const opps: Opp[] = []
  for (const s of sizes) opps.push(...(await scan(s)))
  opps.sort((a, b) => b.edge - a.edge)

  for (const o of opps.filter((o) => o.size === scanSize)) console.log(`  ${o.X.padEnd(5)} ${o.route.padEnd(13)} $${usd(o.size).toFixed(2)} -> $${usd(o.out).toFixed(4)}  edge ${o.edge >= 0 ? '+' : ''}${o.edge.toFixed(4)}`)
  status.lastScan = { at: new Date().toISOString(), maxSizeUsd: usd(scanSize), opps: opps.map((o) => ({ X: o.X, route: o.route, sizeUsd: usd(o.size), outUsd: usd(o.out), edge: o.edge })) }

  if (tradeSize < parseUnits('2', 6)) {
    console.log(`  not enough USDT to trade (have $${usd(cash).toFixed(2)})`)
    return
  }

  const best = opps[0]
  if (!best || best.edge < MIN_EDGE_USD) { console.log(`  no trade: best edge below $${MIN_EDGE_USD}`); return }
  console.log(`  >> TRADING: ${best.X} ${best.route} at $${usd(best.size).toFixed(2)}, expected +$${best.edge.toFixed(4)}`)
  const pnl = await execute(best)
  console.log(`  result: ${pnl === null ? 'incomplete (leftover held and managed by flatten)' : (pnl >= 0 ? '+' : '') + pnl.toFixed(4) + ' USDT'}`)
}

// ---------- web endpoint ----------
if (PORT) {
  createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end() }
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (url.pathname.startsWith('/convert/')) { handleConvert(req, res, url); return }
    const json = (body: unknown) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(body, null, 2)) }
    if (url.pathname === '/health') return res.end('ok')
    if (url.pathname === '/status') return json(summary())
    if (url.pathname === '/trades') {
      const n = Math.min(Number(url.searchParams.get('limit') ?? 100), 1000)
      return json(fills.slice(-n).reverse())
    }
    res.statusCode = 404
    res.end('not found')
  }).listen(PORT, () => console.log(`Serving /health /status /trades /convert on port ${PORT}`))
}

// ---------- baseline for P&L ----------
let state: { baselineEquity: number; since: string }
if (process.env.BASELINE_EQUITY) {
  state = { baselineEquity: Number(process.env.BASELINE_EQUITY), since: process.env.BASELINE_SINCE ?? new Date().toISOString() }
} else if (existsSync(STATE_FILE)) {
  state = JSON.parse(readFileSync(STATE_FILE, 'utf8'))
} else {
  state = { baselineEquity: await equity(), since: new Date().toISOString() }
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2))
}
if (!Number.isFinite(state.baselineEquity)) throw new Error('BASELINE_EQUITY is not a plain number (no $ or commas)')
status.baselineEquity = state.baselineEquity
status.since = state.since

// ---------- safe shutdown (Render redeploys run old and new copies side by side briefly) ----------
let stopping = false
let inCycle = false
process.on('SIGTERM', () => {
  stopping = true
  console.log('  SIGTERM received' + (inCycle ? '; finishing the current cycle first' : ''))
  if (!inCycle) process.exit(0)
})
const STARTUP_DELAY_MS = Number(process.env.STARTUP_DELAY_SEC ?? '60') * 1000
if (STARTUP_DELAY_MS > 0) {
  console.log('Waiting ' + STARTUP_DELAY_MS / 1000 + 's before trading so any previous copy can finish and shut down')
  await sleep(STARTUP_DELAY_MS)
}

// ---------- main loop ----------
console.log(`Kiyoshi LIVE | wallet ${account.address} | max trade $${MAX_TRADE_USD} | min edge $${MIN_EDGE_USD} | every ${INTERVAL_MS / 1000}s`)
while (true) {
  console.log(`\n[${new Date().toISOString()}]`)
  if (stopping) break
  inCycle = true
  try {
    await cycle()
    await updateFlows().catch((e: any) => console.error('  flows:', e.shortMessage ?? e.message))
    const net = netDeposits()
    if (Number.isFinite(net) && net > 0) { state.baselineEquity = net; status.baselineEquity = net }
    status.capital = flowSummary()
    const eq = await equity()
    status.equity = eq
    status.lastError = null
    console.log(`  equity $${eq.toFixed(4)}  P&L since ${state.since.slice(0, 10)}: ${eq - state.baselineEquity >= 0 ? '+' : ''}${(eq - state.baselineEquity).toFixed(4)}`)
    log({ event: 'equity', equity: eq, pnl: eq - state.baselineEquity })
  } catch (e: any) {
    const msg = e.shortMessage ?? e.message
    console.error('  error:', msg)
    status.lastError = { at: new Date().toISOString(), message: msg }
    log({ event: 'error', message: msg })
  }
  inCycle = false
  if (stopping) { console.log('  shutdown requested; exiting cleanly between cycles'); process.exit(0) }
  if (ONCE && !PORT) break
  await sleep(INTERVAL_MS)
}
