// Registers this agent's ERC-8004 identity on Celo mainnet. Sends 2 tagged transactions.
// Optional — the bot trades without it; registration gives it a public identity on the registry.
import { writeFileSync } from 'node:fs'
import { encodeFunctionData, parseAbi, parseEventLogs } from 'viem'
import { verifyTx } from '@celo/attribution-tags'
import { account, pub, sendTagged } from './wallet.js'
import { AGENT_ID } from './config.js'

const REGISTRY = '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432' // Celo mainnet Identity Registry
const abi = parseAbi([
  'function register(string agentURI) returns (uint256)',
  'function setAgentURI(uint256 agentId, string newURI)',
  'function balanceOf(address owner) view returns (uint256)',
  'event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)',
])

const NAME = process.env.AGENT_NAME ?? 'Kiyoshi Live'
const WEB = process.env.AGENT_WEB ?? 'https://example.com'
const DESCRIPTION =
  'Autonomous FX agent on Celo. Compares Textile FX RFQ quotes with Uniswap v3 pools across Celo local-currency corridors (wBRL, wARS, cNGN vs USDT), trades the gaps when they beat costs, and logs every trade and its P&L.'

function registrationFile(agentId?: bigint) {
  const json = {
    type: 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1',
    name: NAME,
    description: DESCRIPTION,
    services: [{ name: 'web', endpoint: WEB }],
    x402Support: false,
    active: true,
    supportedTrust: ['reputation'],
    ...(agentId !== undefined
      ? { registrations: [{ agentId: Number(agentId), agentRegistry: `eip155:42220:${REGISTRY}` }] }
      : {}),
  }
  return 'data:application/json;base64,' + Buffer.from(JSON.stringify(json)).toString('base64')
}

const existing = await pub.readContract({ address: REGISTRY, abi, functionName: 'balanceOf', args: [account.address] })
if (existing > 0n) {
  console.log(`This wallet already owns ${existing} registered agent(s). Not registering again.`)
  process.exit(0)
}

console.log(`Registering "${NAME}" (agent ID ${AGENT_ID}) from ${account.address} ...`)
const regHash = await sendTagged({
  to: REGISTRY,
  data: encodeFunctionData({ abi, functionName: 'register', args: [registrationFile()] }),
})
const receipt = await pub.getTransactionReceipt({ hash: regHash })
const minted = parseEventLogs({ abi, logs: receipt.logs, eventName: 'Transfer' })
  .find((l) => l.args.to.toLowerCase() === account.address.toLowerCase())
if (!minted) throw new Error(`Registered but could not find the agent ID in tx ${regHash}`)
const agentId = minted.args.tokenId
console.log(`Agent ID: ${agentId}   tx https://celoscan.io/tx/${regHash}`)

console.log('Adding the agent ID to its registration file ...')
const uriHash = await sendTagged({
  to: REGISTRY,
  data: encodeFunctionData({ abi, functionName: 'setAgentURI', args: [agentId, registrationFile(agentId)] }),
})
console.log(`Updated.   tx https://celoscan.io/tx/${uriHash}`)

writeFileSync('agent.json', JSON.stringify({ agentId: agentId.toString(), registry: REGISTRY, wallet: account.address, registerTx: regHash, setUriTx: uriHash }, null, 2))

for (const [label, hash] of [['register', regHash], ['setAgentURI', uriHash]] as const) {
  const tag = await verifyTx({ client: pub, hash })
  console.log(`Tag check (${label}):`, tag ? tag.codes.join(', ') : 'NOT FOUND')
}
console.log('\nSaved to agent.json. Done.')
