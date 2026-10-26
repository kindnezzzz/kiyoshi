import crypto from 'node:crypto';
import { toHex } from 'viem';
import { account } from './wallet.js';
import { CHAIN_ID, TEXTILE_API } from './config.js';
const V2 = `${TEXTILE_API}/v2`;
const JSON_HEADERS = { 'Content-Type': 'application/json' };
export async function getTicker(id = 'USDT_NGN') {
    const r = await fetch(`${TEXTILE_API}/tickers?ticker_id=${id}`);
    if (!r.ok)
        throw new Error(`tickers ${r.status}`);
    const [t] = (await r.json());
    return t;
}
async function signTakerControl() {
    const nonce = toHex(crypto.randomBytes(32));
    const issuedAt = Date.now();
    const signature = await account.signTypedData({
        domain: { name: 'Textile Taker Control', version: '1', chainId: CHAIN_ID },
        types: {
            TakerControl: [
                { name: 'taker', type: 'address' },
                { name: 'chainId', type: 'uint256' },
                { name: 'nonce', type: 'bytes32' },
                { name: 'issuedAt', type: 'uint256' },
            ],
        },
        primaryType: 'TakerControl',
        message: { taker: account.address, chainId: BigInt(CHAIN_ID), nonce, issuedAt: BigInt(issuedAt) },
    });
    return { nonce, issuedAt, signature };
}
async function unwrap(res) {
    const body = await res.json().catch(() => ({}));
    if (!res.ok)
        throw new Error(`Textile ${res.status}: ${JSON.stringify(body.error ?? body)}`);
    return body.data;
}
export async function preview(leg) {
    const res = await fetch(`${V2}/rfq/preview`, {
        method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ chainId: CHAIN_ID, ...leg }),
    });
    return unwrap(res);
}
// Firm quote. Tries unsigned first (12h grant), signs proof of control only when asked.
export async function requestQuote(leg) {
    const send = (extra = {}) => fetch(`${V2}/rfq/request`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ chainId: CHAIN_ID, ...leg, taker: account.address, ...extra }),
        signal: AbortSignal.timeout(75_000),
    });
    let res = await send();
    if (res.status === 401) {
        const body = await res.clone().json().catch(() => ({}));
        if (body?.error?.details?.reason === 'proof_of_control_required') {
            res = await send({ takerProof: await signTakerControl() });
        }
    }
    return unwrap(res);
}
export async function submitTx(rfqId, claimToken, txHash) {
    const res = await fetch(`${V2}/rfq/${rfqId}/submit`, {
        method: 'POST', headers: { ...JSON_HEADERS, 'X-Rfq-Claim': claimToken }, body: JSON.stringify({ txHash }),
    });
    return unwrap(res);
}
export async function getRfq(rfqId, claimToken) {
    const res = await fetch(`${V2}/rfq/${rfqId}`, { headers: { 'X-Rfq-Claim': claimToken } });
    return unwrap(res);
}
