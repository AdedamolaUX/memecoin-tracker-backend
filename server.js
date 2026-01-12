const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const { getSuccessfulDeployers } = require('./deployers'); // New import

const app = express();
const PORT = process.env.PORT || 3001;

// Environment variables (all keys secure)
const BIRDEYE_API_KEY = process.env.BIRDEYE_API_KEY || '';
const HELIUS_API_KEY = process.env.HELIUS_API_KEY || '';
const MORALIS_API_KEY = process.env.MORALIS_API_KEY || '';
const APIFY_TOKEN = process.env.APIFY_TOKEN || '';

let tokenCache = {};

// Blacklist
const BLACKLISTED_WALLETS = [
  'jup6lkbzbjs1jkkwapdhny74zcz3tluzoi5qnyvtav4',
  '675kpx9mhtjs2zt1qfr1nyhuzelxfqm9h24wfsut1nds',
  '6ef8rrecthr5dkco3tvb2e7g4pg4pg4pg4pg4pg4pg4',
  '6ogncyncnq6iwvbn6czigxzrlaeae2nzrakpjaJT7Gbv',
  'mooncvvnzfSFSYhqA5U9roKvd6udAe2nzrakpjaJT7Q',
  'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc',
  'jito4apdr8rthrdvdio4qvM5kaG6Ct8VwpYzGff3uctyCc',
  '5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1',
  '9WzDXwBbmkg8ZTbNMqUxvQRAHsKtLFa8zG3GcvNoytA7'
].map(a => a.toLowerCase());

// Load token registry
async function loadTokenRegistry() {
  try {
    const response = await fetch('https://raw.githubusercontent.com/solana-labs/token-list/main/src/tokens/solana.tokenlist.json');
    const data = await response.json();
    data.tokens.forEach(token => {
      tokenCache[token.address] = { symbol: token.symbol, name: token.name };
    });
    console.log('Loaded', Object.keys(tokenCache).length, 'tokens from registry');
  } catch (err) {
    console.error('Failed to load token registry:', err.message);
  }
}

// Get token metadata
async function getTokenMetadata(address) {
  if (tokenCache[address]) return tokenCache[address];
  
  try {
    const url = `https://api.helius.xyz/v0/token-metadata?api-key=${HELIUS_API_KEY}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mintAccounts: [address] })
    });
    const data = await response.json();
    if (data && data[0] && data[0].symbol && data[0].symbol !== 'UNKNOWN') {
      const metadata = { symbol: data[0].symbol, name: data[0].name || data[0].symbol };
      tokenCache[address] = metadata;
      return metadata;
    }
  } catch (err) {}
  
  try {
    const dexUrl = `https://api.dexscreener.com/latest/dex/tokens/${address}`;
    const dexResponse = await fetch(dexUrl);
    const dexData = await dexResponse.json();
    if (dexData && dexData.pairs && dexData.pairs[0]) {
      const pair = dexData.pairs[0];
      const metadata = { symbol: pair.baseToken.symbol, name: pair.baseToken.name };
      tokenCache[address] = metadata;
      return metadata;
    }
  } catch (err) {}
  
  return { symbol: address.slice(0, 4) + '...', name: 'Unknown' };
}

// MAIN DISCOVERY - Successful Deployers (from deployers.js)
app.get('/api/discover', async (req, res) => {
  try {
    const deployers = await getSuccessfulDeployers(limit = 50, HELIUS_API_KEY, BIRDEYE_API_KEY);
    
    res.json({
      success: true,
      discoveredDeployers: deployers,
      message: deployers.length === 0 
        ? 'No successful deployers found yet — market too early.'
        : 'Successful memecoin deployers (multiple $100K+ launches)!'
    });
  } catch (error) {
    console.error('Discovery error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ANALYZE WALLET (unchanged)
app.get('/api/wallet/:address', async (req, res) => {
  // Your existing code...
});

// DEXSCREENER
app.get('/api/dexscreener/:address', async (req, res) => {
  try {
    const { address } = req.params;
    const response = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${address}`);
    const data = await response.json();
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// HOME
app.get('/', (req, res) => {
  res.json({
    status: 'Memecoin Tracker Backend is LIVE!',
    timestamp: new Date().toISOString(),
    uptime_seconds: Math.floor(process.uptime()),
    message: 'Your successful deployer discovery API is ready.',
    endpoints: {
      discover: '/api/discover?limit=50 (main feature - successful deployers)',
      wallet: '/api/wallet/WALLET_ADDRESS (detailed analysis)',
      dexscreener: '/api/dexscreener/TOKEN_ADDRESS (token data)'
    }
  });
});

app.use(cors());
app.use(express.json());

loadTokenRegistry();

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});