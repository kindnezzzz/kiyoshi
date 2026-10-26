import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
const pk = generatePrivateKey()
console.log('Agent address :', privateKeyToAccount(pk).address)
console.log('Private key   :', pk)
console.log('\nPut the key in .env as AGENT_PRIVATE_KEY. Never commit it, never share it.')
