import 'dotenv/config';
// ERC-8021 attribution tag — every transaction the bot sends carries this suffix.
// Change it to your own tag string if you want to identify your bot differently.
export const ATTRIBUTION_TAG = process.env.ATTRIBUTION_TAG ?? 'celo_f6214d29d540';
// ERC-8004 identity (used for the /status payload; registration is optional).
export const AGENT_ID = Number(process.env.AGENT_ID ?? 9991);
export const CHAIN_ID = 42220;
export const RPC_URL = process.env.CELO_RPC ?? 'https://forno.celo.org';
export const TEXTILE_API = 'https://api.textilecredit.com';
// From docs.textilecredit.com/protocol/address-book (Celo 42220)
export const TEXTILE_REACTOR = '0xa9AA0a64769cBed4d3B1Ceb4Df01CdE915C235b3';
// Uniswap v3 on Celo
export const UNI = {
    FACTORY: '0xAfE208a311B21f13EF87E33A90049fC17A7acDEc',
    QUOTER: '0x82825d0554fA07f7FC52Ab63c961F330fdEFa8E8',
    ROUTER: '0x5615CDAb10dc425a742d643d949a7F474C01abc4', // SwapRouter02
};
export const TOKENS = {
    USDT: { address: '0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e', decimals: 6 },
    USDC: { address: '0xcebA9300f2b948710d2653dD7B07f33A8B32118C', decimals: 6 },
    cNGN: { address: '0xF6829D7393dAe24509eb1E52eE8e572e2E271a4f', decimals: 6 },
    wBRL: { address: '0xD76f5Faf6888e24D9F04Bf92a0c8B921FE4390e0', decimals: 18 },
    wARS: { address: '0x0DC4F92879B7670e5f4e4e6e3c801D229129D90D', decimals: 18 },
};
// Local-currency corridors the desk watches (Textile has a Celo corridor for each vs USDT)
export const CORRIDORS = ['wBRL', 'wARS', 'cNGN'];
