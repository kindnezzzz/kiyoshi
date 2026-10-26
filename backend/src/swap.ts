import { encodeFunctionData, erc20Abi, maxUint256, type Address, type Hex } from 'viem'
import { account, pub, sendTagged } from './wallet.js'
import { requestQuote, submitTx } from './textile.js'
import { TEXTILE_REACTOR, TOKENS, type TokenKey } from './config.js'

export async function balanceOf(token: Address, blockNumber?: bigint) {
  return pub.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [account.address], ...(blockNumber ? { blockNumber } : {}) })
}

export async function ensureAllowance(token: Address, spender: Address, required: bigint) {
  const allowance = await pub.readContract({
    address: token, abi: erc20Abi, functionName: 'allowance', args: [account.address, spender],
  })
  if (allowance >= required) return
  const approve = (amount: bigint) =>
    sendTagged({ to: token, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [spender, amount] }) })
  if (allowance > 0n) await approve(0n) // USDT-style tokens refuse nonzero to nonzero
  await approve(maxUint256)
}

// One tagged RFQ swap on Textile. sellAmount in atomic units.
// minReceived: refuse the firm quote (send nothing) if it pays less than this.
export async function swap(sell: TokenKey, buy: TokenKey, sellAmount: bigint, minReceived?: bigint) {
  const sellToken = TOKENS[sell].address
  const buyToken = TOKENS[buy].address

  // Public RPCs can lag a block or two behind a fresh receipt, so wait for the balance to appear.
  let bal = await balanceOf(sellToken)
  for (let i = 0; bal < sellAmount && i < 15; i++) {
    await new Promise((r) => setTimeout(r, 1000))
    bal = await balanceOf(sellToken)
  }
  if (bal < sellAmount) throw new Error(`Not enough ${sell}: have ${bal}, need ${sellAmount}`)

  // Approve before quoting so the 60s quote window is not spent on approvals.
  await ensureAllowance(sellToken, TEXTILE_REACTOR, sellAmount)

  // Textile also checks our balance onchain and can briefly lag the same way; retry that case only.
  let q: any
  for (let i = 0; ; i++) {
    try {
      q = await requestQuote({ sellToken, buyToken, sellAmount: sellAmount.toString() })
      break
    } catch (e: any) {
      const msg = String(e.message)
      if (i < 3 && msg.includes('insufficient_funds')) {
        // Either the RPC is a block behind, or Textile still reserves funds from an earlier quote.
        const m = msg.match(/"retryAfterMs":(\d+)/)
        const wait = m ? Math.min(Number(m[1]) + 2000, 120_000) : 3000
        console.log(`  Textile still sees those funds as reserved, waiting ${Math.round(wait / 1000)}s`)
        await new Promise((r) => setTimeout(r, wait))
        continue
      }
      throw e
    }
  }
  if (q.status === 'no_quote') return { status: 'no_quote' as const, reason: q.reason as string }

  const { rfqId, claimToken, quote, transactions } = q
  const reactor = String(quote.reactor).toLowerCase()
  if (reactor !== TEXTILE_REACTOR.toLowerCase() || String(transactions.swap.to).toLowerCase() !== reactor) {
    throw new Error(`Unexpected reactor ${quote.reactor}, refusing to trade`)
  }
  if (minReceived !== undefined && BigInt(quote.buyAmount) < minReceived) {
    return { status: 'below_min' as const, rfqId, offered: BigInt(quote.buyAmount) }
  }
  if (Date.now() >= Date.parse(quote.expiresAt) - 3_000) return { status: 'expired' as const, rfqId }

  const txHash = await sendTagged({ to: transactions.swap.to as Address, data: transactions.swap.data as Hex })
  await submitTx(rfqId, claimToken, txHash).catch(() => {}) // courtesy call, fill is reconciled onchain anyway

  return {
    status: 'filled' as const,
    rfqId,
    txHash,
    paid: BigInt(quote.takerPays),
    received: BigInt(quote.buyAmount),
    fee: BigInt(quote.feeAmount),
  }
}
