const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 3001;

const MORALIS_API_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJub25jZSI6ImEyMjUyZTcwLWQ1NGYtNDc2Zi04NzdlLTA1YmMzZjZkOGNmNSIsIm9yZ0lkIjoiNDg5MjY0IiwidXNlcklkIjoiNTAzMzkzIiwidHlwZUlkIjoiNTM5NmE0NmMtOGE3OC00NWI1LThlOWMtZDY0OTA4YmJjMWU2IiwidHlwZSI6IlBST0pFQ1QiLCJpYXQiOjE3Njc4NjI4NjMsImV4cCI6NDkyMzYyMjg2M30.YK8NJCVztDL39VYA1fMwyCL__3_lidUSFKbYFK8qcSQ'; // Your key for Moralis Pump.fun APIs
const HELIUS_API_KEY = 'a6f9ba84-1abf-4c90-8e04-fc0a61294407';

let tokenCache = {};

// Load token registry (unchanged)
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

// Get token metadata (unchanged)
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
    if (dexData && data.pairs && dexData.pairs[0]) {
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

// Get market cap (unchanged)
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

// AUTO-DISCOVERY WITH SOLANA CHAIN FILTER
app.get('/api/discover', async (req, res) => {
  try {
    const maxMarketCap = parseInt(req.query.maxMC) || 1000000;
    const minPumpPercent = parseInt(req.query.minPump) || 100;
    
    console.log('Starting REAL auto-discovery...');
    console.log('Filters: MC <', maxMarketCap, '| Pump >', minPumpPercent + '%');
    
    // Step 1: Find pumped tokens ON SOLANA CHAIN
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
        // CRITICAL FIX: Only get actual Solana chain tokens
        return pair.chainId === 'solana' &&
               change24h > minPumpPercent && 
               volume > 50000;
      })
      .slice(0, 3); // Top 3 pumped tokens
    
    console.log('Found', pumpedTokens.length, 'pumped Solana tokens');
    
    if (pumpedTokens.length === 0) {
      return res.json({
        success: true,
        discoveredWallets: [],
        analyzedTokens: 0,
        totalWalletsFound: 0,
        message: 'No Solana tokens found matching criteria. Try lowering minPump parameter.',
        filters: { maxMarketCap, minPumpPercent }
      });
    }
    
    // Step 2: Get REAL wallet addresses from token transactions
    const walletScores = {};
    
    for (const token of pumpedTokens) {
      const mintAddress = token.baseToken.address;
      console.log('Getting transactions for:', token.baseToken.symbol, '(' + mintAddress + ')');
      
      try {
        // Get transactions for this token
        const txUrl = `https://api.helius.xyz/v0/addresses/${mintAddress}/transactions?api-key=${HELIUS_API_KEY}&limit=50`;
        const txResponse = await fetch(txUrl);
        const transactions = await txResponse.json();
        
        if (!transactions || transactions.length === 0) {
          console.log('No transactions for', token.baseToken.symbol);
          continue;
        }
        
        console.log('Found', transactions.length, 'transactions for', token.baseToken.symbol);
        
        // Extract wallet addresses from transactions
        const wallets = new Set();
        
        for (const tx of transactions) {
          // Get wallets from token transfers
          if (tx.tokenTransfers) {
            for (const transfer of tx.tokenTransfers) {
              if (transfer.toUserAccount) wallets.add(transfer.toUserAccount);
              if (transfer.fromUserAccount) wallets.add(transfer.fromUserAccount);
            }
          }
          
          // Get wallets from account data
          if (tx.accountData) {
            for (const account of tx.accountData) {
              if (account.account) wallets.add(account.account);
            }
          }
        }
        
        console.log('Found', wallets.size, 'unique wallets for', token.baseToken.symbol);
        
        // Score these wallets
        for (const walletAddr of wallets) {
          if (!walletScores[walletAddr]) {
            walletScores[walletAddr] = {
              address: walletAddr,
              tokensFound: [],
              score: 0
            };
          }
          
          walletScores[walletAddr].score += Math.abs(token.priceChange.h24);
          walletScores[walletAddr].tokensFound.push({
            symbol: token.baseToken.symbol,
            pumpPercent: token.priceChange.h24
          });
        }
        
        await new Promise(r => setTimeout(r, 500)); // Rate limit
        
      } catch (err) {
        console.error('Error getting transactions for', token.baseToken.symbol, ':', err.message);
      }
    }
    
    // Step 3: Rank and return top wallets
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
    
    console.log('Discovery complete. Found', discoveredWallets.length, 'REAL wallets');
    
    res.json({
      success: true,
      discoveredWallets: discoveredWallets,
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

// NEW ENDPOINT: PUMPFUN TRACKING (new pairs -> graduation -> high MC -> early wallets -> next moves)
app.get('/api/pumpfun/track', async (req, res) => {
  try {
    const minMC = parseInt(req.query.minMC) || 1000000; // Min market cap for high-growth tokens (e.g., $1M+)

    console.log('Starting Pump.fun tracking...');
    console.log('Filter: Graduated tokens MC >', minMC);

    // Step 1: Get new Pump.fun tokens (from Moralis free API)
    const newTokensUrl = 'https://solana-gateway.moralis.io/token/mainnet/exchange/pumpfun/new?limit=20'; // Top 20 new launches
    const newResponse = await fetch(newTokensUrl, {
      headers: { 'X-API-Key': MORALIS_API_KEY }
    });
    const newTokens = await newResponse.json();

    if (!newTokens || newTokens.length === 0) {
      return res.json({ error: 'No new Pump.fun tokens found', graduatedTokens: [], successfulWallets: [] });
    }

    console.log('Found', newTokens.length, 'new Pump.fun tokens');

    // Step 2: Filter graduated tokens and check high MC
    const graduatedTokens = [];
    for (const token of newTokens) {
      // Get bonding status (graduation progress)
      const bondingUrl = `https://solana-gateway.moralis.io/token/mainnet/${token.mint}/bonding-status`;
      const bondingResponse = await fetch(bondingUrl, {
        headers: { 'X-API-Key': MORALIS_API_KEY }
      });
      const bonding = await bondingResponse.json();

      if (bonding.bondingComplete) { // Graduated
        // Check current MC with DexScreener
        const mcData = await getTokenMarketCap(token.mint);
        if (mcData.marketCap >= minMC) {
          graduatedTokens.push({
            mint: token.mint,
            symbol: token.symbol,
            name: token.name,
            marketCap: mcData.marketCap,
            graduatedAt: bonding.completedAt,
            launchAt: token.createdAt
          });
        }
      }

      await new Promise(r => setTimeout(r, 500)); // Rate limit
    }

    console.log('Found', graduatedTokens.length, 'graduated tokens with MC >', minMC);

    if (graduatedTokens.length === 0) {
      return res.json({ 
        success: true,
        graduatedTokens: [],
        successfulWallets: [],
        message: 'No graduated tokens found with high MC. Try lowering minMC.',
        filter: { minMC }
      });
    }

    // Step 3: Find early-buying wallets and score success
    const walletScores = {};

    for (const token of graduatedTokens) {
      console.log('Getting early buyers for:', token.symbol);
      
      try {
        // Get snipers/early buyers with Moralis (includes profits)
        const pairUrl = `https://api.dexscreener.com/latest/dex/tokens/${token.mint}`;
        const pairResponse = await fetch(pairUrl);
        const pairData = await pairResponse.json();
        const pairAddress = pairData.pairs[0]?.pairAddress || null;

        if (pairAddress) {
          const snipersUrl = `https://solana-gateway.moralis.io/token/mainnet/pairs/${pairAddress}/snipers?blocksAfterCreation=1000`;
          const snipersResponse = await fetch(snipersUrl, {
            headers: { 'X-API-Key': MORALIS_API_KEY }
          });
          const snipers = await snipersResponse.json();

          if (snipers.result) {
            for (const sniper of snipers.result) {
              const walletAddr = sniper.walletAddress;
              if (!walletScores[walletAddr]) {
                walletScores[walletAddr] = {
                  address: walletAddr,
                  tokensBought: [],
                  totalProfits: 0,
                  winRate: 0,
                  buys: 0
                };
              }
              
              const profitUsd = sniper.realizedProfitUsd || 0;
              const profitPercent = sniper.realizedProfitPercentage || 0;
              walletScores[walletAddr].totalProfits += profitUsd;
              walletScores[walletAddr].buys += 1;
              walletScores[walletAddr].winRate = (walletScores[walletAddr].winRate + profitPercent) / walletScores[walletAddr].buys;
              
              walletScores[walletAddr].tokensBought.push({
                symbol: token.symbol,
                profitUsd: profitUsd,
                profitPercent: profitPercent,
                buyTime: sniper.buyTime
              });
            }
          }
        } else {
          // Fallback to Helius for transactions
          const txUrl = `https://api.helius.xyz/v0/addresses/${token.mint}/transactions?api-key=${HELIUS_API_KEY}&limit=50`;
          const txResponse = await fetch(txUrl);
          const transactions = await txResponse.json();

          const wallets = new Set();
          transactions.forEach(tx => {
            tx.tokenTransfers?.forEach(transfer => {
              if (transfer.fromUserAccount) wallets.add(transfer.fromUserAccount);
            });
          });

          for (const walletAddr of wallets) {
            if (!walletScores[walletAddr]) {
              walletScores[walletAddr] = {
                address: walletAddr,
                tokensBought: [],
                totalProfits: 0,
                winRate: 0,
                buys: 0
              };
            }
            walletScores[walletAddr].tokensBought.push({ symbol: token.symbol });
            walletScores[walletAddr].buys += 1;
          }
        }

        await new Promise(r => setTimeout(r, 500));
      } catch (err) {
        console.error('Error for', token.symbol, ':', err.message);
      }
    }

    // Step 4: Score and filter successful traders (win rate >50%, profits >$1K, multiple buys)
    const successfulWallets = Object.values(walletScores)
      .filter(w => w.buys >= 3 && w.winRate > 50 && w.totalProfits > 1000)
      .sort((a, b) => b.totalProfits - a.totalProfits)
      .slice(0, 20)
      .map((wallet, index) => ({
        rank: index + 1,
        address: wallet.address,
        totalProfits: wallet.totalProfits,
        winRate: Math.floor(wallet.winRate),
        buys: wallet.buys,
        tokensBought: wallet.tokensBought,
        nextMoves: 'Track via /api/wallet/:address for recent swaps' // Placeholder - expand if needed
      }));

    console.log('Found', successfulWallets.length, 'successful early buyers');

    res.json({
      success: true,
      graduatedTokens: graduatedTokens,
      successfulWallets: successfulWallets,
      analyzedNewTokens: newTokens.length,
      filter: { minMC },
      timestamp: new Date()
    });

  } catch (error) {
    console.error('Pump.fun tracking error:', error);
    res.status(500).json({ error: error.message });
  }
});

// DEXSCREENER (unchanged)
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

// HOME (added new endpoint)
app.get('/', (req, res) => {
  res.json({ 
    status: 'Memecoin Tracker API is running', 
    timestamp: new Date(),
    uptime: process.uptime(),
    endpoints: {
      discover: '/api/discover?minPump=100',
      wallet: '/api/wallet/:address?minTrades=3',
      dexscreener: '/api/dexscreener/:address',
      pumpfun_track: '/api/pumpfun/track?minMC=1000000' // New!
    }
  });
});

// Start server
app.use(cors());
app.use(express.json());

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});