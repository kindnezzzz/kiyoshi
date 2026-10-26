import { encodeFunctionData, erc20Abi, parseAbi, parseEventLogs, type Hex } from 'viem'
import { account, pub, sendTaggedReceipt } from './wallet.js'
import { ensureAllowance } from './swap.js'
import { TOKENS, UNI, type TokenKey } from './config.js'

const quoterAbi = parseAbi([
  'function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) returns (uint256 amountOut,uint160,uint32,uint256)',
])
const routerAbi = parseAbi([
  'function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) payable returns (uint256 amountOut)',
  'function factory() view returns (address)',
])

let routerVerified = false
async function verifyRouter() {
  if (routerVerified) return
  const f = await pub.readContract({ address: UNI.ROUTER, abi: routerAbi, functionName: 'factory' })
  if (f.toLowerCase() !== UNI.FACTORY.toLowerCase()) throw new Error(`Router factory mismatch (${f}), refusing to trade`)
  routerVerified = true
}

// Best quote across v3 fee tiers. Read-only.
export async function uniQuote(tin: TokenKey, tout: TokenKey, amountIn: bigint) {
  let best: { out: bigint; fee: number } | null = null
  for (const fee of [100, 500, 3000, 10000]) {
    try {
      const { result } = await pub.simulateContract({
        address: UNI.QUOTER, abi: quoterAbi, functionName: 'quoteExactInputSingle',
        args: [{ tokenIn: TOKENS[tin].address, tokenOut: TOKENS[tout].address, amountIn, fee, sqrtPriceLimitX96: 0n }],
      })
      if (!best || result[0] > best.out) best = { out: result[0], fee }
    } catch {}
  }
  return best
}

// Tagged swap through SwapRouter02. Reverts onchain if output < minOut.
// Returns the amount received, read from the swap's own receipt (never a stale balance read).
export async function uniSwap(tin: TokenKey, tout: TokenKey, amountIn: bigint, fee: number, minOut: bigint): Promise<{ hash: Hex; out: bigint }> {
  await verifyRouter()
  await ensureAllowance(TOKENS[tin].address, UNI.ROUTER, amountIn)
  const receipt = await sendTaggedReceipt({
    to: UNI.ROUTER,
    data: encodeFunctionData({
      abi: routerAbi,
      functionName: 'exactInputSingle',
      args: [{
        tokenIn: TOKENS[tin].address, tokenOut: TOKENS[tout].address, fee,
        recipient: account.address, amountIn, amountOutMinimum: minOut, sqrtPriceLimitX96: 0n,
      }],
    }),
  })
  const out = parseEventLogs({ abi: erc20Abi, logs: receipt.logs, eventName: 'Transfer' })
    .filter((l) => l.address.toLowerCase() === TOKENS[tout].address.toLowerCase() && l.args.to.toLowerCase() === account.address.toLowerCase())
    .reduce((sum, l) => sum + l.args.value, 0n)
  if (out === 0n) throw new Error(`Swap ${receipt.transactionHash} succeeded but no ${tout} transfer to the agent was found`)
  return { hash: receipt.transactionHash, out }
}
