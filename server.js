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
        age: pair.pairCreatedAt ? Date.now() - new Date(pair.pairCreatedAt).getTime() : null
      };
    }
  } catch (err) {
    console.log('Market cap fetch failed:', err.message);
  }
  return { marketCap: 0, priceUsd: 0, liquidity: 0, age: null };
}

// Helper functions (unchanged)
function generateSolanaAddress() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz123456789';
  let result = '';
  for (let i = 0; i < 44; i++) {
    result += chars[Math.floor(Math.random() * chars.length)];
  }
  return result;
}

function generateWalletName() {
  const adj = ['Smart', 'Quick', 'Diamond', 'Alpha', 'Stealth', 'Shadow', 'Lightning'];
  const noun = ['Whale', 'Sniper', 'Hunter', 'Trader', 'Wolf', 'Eagle', 'Fox'];
  return adj[Math.floor(Math.random() * adj.length)] + 
         noun[Math.floor(Math.random() * noun.length)] + 
         Math.floor(Math.random() * 999);
}

function findCommonTokensInWallets(wallets) {
  if (wallets.length === 0) return [];
  
  const allSymbols = wallets[0].tokensFound.map(t => t.symbol);
  const common = allSymbols.filter(symbol => 
    wallets.every(w => w.tokensFound.some(t => t.symbol === symbol))
  );
  
  return common;
}

// ANALYZE WALLET (unchanged)
app.get('/api/wallet/:address', async (req, res) => {
  // ... (exact same as your current code - no changes needed here)
  try {
    const { address } = req.params;
    
    const maxMarketCap = parseInt(req.query.maxMC) || 1000000;
    const minSuccessRate = parseInt(req.query.minRate) || 40;
    const minLowCapTrades = parseInt(req.query.minTrades) || 3;
    
    console.log('Analyzing wallet:', address);
    console.log('Filters: MC <', maxMarketCap, 'Rate >', minSuccessRate + '%', 'Trades >', minLowCapTrades);
    
    const url = `https://api.helius.xyz/v0/addresses/${address}/transactions?api-key=${HELIUS_API_KEY}&limit=100`;
    const response = await fetch(url);
    const transactions = await response.json();
    
    if (!transactions || transactions.length === 0) {
      return res.json({
        address,
        isEarlyEntrySpecialist: false,
        lowCapEntries: 0,
        totalTrades: 0,
        earlyEntryRate: 0,
        successfulLowCapExits: 0,
        filters: { maxMarketCap, minSuccessRate, minLowCapTrades },
        error: 'No transactions found'
      });
    }
    
    const swaps = transactions.filter(tx => 
      tx.type === 'SWAP' || (tx.tokenTransfers && tx.tokenTransfers.length > 0)
    );
    
    const tokenSet = new Set();
    const tokenEntries = {};
    
    for (const tx of swaps) {
      if (tx.tokenTransfers) {
        for (const transfer of tx.tokenTransfers) {
          if (transfer.mint && transfer.mint !== 'So11111111111111111111111111111111111111112') {
            tokenSet.add(transfer.mint);
            if (!tokenEntries[transfer.mint]) {
              tokenEntries[transfer.mint] = { firstSeen: tx.timestamp, address: transfer.mint };
            }
          }
        }
      }
    }
    
    console.log('Found', tokenSet.size, 'unique tokens');
    
    let lowCapEntries = 0;
    let successfulLowCapTrades = 0;
    const analyzedTokens = [];
    
    const recentTokens = Array.from(tokenSet).slice(0, 5);
    
    for (const tokenAddr of recentTokens) {
      const metadata = await getTokenMetadata(tokenAddr);
      const mcData = await getTokenMarketCap(tokenAddr);
      
      const meetsLowCapCriteria = mcData.marketCap < maxMarketCap && mcData.marketCap > 0;
      const isVeryNew = mcData.age && mcData.age < 7 * 24 * 60 * 60 * 1000;
      
      if (meetsLowCapCriteria || isVeryNew) {
        lowCapEntries++;
        if (mcData.marketCap > maxMarketCap * 10) {
          successfulLowCapTrades++;
        }
      }
      
      analyzedTokens.push({
        address: tokenAddr,
        symbol: metadata.symbol,
        name: metadata.name,
        currentMC: mcData.marketCap,
        meetsFilter: meetsLowCapCriteria,
        isNew: isVeryNew,
        firstTradedBy: new Date(tokenEntries[tokenAddr].firstSeen * 1000).toISOString()
      });
      
      await new Promise(r => setTimeout(r, 300));
    }
    
    const earlyEntryRate = swaps.length > 0 ? Math.floor((lowCapEntries / Math.min(swaps.length, 20)) * 100) : 0;
    const isSpecialist = lowCapEntries >= minLowCapTrades && earlyEntryRate >= minSuccessRate;
    
    const analysis = {
      address,
      isEarlyEntrySpecialist: isSpecialist,
      lowCapEntries: lowCapEntries,
      totalTrades: swaps.length,
      earlyEntryRate: earlyEntryRate,
      successfulLowCapExits: successfulLowCapTrades,
      score: Math.min(100, lowCapEntries * 20 + earlyEntryRate),
      analyzedTokens: analyzedTokens,
      lastActive: transactions[0]?.timestamp || Math.floor(Date.now() / 1000),
      specialistBadge: isSpecialist ? 'EARLY ENTRY SPECIALIST' : null,
      filters: {
        maxMarketCap,
        minSuccessRate,
        minLowCapTrades
      }
    };
    
    console.log('Result:', isSpecialist ? 'SPECIALIST' : 'Regular', '| Low cap:', lowCapEntries, '| Rate:', earlyEntryRate + '%');
    
    res.json(analysis);
    
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: error.message });
  }
});

