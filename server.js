const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 3001;

// Birdeye key for token list
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

// Get market cap and change
async function getTokenMarketCap(address) {
  try {
    const response = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${address}`);
    const data = await response.json();
    
    if (data && data.pairs && data.pairs[0]) {
      const pair = data.pairs[0];
      return {
        marketCap: pair.fdv || pair.marketCap || 0,
        priceUsd: parseFloat(pair.priceUsd) || 0,
        change24h: pair.priceChange?.h24 || 0,
        volume24h: pair.volume?.h24 || 0,
        age: pair.pairCreatedAt ? Date.now() - new Date(pair.pairCreatedAt).getTime() : null
      };
    }
  } catch (err) {}
  return { marketCap: 0, priceUsd: 0, change24h: 0, volume24h: 0, age: null };
}

// ANALYZE WALLET (unchanged)
app.get('/api/wallet/:address', async (req, res) => {
  // Keep your existing code here
});

// MAIN DISCOVERY - Merged: DexScreener New Pairs + Birdeye Token List + Success Scoring
app.get('/api/discover', async (req, res) => {
  try {
    const walletScores = {};

    // 1. DexScreener New Pairs (fresh launches - high early ROI)
    console.log('Fetching new pairs from DexScreener...');
    const newPairsUrl = 'https://api.dexscreener.com/latest/dex/search?q=new&chain=solana';
    const newResponse = await fetch(newPairsUrl);
    const newData = await newResponse.json();
    
    const newTokens = (newData.pairs || [])
      .filter(p => p.chainId === 'solana')
      .slice(0, 20);

    for (const token of newTokens) {
      const mint = token.baseToken.address;
      const mcData = await getTokenMarketCap(mint);
      
      try {
        const txUrl = `https://api.helius.xyz/v0/addresses/${mint}/transactions?api-key=${HELIUS_API_KEY}&limit=50`;
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
        
        for (const wallet of wallets) {
          if (!walletScores[wallet]) {
            walletScores[wallet] = {
              address: wallet,
              earlyBuys: 0,
              totalTokens: 0,
              totalChangeBonus: 0,
              score: 0
            };
          }
          walletScores[wallet].earlyBuys += 1;
          walletScores[wallet].totalTokens += 1;
          walletScores[wallet].totalChangeBonus += (mcData.change24h > 0 ? mcData.change24h : 0);
        }
        
        await new Promise(r => setTimeout(r, 500));
      } catch (err) {}
    }

    // 2. Birdeye Token List (larger established/trending tokens)
    console.log('Fetching token list from Birdeye...');
    const birdeyeUrl = 'https://public-api.birdeye.so/defi/tokenlist?sort_by=mc&sort_type=desc&offset=0&limit=100';
    const birdeyeResponse = await fetch(birdeyeUrl, {
      headers: { 'X-API-KEY': BIRDEYE_API_KEY, 'x-chain': 'solana' }
    });
    
    if (birdeyeResponse.ok) {
      const birdeyeData = await birdeyeResponse.json();
      const birdeyeTokens = (birdeyeData.data?.tokens || []).slice(0, 50);
      
      for (const token of birdeyeTokens) {
        const mint = token.address;
        try {
          const txUrl = `https://api.helius.xyz/v0/addresses/${mint}/transactions?api-key=${HELIUS_API_KEY}&limit=50`;
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
          
          for (const wallet of wallets) {
            if (!walletScores[wallet]) {
              walletScores[wallet] = {
                address: wallet,
                earlyBuys: 0,
                totalTokens: 0,
                totalChangeBonus: 0,
                score: 0
              };
            }
            walletScores[wallet].totalTokens += 1;
            walletScores[wallet].totalChangeBonus += (token.priceChange?.h24 || 0 > 0 ? token.priceChange?.h24 || 0 : 0);
          }
          
          await new Promise(r => setTimeout(r, 500));
        } catch (err) {}
      }
    }

    // 3. Calculate Final Success Score
    Object.values(walletScores).forEach(w => {
      w.score = (w.earlyBuys * 10) + w.totalTokens + Math.floor(w.totalChangeBonus);
    });

    const discoveredWallets = Object.values(walletScores)
      .sort((a, b) => b.score - a.score)
      .slice(0, 20)
      .map((w, i) => ({
        rank: i + 1,
        address: w.address,
        successScore: w.score,
        earlyBuys: w.earlyBuys,
        totalTokensTraded: w.totalTokens,
        positiveChangeBonus: Math.floor(w.totalChangeBonus)
      }));

    res.json({
      success: true,
      discoveredWallets,
      totalWallets: Object.keys(walletScores).length,
      message: 'Merged DexScreener new pairs + Birdeye list with success scoring!',
      timestamp: new Date()
    });
    
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Other endpoints (dexscreener, wallet, home) unchanged

app.use(cors());
app.use(express.json());

loadTokenRegistry();

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});