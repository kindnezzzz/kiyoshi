// Rebuilds the agent's trade history from Celo mainnet and merges it into the trade log.
// Reads every ERC-20 transfer to/from the agent wallet, pairs buys and sells into round trips,
// and writes them as cycle/flatten entries. Safe to rerun.
//
// Start block resolution (first match wins):
//   1. START_BLOCK env var (a block number)
//   2. the ERC-8004 registration block from agent.json (if the agent registered)
//   3. 10,000 blocks behind the current head
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { formatUnits, parseAbiItem } from 'viem';
import { account, pub } from './wallet.js';
import { TEXTILE_REACTOR, TOKENS, UNI } from './config.js';
const DATA_DIR = process.env.DATA_DIR ?? '.';
const FILE = DATA_DIR + '/trades.jsonl';
const me = account.address.toLowerCase();
const transfer = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)');
const usd = (v) => Number(formatUnits(v, 6));
async function retry(fn) {
    for (let i = 0;; i++) {
        try {
            return await fn();
        }
        catch (e) {
            if (i >= 5)
                throw e;
            await new Promise((r) => setTimeout(r, 1500));
        }
    }
}
const start = process.env.START_BLOCK
    ? BigInt(process.env.START_BLOCK)
    : await (async () => {
        try {
            const agent = JSON.parse(readFileSync('agent.json', 'utf8'));
            const r = await retry(() => pub.getTransactionReceipt({ hash: agent.registerTx }));
            if (r && r.blockNumber)
                return r.blockNumber;
        }
        catch { }
        return (await retry(() => pub.getBlockNumber())) - 10000n;
    })();
const head = await retry(() => pub.getBlockNumber());
console.log(`Scanning blocks ${start} to ${head} for wallet ${account.address}`);
// 1. Net token movement per transaction
const keys = Object.keys(TOKENS);
const perTx = new Map();
const STEP = 2000n;
for (const k of keys) {
    for (const dir of ['from', 'to']) {
        for (let a = start; a <= head; a += STEP) {
            const b = a + STEP - 1n > head ? head : a + STEP - 1n;
            const logs = await retry(() => pub.getLogs({ address: TOKENS[k].address, event: transfer, args: { [dir]: account.address }, fromBlock: a, toBlock: b }));
            for (const l of logs) {
                const d = perTx.get(l.transactionHash) ?? {};
                d[k] = (d[k] ?? 0n) + (dir === 'to' ? 1n : -1n) * l.args.value;
                perTx.set(l.transactionHash, d);
            }
        }
    }
}
console.log(`Found ${perTx.size} transactions moving tokens`);
const legs = [];
const blockTime = new Map();
for (const [hash, d] of perTx) {
    const tx = await retry(() => pub.getTransaction({ hash }));
    if (tx.from.toLowerCase() !== me || !tx.to)
        continue; // deposits and withdrawals are not trades
    const to = tx.to.toLowerCase();
    const venue = to === UNI.ROUTER.toLowerCase() ? 'uniswap' : to === TEXTILE_REACTOR.toLowerCase() ? 'textile' : null;
    if (!venue)
        continue;
    const X = keys.find((k) => k !== 'USDT' && k !== 'USDC' && (d[k] ?? 0n) !== 0n);
    if (!X || !d.USDT)
        continue;
    if (!blockTime.has(tx.blockNumber)) {
        const blk = await retry(() => pub.getBlock({ blockNumber: tx.blockNumber }));
        blockTime.set(tx.blockNumber, new Date(Number(blk.timestamp) * 1000).toISOString());
    }
    legs.push({ hash, block: tx.blockNumber, ts: blockTime.get(tx.blockNumber), venue, X, usdt: d.USDT, x: d[X] });
}
legs.sort((a, b) => (a.block < b.block ? -1 : a.block > b.block ? 1 : 0));
// 3. Pair each buy with the next sell of the same amount on the other venue
const close = (a, b) => { const diff = a > b ? a - b : b - a; const max = a > b ? a : b; return diff * 1000n <= max * 10n; }; // within 1%
const open = [];
const entries = [];
for (const l of legs) {
    if (l.usdt < 0n && l.x > 0n) {
        open.push(l);
        continue;
    } // bought X
    if (!(l.usdt > 0n && l.x < 0n))
        continue;
    const sold = -l.x;
    const i = open.findIndex((o) => o.X === l.X && o.venue !== l.venue && close(o.x, sold));
    if (i >= 0) {
        const o = open.splice(i, 1)[0];
        const spent = -o.usdt, got = l.usdt;
        const route = o.venue === 'uniswap' ? 'uni->textile' : 'textile->uni';
        entries.push({ ts: l.ts, live: true, event: 'cycle', X: l.X, route, sizeUsd: usd(spent), tx1: o.hash, tx2: l.hash, leg2: 'filled',
            textileUsd: route === 'uni->textile' ? usd(got) : usd(spent), pnl: usd(got) - usd(spent), source: 'chain' });
    }
    else {
        entries.push({ ts: l.ts, live: true, event: 'flatten', X: l.X, venue: l.venue, tx: l.hash, usdtOut: usd(l.usdt),
            ...(l.venue === 'textile' ? { textileUsd: usd(l.usdt) } : {}), source: 'chain' });
    }
}
console.log(`Rebuilt ${entries.filter((e) => e.event === 'cycle').length} round trips and ${entries.filter((e) => e.event === 'flatten').length} leftover sales; ${open.length} buys still open (current inventory)`);
// 4. Merge: chain entries replace any logged entries for the same transactions
const chainTx = new Set(entries.flatMap((e) => [e.tx1, e.tx2, e.tx].filter(Boolean)));
const existing = existsSync(FILE) ? readFileSync(FILE, 'utf8').split('\n').filter(Boolean).map((l) => { try {
    return JSON.parse(l);
}
catch {
    return null;
} }).filter(Boolean) : [];
const kept = existing.filter((e) => !((e.event === 'cycle' || e.event === 'flatten') && [e.tx1, e.tx2, e.tx].some((t) => t && chainTx.has(t))));
const merged = [...kept, ...entries].sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
writeFileSync(FILE, merged.map((e) => JSON.stringify(e)).join('\n') + '\n');
const realized = entries.filter((e) => e.event === 'cycle').reduce((s, e) => s + e.pnl, 0);
const textileVol = entries.reduce((s, e) => s + (e.textileUsd ?? 0), 0);
console.log(`Realized P&L from round trips: ${realized >= 0 ? '+' : ''}${realized.toFixed(4)} USDT | Textile volume: $${textileVol.toFixed(2)}`);
console.log(`Wrote ${merged.length} lines to ${FILE}. Restart the service so the dashboard loads them.`);
