const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 3001;

// Birdeye key (free tier for token list)
const BIRDEYE_API_KEY = '73e8a243fd26414098b027317db6cbfd';

// Helius key
const HELIUS_API_KEY = 'a6f9ba84-1abf-4c90-8e04-fc0a61294407';

let tokenCache = {};

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
  } catch (err) {
    console.log('Helius failed:', err.message);
  }
  
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
  } catch (err) {
    console.log('DexScreener failed:', err.message);
  }
  
  return { symbol: address.slice(0, 4) + '...', name: 'Unknown' };
}

// Get market cap
async function getTokenMarketCap(address) {
  try {
    const response = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${address}`);
    const data = await response.json();
    
    if (data && data.pairs && data.pairs[0]) {
      const pair = data.pairs[0];
      return {
        marketCap: pair.fdv || pair.marketCap || 0,
        priceUsd: parseFloat(pair.priceUsd) || 0,
        liquidity: pair.liquidity?.usd || 0,
        age: pair.pairCreatedAt ? Date.now() - pair.pairCreatedAt : null
      };
    }
  } catch (err) {
    console.log('Market cap fetch failed:', err.message);
  }
  return { marketCap: 0, priceUsd: 0, liquidity: 0, age: null };
}

// ANALYZE WALLET
app.get('/api/wallet/:address', async (req, res) => {
  // ... (keep your existing code)
});

// NEW ENDPOINT: Birdeye Token List + DexScreener + Helius Wallets (larger database)
app.get('/api/birdeye/list', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 100; // Up to 100 tokens from list
    
    console.log('Fetching token list from Birdeye free tier...');
    
    const listUrl = 'https://public-api.birdeye.so/defi/tokenlist?sort_by=mc&sort_type=desc&offset=0&limit=' + limit;
    const listResponse = await fetch(listUrl, {
      headers: {
        'X-API-KEY': BIRDEYE_API_KEY,
        'x-chain': 'solana'
      }
    });
    
    if (!listResponse.ok) {
      return res.json({ error: 'Birdeye token list error - check key or rate limit', status: listResponse.status });
    }
    
    const listData = await listResponse.json();
    
    if (!listData.success || !listData.data || listData.data.tokens.length === 0) {
      return res.json({ message: 'No tokens from Birdeye list' });
    }
    
    const tokens = listData.data.tokens.slice(0, limit);
    
    console.log(`Found ${tokens.length} tokens from Birdeye list`);
    
    const walletScores = {};
    
    for (const token of tokens) {
      const mintAddress = token.address;
      console.log('Analyzing token from list:', token.symbol, mintAddress);
      
      try {
        const txUrl = `https://api.helius.xyz/v0/addresses/${mintAddress}/transactions?api-key=${HELIUS_API_KEY}&limit=50`;
        const txResponse = await fetch(txUrl);
        const transactions = await txResponse.json();
        
        if (!transactions || transactions.length === 0) continue;
        
        const wallets = new Set();
        
        for (const tx of transactions) {
          if (tx.tokenTransfers) {
            for (const transfer of tx.tokenTransfers) {
              if (transfer.toUserAccount) wallets.add(transfer.toUserAccount);
              if (transfer.fromUserAccount) wallets.add(transfer.fromUserAccount);
            }
          }
        }
        
        for (const walletAddr of wallets) {
          if (!walletScores[walletAddr]) {
            walletScores[walletAddr] = {
              address: walletAddr,
              tokensFound: [],
              score: 0
            };
          }
          
          walletScores[walletAddr].score += 1;
          walletScores[walletAddr].tokensFound.push({
            symbol: token.symbol,
            mc: token.mc || 0,
            volume: token.v24hUSD || 0
          });
        }
        
        await new Promise(r => setTimeout(r, 500));
      } catch (err) {
        console.error('Error:', err.message);
      }
    }
    
    const discoveredWallets = Object.values(walletScores)
      .filter(w => w.tokensFound.length >= 1)
      .sort((a, b) => b.tokensFound.length - a.tokensFound.length)
      .slice(0, 20)
      .map((wallet, index) => ({
        rank: index + 1,
        address: wallet.address,
        activeInTokens: wallet.tokensFound.length,
        tokensFound: wallet.tokensFound,
        discoveredFrom: wallet.tokensFound.map(t => t.symbol).join(', ')
      }));
    
    res.json({
      success: true,
      discoveredWallets,
      totalTokensFromList: tokens.length,
      totalWalletsFound: Object.keys(walletScores).length,
      source: 'Birdeye Token List + Helius Wallets'
    });
    
  } catch (error) {
    console.error('Birdeye list error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Keep your current /api/discover (new pairs) as fallback

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
    endpoints: {
      birdeye_list: '/api/birdeye/list?limit=100 (larger token list + wallets)',
      discover_new: '/api/discover (new pairs early buyers)',
      wallet: '/api/wallet/WALLET_ADDRESS',
      dexscreener: '/api/dexscreener/TOKEN_ADDRESS'
    }
  });
});

app.use(cors());
app.use(express.json());

loadTokenRegistry();

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});