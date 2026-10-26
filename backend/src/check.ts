// Read-only health check. Sends NO transactions.
import { formatUnits } from 'viem'
import { account, pub, TAG_SUFFIX } from './wallet.js'
import { balanceOf } from './swap.js'
import { getTicker, preview } from './textile.js'
import { ATTRIBUTION_TAG, TOKENS } from './config.js'

console.log('Agent wallet :', account.address)
console.log('Tag          :', ATTRIBUTION_TAG, '->', TAG_SUFFIX)

const celo = await pub.getBalance({ address: account.address })
console.log('CELO         :', formatUnits(celo, 18))
for (const k of ['cNGN', 'USDT'] as const) {
  console.log(`${k.padEnd(13)}:`, formatUnits(await balanceOf(TOKENS[k].address), TOKENS[k].decimals))
}

const t = await getTicker('USDT_NGN')
console.log(`\nTextile USDT/NGN  last ${t.last_price}  bid ${t.bid}  ask ${t.ask}  24h vol $${t.base_volume}`)

const p = await preview({ sellToken: TOKENS.USDT.address, buyToken: TOKENS.cNGN.address, sellAmount: '1000000' })
console.log('Preview 1 USDT -> cNGN on Celo:', p.status === 'preview'
  ? `${formatUnits(BigInt(p.buyAmount), 6)} cNGN (fee ${formatUnits(BigInt(p.feeAmount), 6)} USDT)`
  : `no_quote (${p.reason})`)
