// Kiyoshi Convert: best-rate USDT <-> local stablecoin swaps for end users, non-custodial.
// GET  /convert/quote?from=USDT&to=wBRL&amount=10
// POST /convert/build  { from, to, amount, wallet, venue: 'uniswap'|'textile', takerProof? }
// Every transaction returned carries Kiyoshi's ERC-8021 attribution tag.
import crypto from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { concat, encodeFunctionData, erc20Abi, formatUnits, isAddress, parseAbi, parseUnits, toHex, type Address, type Hex } from 'viem'
import { pub, TAG_SUFFIX } from './wallet.js'
import { CHAIN_ID, CORRIDORS, TEXTILE_API, TEXTILE_REACTOR, TOKENS, UNI, type TokenKey } from './config.js'
import { preview } from './textile.js'
import { uniQuote } from './uniswap.js'

const USER_SLIPPAGE_BPS = 50n // 0.5% protection on the Uniswap route
const MAX_CONVERT_USD = Number(process.env.MAX_CONVERT_USD ?? '500')
const routerAbi = parseAbi([
  'function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) payable returns (uint256 amountOut)',
])

export const convertStats = { quotes: 0, builds: 0 }

const tag = (data: Hex) => concat([data, TAG_SUFFIX])
const fmt = (k: TokenKey, v: bigint) => formatUnits(v, TOKENS[k].decimals)

function token(sym: string | null): TokenKey {
  const k = (Object.keys(TOKENS) as TokenKey[]).find((t) => t.toLowerCase() === String(sym ?? '').toLowerCase())
  if (!k) throw new Error(`Unknown token ${sym}`)
  return k
}
function pair(fromSym: string | null, toSym: string | null) {
  const from = token(fromSym), to = token(toSym)
  const ok = (from === 'USDT' && CORRIDORS.includes(to)) || (to === 'USDT' && CORRIDORS.includes(from))
  if (!ok) throw new Error(`Supported pairs: USDT <-> ${CORRIDORS.join(', ')}`)
  return { from, to }
}
function amountIn(from: TokenKey, amount: string) {
  if (!/^\d+(\.\d+)?$/.test(String(amount))) throw new Error('amount must be a positive number')
  const v = parseUnits(String(amount), TOKENS[from].decimals)
  if (v <= 0n) throw new Error('amount must be positive')
  if (from === 'USDT' && Number(amount) > MAX_CONVERT_USD) throw new Error(`Max ${MAX_CONVERT_USD} USDT per conversion`)
  return v
}

async function textilePreview(from: TokenKey, to: TokenKey, amt: bigint) {
  try {
    const p = await preview({ sellToken: TOKENS[from].address, buyToken: TOKENS[to].address, sellAmount: amt.toString() })
    return p.status === 'preview' ? BigInt(p.buyAmount) : null
  } catch { return null }
}

export async function quote(fromSym: string | null, toSym: string | null, amount: string) {
  const { from, to } = pair(fromSym, toSym)
  const amt = amountIn(from, amount)
  const [u, t] = await Promise.all([uniQuote(from, to, amt), textilePreview(from, to, amt)])
  const uOut = u?.out ?? null
  let best: 'uniswap' | 'textile' | null = null
  if (uOut !== null && (t === null || uOut >= t)) best = 'uniswap'
  else if (t !== null) best = 'textile'
  const bestOut = best === 'uniswap' ? uOut! : best === 'textile' ? t! : null
  const otherOut = best === 'uniswap' ? t : best === 'textile' ? uOut : null
  convertStats.quotes++
  return {
    from, to, amountIn: amount,
    uniswap: uOut !== null ? { out: fmt(to, uOut), feeTier: u!.fee } : null,
    textile: t !== null ? { out: fmt(to, t) } : null,
    best,
    bestOut: bestOut !== null ? fmt(to, bestOut) : null,
    advantage: bestOut !== null && otherOut !== null && otherOut > 0n
      ? { amount: fmt(to, bestOut - otherOut), pct: Number(((bestOut - otherOut) * 1_000_000n) / otherOut) / 10_000 }
      : null,
  }
}

type Step = { kind: 'approve' | 'swap'; label: string; to: Address; data: Hex; value: '0' }

async function approvalSteps(k: TokenKey, owner: Address, spender: Address, amount: bigint): Promise<Step[]> {
  const allowance = await pub.readContract({ address: TOKENS[k].address, abi: erc20Abi, functionName: 'allowance', args: [owner, spender] })
  if (allowance >= amount) return []
  const approve = (v: bigint) => tag(encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [spender, v] }))
  const steps: Step[] = []
  if (allowance > 0n) steps.push({ kind: 'approve', label: `Reset ${k} allowance`, to: TOKENS[k].address, data: approve(0n), value: '0' })
  steps.push({ kind: 'approve', label: `Approve ${fmt(k, amount)} ${k}`, to: TOKENS[k].address, data: approve(amount), value: '0' })
  return steps
}

async function textileRequest(body: Record<string, unknown>) {
  const res = await fetch(`${TEXTILE_API}/v2/rfq/request`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(75_000),
  })
  return { status: res.status, body: (await res.json().catch(() => ({}))) as any }
}

