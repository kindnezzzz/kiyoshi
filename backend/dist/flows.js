// Tracks capital flows into and out of the agent wallet from the chain, so P&L excludes deposits.
// Deposit: USDT/USDC arriving in a tx NOT sent by the agent.
// Withdrawal: a direct USDT/USDC transfer sent by the agent (tx.to is the token contract).
// Trade proceeds (txs the agent sent to Uniswap or Textile) are neither.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { formatUnits, parseAbiItem } from 'viem';
import { account, pub } from './wallet.js';
import { TOKENS } from './config.js';
const DATA_DIR = process.env.DATA_DIR ?? '.';
const FILE = DATA_DIR + '/flows.json';
const transfer = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)');
const me = account.address.toLowerCase();
const STABLES = ['USDT', 'USDC'];
const tokenAddrs = new Set(Object.values(TOKENS).map((t) => t.address.toLowerCase()));
const CONFIRMATIONS = 20n; // stay a few blocks behind head so a lagging RPC node can't make us skip logs
let st = existsSync(FILE) ? JSON.parse(readFileSync(FILE, 'utf8')) : null;
export const netDeposits = () => (st ? st.deposits - st.withdrawals : NaN);
export const flowSummary = () => st ? { deposits: st.deposits, withdrawals: st.withdrawals, net: st.deposits - st.withdrawals, scannedTo: st.lastBlock, events: st.events.slice(-20).reverse() } : null;
const blockTs = new Map();
async function ts(block) {
    if (!blockTs.has(block)) {
        const b = await pub.getBlock({ blockNumber: block });
        blockTs.set(block, new Date(Number(b.timestamp) * 1000).toISOString());
    }
    return blockTs.get(block);
}
export async function updateFlows() {
    if (!st) {
        // Prefer the ERC-8004 registration block (if the agent registered); otherwise scan the last 2000 blocks.
        let start;
        try {
            const agent = JSON.parse(readFileSync('agent.json', 'utf8'));
            const r = await pub.getTransactionReceipt({ hash: agent.registerTx });
            start = r && r.blockNumber ? r.blockNumber - 1n : (await pub.getBlockNumber({ cacheTime: 0 })) - 2000n;
        }
        catch {
            start = (await pub.getBlockNumber({ cacheTime: 0 })) - 2000n;
        }
        st = { lastBlock: String(start), deposits: 0, withdrawals: 0, events: [] };
    }
    const head = (await pub.getBlockNumber({ cacheTime: 0 })) - CONFIRMATIONS;
    let from = BigInt(st.lastBlock) + 1n;
    const STEP = 2000n;
    while (from <= head) {
        const to = from + STEP - 1n > head ? head : from + STEP - 1n;
        for (const sym of STABLES) {
            const t = TOKENS[sym];
            const [ins, outs] = await Promise.all([
                pub.getLogs({ address: t.address, event: transfer, args: { to: account.address }, fromBlock: from, toBlock: to }),
                pub.getLogs({ address: t.address, event: transfer, args: { from: account.address }, fromBlock: from, toBlock: to }),
            ]);
            for (const l of ins) {
                const tx = await pub.getTransaction({ hash: l.transactionHash });
                if (tx.from.toLowerCase() === me)
                    continue; // proceeds of the agent's own trades
                const amount = Number(formatUnits(l.args.value, t.decimals));
                st.deposits += amount;
                st.events.push({ ts: await ts(l.blockNumber), tx: l.transactionHash, token: sym, amount, kind: 'deposit', counterparty: String(l.args.from) });
                console.log(`  capital: deposit of ${amount} ${sym} detected`);
            }
            for (const l of outs) {
                const tx = await pub.getTransaction({ hash: l.transactionHash });
                if (tx.from.toLowerCase() !== me || !tx.to || !tokenAddrs.has(tx.to.toLowerCase()))
                    continue; // only direct transfers out
                const amount = Number(formatUnits(l.args.value, t.decimals));
                st.withdrawals += amount;
                st.events.push({ ts: await ts(l.blockNumber), tx: l.transactionHash, token: sym, amount, kind: 'withdrawal', counterparty: String(l.args.to) });
                console.log(`  capital: withdrawal of ${amount} ${sym} detected`);
            }
        }
        st.lastBlock = String(to);
        from = to + 1n;
    }
    writeFileSync(FILE, JSON.stringify(st, null, 2));
}