// AUTO-DISCOVERY WITH DEXSCREENER (Free & Reliable for Pumping Tokens)
app.get('/api/discover', async (req, res) => {
  try {
    const maxMarketCap = parseInt(req.query.maxMC) || 1000000;
    const minPumpPercent = parseInt(req.query.minPump) || 100;
    
    console.log('Starting auto-discovery with DexScreener...');
    console.log('Filters: MC <', maxMarketCap, '| Pump >', minPumpPercent + '%');
    
    // Step 1: Search DexScreener for pumping Solana tokens
    const searchUrl = 'https://api.dexscreener.com/latest/dex/search?q=solana';
    const searchResponse = await fetch(searchUrl);
    const searchData = await searchResponse.json();
    
    if (!searchData || !searchData.pairs || searchData.pairs.length === 0) {
      return res.json({ 
        error: 'No pairs found on DexScreener', 
        discoveredWallets: []
      });
    }
    
    const pumpedTokens = searchData.pairs
      .filter(pair => pair.chainId === 'solana' &&
        pair.priceChange?.h24 > minPumpPercent &&
        pair.volume?.h24 > 50000)
      .slice(0, 3); // Top 3 pumped
    
    console.log('Found', pumpedTokens.length, 'pumped Solana tokens');
    
    if (pumpedTokens.length === 0) {
      return res.json({
        success: true,
        discoveredWallets: [],
        analyzedTokens: 0,
        totalWalletsFound: 0,
        message: 'No pumping tokens found. Try lowering minPump (e.g., ?minPump=50).',
        filters: { maxMarketCap, minPumpPercent }
      });
    }
    
    // Step 2-3: Same Helius wallet logic (unchanged)
    const walletScores = {};
    
    for (const pair of pumpedTokens) {
      const mintAddress = pair.baseToken.address;
      console.log('Getting transactions for:', pair.baseToken.symbol, '(' + mintAddress + ')');
      
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
          if (tx.accountData) {
            for (const account of tx.accountData) {
              if (account.account) wallets.add(account.account);
            }
          }
        }
        
        for (const walletAddr of wallets) {
          if (!walletScores[walletAddr]) {
            walletScores[walletAddr] = { address: walletAddr, tokensFound: [], score: 0 };
          }
          walletScores[walletAddr].score += Math.abs(pair.priceChange.h24);
          walletScores[walletAddr].tokensFound.push({
            symbol: pair.baseToken.symbol,
            pumpPercent: pair.priceChange.h24
          });
        }
        
        await new Promise(r => setTimeout(r, 500));
      } catch (err) {
        console.error('Error:', err.message);
      }
    }
    
    const discoveredWallets = Object.values(walletScores)
      .filter(w => w.tokensFound.length >= 1)
      .sort((a, b) => b.score - a.score)
      .slice(0, 10)
      .map((wallet, index) => ({
        rank: index + 1,
        address: wallet.address,
        score: Math.floor(wallet.score),
        tokensFound: wallet.tokensFound,
        discoveredFrom: wallet.tokensFound.map(t => t.symbol).join(', '),
        discoveredAt: new Date().toISOString()
      }));
    
    res.json({
      success: true,
      discoveredWallets,
      analyzedTokens: pumpedTokens.length,
      totalWalletsFound: Object.keys(walletScores).length,
      filters: { maxMarketCap, minPumpPercent },
      timestamp: new Date()
    });
    
  } catch (error) {
    console.error('Discovery error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Keep your other endpoints unchanged
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

app.get('/', (req, res) => {
  res.json({ 
    status: 'LOW CAP HUNTER API - Now with DexScreener pumping detection!',
    endpoints: {
      wallet: '/api/wallet/:address?maxMC=1000000&minRate=40&minTrades=3',
      discover: '/api/discover?minPump=100',
      dexscreener: '/api/dexscreener/:address'
    },
    timestamp: new Date() 
  });
});

app.use(cors());
app.use(express.json());

loadTokenRegistry();

app.listen(PORT, '0.0.0.0', () => {
  console.log('LOW CAP HUNTER API running on port', PORT);
});