export async function build(input: any) {
  const { from, to } = pair(input.from, input.to)
  const amt = amountIn(from, input.amount)
  if (!isAddress(input.wallet ?? '')) throw new Error('wallet must be a valid address')
  const wallet = input.wallet as Address

  const bal = await pub.readContract({ address: TOKENS[from].address, abi: erc20Abi, functionName: 'balanceOf', args: [wallet] })
  if (bal < amt) throw new Error(`Insufficient ${from}: wallet has ${fmt(from, bal)}`)

  if (input.venue === 'uniswap') {
    const q = await uniQuote(from, to, amt)
    if (!q) throw new Error('No Uniswap route for this pair and size')
    const minOut = (q.out * (10_000n - USER_SLIPPAGE_BPS)) / 10_000n
    const steps = await approvalSteps(from, wallet, UNI.ROUTER, amt)
    steps.push({
      kind: 'swap', label: 'Swap on Uniswap v3', to: UNI.ROUTER, value: '0',
      data: tag(encodeFunctionData({ abi: routerAbi, functionName: 'exactInputSingle', args: [{
        tokenIn: TOKENS[from].address, tokenOut: TOKENS[to].address, fee: q.fee, recipient: wallet,
        amountIn: amt, amountOutMinimum: minOut, sqrtPriceLimitX96: 0n,
      }] })),
    })
    convertStats.builds++
    return { venue: 'uniswap', from, to, amountIn: input.amount, expectedOut: fmt(to, q.out), minOut: fmt(to, minOut), steps }
  }

  if (input.venue === 'textile') {
    const r = await textileRequest({
      chainId: CHAIN_ID, sellToken: TOKENS[from].address, buyToken: TOKENS[to].address, sellAmount: amt.toString(),
      taker: wallet, ...(input.takerProof ? { takerProof: input.takerProof } : {}),
    })
    const reason = String(r.body?.error?.details?.reason ?? '')
    if (r.status === 401 && reason.startsWith('proof_of_control')) {
      // The user's wallet must sign a free, gasless message proving it controls the taker address.
      const nonce = toHex(crypto.randomBytes(32))
      const issuedAt = Date.now()
      return {
        venue: 'textile', needsProof: true, reason,
        typedData: {
          domain: { name: 'Textile Taker Control', version: '1', chainId: CHAIN_ID },
          types: { TakerControl: [
            { name: 'taker', type: 'address' }, { name: 'chainId', type: 'uint256' },
            { name: 'nonce', type: 'bytes32' }, { name: 'issuedAt', type: 'uint256' },
          ] },
          primaryType: 'TakerControl',
          message: { taker: wallet, chainId: CHAIN_ID, nonce, issuedAt },
        },
        // Send back as takerProof: { nonce, issuedAt, signature } within 60 seconds
        proofFields: { nonce, issuedAt },
      }
    }
    if (r.status !== 200) throw new Error('Textile: ' + (r.body?.error?.message ?? `HTTP ${r.status}`))
    const d = r.body.data
    if (d.status === 'no_quote') return { venue: 'textile', noQuote: true, reason: d.reason }
    const reactor = String(d.quote.reactor).toLowerCase()
    if (reactor !== TEXTILE_REACTOR.toLowerCase() || String(d.transactions.swap.to).toLowerCase() !== reactor) {
      throw new Error('Unexpected Textile reactor, refusing to build')
    }
    const takerPays = BigInt(d.quote.takerPays)
    const steps = await approvalSteps(from, wallet, TEXTILE_REACTOR, takerPays)
    steps.push({ kind: 'swap', label: 'Swap on Textile FX', to: TEXTILE_REACTOR, data: tag(d.transactions.swap.data as Hex), value: '0' })
    convertStats.builds++
    return {
      venue: 'textile', from, to, amountIn: input.amount,
      expectedOut: fmt(to, BigInt(d.quote.buyAmount)), fee: fmt(from, BigInt(d.quote.feeAmount)),
      expiresAt: d.quote.expiresAt, rfqId: d.rfqId, steps,
    }
  }
  throw new Error("venue must be 'uniswap' or 'textile'")
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (c) => { data += c; if (data.length > 20_000) { reject(new Error('Body too large')); req.destroy() } })
    req.on('end', () => resolve(data))
    req.on('error', reject)
  })
}

export function handleConvert(req: IncomingMessage, res: ServerResponse, url: URL) {
  const send = (code: number, body: unknown) => {
    res.statusCode = code
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify(body, null, 2))
  }
  ;(async () => {
    if (req.method === 'GET' && url.pathname === '/convert/quote') {
      return send(200, await quote(url.searchParams.get('from'), url.searchParams.get('to'), url.searchParams.get('amount') ?? ''))
    }
    if (req.method === 'POST' && url.pathname === '/convert/build') {
      return send(200, await build(JSON.parse((await readBody(req)) || '{}')))
    }
    send(404, { error: 'not found' })
  })().catch((e) => send(400, { error: e.shortMessage ?? e.message }))
}
