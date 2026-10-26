// Verify Kiyoshi attribution on Celo transactions.
// Usage: npx tsx src/verify.ts <txHash> [<txHash> ...]
import { verifyTx } from '@celo/attribution-tags'
import { pub } from './wallet.js'
import { ATTRIBUTION_TAG, TEXTILE_REACTOR, TOKENS, UNI } from './config.js'

const names: Record<string, string> = {
  [UNI.ROUTER.toLowerCase()]: 'Uniswap v3 SwapRouter02',
  [TEXTILE_REACTOR.toLowerCase()]: 'Textile FX reactor',
  '0x8004a169fb4a3325136eb29fa0ceb6d2e539a432': 'ERC-8004 Identity Registry',
}
for (const [sym, t] of Object.entries(TOKENS)) names[t.address.toLowerCase()] = `${sym} token (approve/transfer)`

const hashes = process.argv.slice(2)
if (hashes.length === 0) {
  console.log('Usage: npx tsx src/verify.ts <txHash> [<txHash> ...]')
  process.exit(1)
}

for (const raw of hashes) {
  const hash = raw.trim().replace(/^.*\/tx\//, '') as `0x${string}` // also accepts full Celoscan links
  if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) {
    console.log(`\n${raw}\n  not a valid transaction hash`)
    continue
  }
  try {
    const [tx, receipt, tag] = await Promise.all([
      pub.getTransaction({ hash }),
      pub.getTransactionReceipt({ hash }),
      verifyTx({ client: pub, hash }),
    ])
    const to = tx.to?.toLowerCase() ?? ''
    const ours = tag?.codes.includes(ATTRIBUTION_TAG)
    console.log(`\n${hash}`)
    console.log(`  status  ${receipt.status}`)
    console.log(`  from    ${tx.from}`)
    console.log(`  to      ${tx.to}  (${names[to] ?? 'unknown contract'})`)
    console.log(`  tag     ${tag ? tag.codes.join(', ') : 'NOT FOUND'}${ours ? '  <- Kiyoshi attribution OK' : ''}`)
    console.log(`  link    https://celoscan.io/tx/${hash}`)
  } catch (e: any) {
    console.log(`\n${hash}\n  error: ${e.shortMessage ?? e.message}`)
  }
}
