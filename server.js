const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 3001;

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

// ANALYZE WALLET (unchanged)
app.get('/api/wallet/:address', async (req, res) => {
  // ... (keep your current code)
});

// AUTO-DISCOVERY - Now uses DexScreener NEW PAIRS (always has fresh memecoins)
app.get('/api/discover', async (req, res) => {
  try {
    const maxAgeHours = parseInt(req.query.maxAge) || 24; // New tokens in last X hours
    
    console.log('Starting discovery from NEW PAIRS (fresh memecoins)...');
    
    const searchUrl = 'https://api.dexscreener.com/latest/dex/search?q=new&chain=solana';
    const searchResponse = await fetch(searchUrl);
    const searchData = await searchResponse.json();
    
    if (!searchData || !searchData.pairs || searchData.pairs.length === 0) {
      return res.json({ 
        success: true,
        discoveredWallets: [],
        newTokens: 0,
        message: 'No new pairs found right now. Market might be slow.'
      });
    }
    
    const newTokens = searchData.pairs
      .filter(pair => pair.chainId === 'solana')
      .sort((a, b) => (b.pairCreatedAt || 0) - (a.pairCreatedAt || 0)) // Newest first
      .slice(0, 20); // Top 20 new tokens for analysis
    
    console.log(`Found ${newTokens.length} new Solana tokens`);
    
    const walletScores = {};
    
    for (const token of newTokens) {
      const mintAddress = token.baseToken.address;
      console.log('Analyzing new token:', token.baseToken.symbol, mintAddress);
      
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
          
          walletScores[walletAddr].score += 1; // Simple score - early buyer of new token
          walletScores[walletAddr].tokensFound.push({
            symbol: token.baseToken.symbol,
            ageHours: token.pairAge ? token.pairAge / 3600 : 0
          });
        }
        
        await new Promise(r => setTimeout(r, 500));
      } catch (err) {
        console.error('Error:', err.message);
      }
    }
    
    const discoveredWallets = Object.values(walletScores)
      .filter(w => w.tokensFound.length >= 1)
      .sort((a, b) => b.tokensFound.length - a.tokensFound.length) // Most early buys
      .slice(0, 20)
      .map((wallet, index) => ({
        rank: index + 1,
        address: wallet.address,
        earlyBuys: wallet.tokensFound.length,
        tokensFound: wallet.tokensFound,
        discoveredFrom: wallet.tokensFound.map(t => t.symbol).join(', ')
      }));
    
    res.json({
      success: true,
      discoveredWallets,
      newTokens: newTokens.length,
      totalWalletsFound: Object.keys(walletScores).length,
      message: 'Found early buyers of newest memecoins!'
    });
    
  } catch (error) {
    console.error('Discovery error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Other endpoints unchanged

app.use(cors());
app.use(express.json());

loadTokenRegistry();

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});