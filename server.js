const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

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

// Helper functions (kept for backward compatibility but not used in discovery)
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

// ANALYZE WALLET
app.get('/api/wallet/:address', async (req, res) => {
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

// AUTO-DISCOVERY - FIXED VERSION WITH REAL WALLET ADDRESSES
app.get('/api/discover', async (req, res) => {
  try {
    const maxMarketCap = parseInt(req.query.maxMC) || 1000000;
    const minPumpPercent = parseInt(req.query.minPump) || 100;
    const limit = parseInt(req.query.limit) || 10; // How many wallets to return
    
    console.log('Starting REAL auto-discovery...');
    console.log('Filters: MC <', maxMarketCap, '| Pump >', minPumpPercent + '%');
    
    // Step 1: Find tokens that recently pumped
    const searchUrl = 'https://api.dexscreener.com/latest/dex/search?q=solana';
    const searchResponse = await fetch(searchUrl);
    const searchData = await searchResponse.json();
    
    if (!searchData || !searchData.pairs) {
      return res.json({ 
        error: 'No tokens found', 
        discoveredWallets: []
      });
    }
    
    const pumpedTokens = searchData.pairs
      .filter(pair => {
        const change24h = pair.priceChange?.h24 || 0;
        const volume = pair.volume?.h24 || 0;
        return change24h > minPumpPercent && volume > 50000;
      })
      .slice(0, 3); // Analyze top 3 pumped tokens
    
    console.log('Found', pumpedTokens.length, 'pumped tokens');
    
    // Step 2: For each token, get REAL early buyer wallets
    const walletScores = {}; // Track wallets across multiple tokens
    
    for (const token of pumpedTokens) {
      const mintAddress = token.baseToken.address;
      console.log('Analyzing token:', token.baseToken.symbol, mintAddress);
      
      try {
        // Get token's transaction signatures
        const sigUrl = `https://api.helius.xyz/v0/addresses/${mintAddress}/transactions?api-key=${HELIUS_API_KEY}&limit=50`;
        const sigResponse = await fetch(sigUrl);
        const transactions = await sigResponse.json();
        
        if (!transactions || transactions.length === 0) {
          console.log('No transactions found for', token.baseToken.symbol);
          continue;
        }
        
        console.log('Found', transactions.length, 'transactions for', token.baseToken.symbol);
        
        // Step 3: Extract buyer wallets from transactions
        const buyers = new Set();
        
        for (const tx of transactions) {
          // Look for swap transactions
          if (tx.type === 'SWAP' || (tx.tokenTransfers && tx.tokenTransfers.length > 0)) {
            
            // Find wallets that received this token (buyers)
            if (tx.tokenTransfers) {
              for (const transfer of tx.tokenTransfers) {
                if (transfer.mint === mintAddress && 
                    transfer.toUserAccount && 
                    transfer.toUserAccount !== mintAddress) {
                  buyers.add(transfer.toUserAccount);
                }
              }
            }
            
            // Also check account data
            if (tx.accountData) {
              for (const account of tx.accountData) {
                if (account.account && account.account !== mintAddress) {
                  buyers.add(account.account);
                }
              }
            }
          }
        }
        
        console.log('Found', buyers.size, 'unique buyers for', token.baseToken.symbol);
        
        // Step 4: Score these wallets
        for (const walletAddr of buyers) {
          if (!walletScores[walletAddr]) {
            walletScores[walletAddr] = {
              address: walletAddr,
              tokensFound: [],
              score: 0
            };
          }
          
          // Add points for finding wallet in a pumped token
          walletScores[walletAddr].score += Math.floor(token.priceChange.h24);
          walletScores[walletAddr].tokensFound.push({
            symbol: token.baseToken.symbol,
            pumpPercent: token.priceChange.h24,
            volume: token.volume.h24
          });
        }
        
        // Rate limiting
        await new Promise(r => setTimeout(r, 500));
        
      } catch (err) {
        console.error('Error analyzing token', token.baseToken.symbol, ':', err.message);
      }
    }
    
    // Step 5: Rank wallets by score and return top performers
    const rankedWallets = Object.values(walletScores)
      .filter(w => w.tokensFound.length >= 1) // Must have traded at least 1 pumped token
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((wallet, index) => ({
        rank: index + 1,
        address: wallet.address,
        score: wallet.score,
        tokensFound: wallet.tokensFound,
        discoveredFrom: wallet.tokensFound.map(t => t.symbol).join(', '),
        avgPump: Math.floor(wallet.tokensFound.reduce((sum, t) => sum + t.pumpPercent, 0) / wallet.tokensFound.length),
        discoveredAt: new Date().toISOString()
      }));
    
    console.log('Discovery complete. Found', rankedWallets.length, 'REAL wallets');
    
    res.json({
      success: true,
      discoveredWallets: rankedWallets,
      analyzedTokens: pumpedTokens.length,
      totalWalletsScanned: Object.keys(walletScores).length,
      filters: { maxMarketCap, minPumpPercent },
      timestamp: new Date()
    });
    
  } catch (error) {
    console.error('Discovery error:', error);
    res.status(500).json({ error: error.message });
  }
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
    status: 'LOW CAP HUNTER API - REAL Wallet Discovery',
    endpoints: {
      wallet: '/api/wallet/:address?maxMC=1000000&minRate=40&minTrades=3',
      discover: '/api/discover?maxMC=1000000&minPump=100&limit=10',
      dexscreener: '/api/dexscreener/:address'
    },
    timestamp: new Date() 
  });
});

// Start server
loadTokenRegistry();

app.listen(PORT, '0.0.0.0', () => {
  console.log('LOW CAP HUNTER API running on port', PORT);
});