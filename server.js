const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 3001;

// MUST be at the top
app.use(cors());
app.use(express.json());

const BIRDEYE_API_KEY = '73e8a243fd26414098b027317db6cbfd';
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
        change24h: pair.priceChange?.h24 || 0,
        volume24h: pair.volume?.h24 || 0,
        liquidity: pair.liquidity?.usd || 0,
        age: pair.pairCreatedAt ? Date.now() - pair.pairCreatedAt : null
      };
    }
  } catch (err) {}
  return { marketCap: 0, priceUsd: 0, change24h: 0, volume24h: 0, liquidity: 0, age: null };
}

// Helper function to get tier info
function getTierInfo(percentile) {
  if (percentile >= 95) return { tier: 'LEGENDARY', emoji: '👑', color: '#FFD700' };
  if (percentile >= 90) return { tier: 'ELITE', emoji: '💎', color: '#B9F2FF' };
  if (percentile >= 80) return { tier: 'EXPERT', emoji: '⚡', color: '#9D4EDD' };
  if (percentile >= 70) return { tier: 'ADVANCED', emoji: '🔥', color: '#FF6B35' };
  if (percentile >= 60) return { tier: 'SKILLED', emoji: '⭐', color: '#F72585' };
  if (percentile >= 50) return { tier: 'PROFICIENT', emoji: '📈', color: '#4361EE' };
  if (percentile >= 40) return { tier: 'COMPETENT', emoji: '✓', color: '#06D6A0' };
  if (percentile >= 30) return { tier: 'INTERMEDIATE', emoji: '↗', color: '#26C485' };
  if (percentile >= 20) return { tier: 'DEVELOPING', emoji: '📊', color: '#90E0EF' };
  return { tier: 'NOVICE', emoji: '🌱', color: '#ADB5BD' };
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

// DISCOVERY - With Percentile Ranking & Tier Badges
app.get('/api/discover', async (req, res) => {
  try {
    const tokenLimit = Math.min(parseInt(req.query.limit) || 50, 100);
    const topCount = Math.min(parseInt(req.query.top) || 20, 50);
    const minScore = parseInt(req.query.minScore) || 0;
    const minEarly = parseInt(req.query.minEarly) || 0;

    console.log('Starting discovery with limits:', { tokenLimit, topCount, minScore, minEarly });

    const walletScores = {};
    let tokensAnalyzed = 0;
    
    // SOURCE 1: DexScreener New Pairs
    console.log('Fetching from DexScreener...');
    try {
      const newPairsUrl = 'https://api.dexscreener.com/latest/dex/search?q=new&chain=solana';
      const newResponse = await fetch(newPairsUrl);
      const newData = await newResponse.json();
      
      const newTokens = (newData.pairs || [])
        .filter(p => p.chainId === 'solana')
        .slice(0, tokenLimit);
      
      console.log(`Found ${newTokens.length} new Solana pairs`);
      
      for (const token of newTokens) {
        const mintAddress = token.baseToken.address;
        const mcData = await getTokenMarketCap(mintAddress);
        
        try {
          const txUrl = `https://api.helius.xyz/v0/addresses/${mintAddress}/transactions?api-key=${HELIUS_API_KEY}&limit=50`;
          const txResponse = await fetch(txUrl);
          const transactions = await txResponse.json();
          
          if (!transactions || transactions.length === 0) continue;
          
          tokensAnalyzed++;
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
                rawScore: 0
              };
            }
            walletScores[wallet].earlyBuys += 1;
            walletScores[wallet].totalTokens += 1;
            walletScores[wallet].totalChangeBonus += (mcData.change24h > 0 ? mcData.change24h : 0);
          }
          
          await new Promise(r => setTimeout(r, 500));
        } catch (err) {
          console.error('Error processing token:', err.message);
        }
      }
    } catch (err) {
      console.error('DexScreener error:', err.message);
    }
    
    // SOURCE 2: Birdeye Token List
    console.log('Fetching from Birdeye...');
    try {
      const birdeyeUrl = `https://public-api.birdeye.so/defi/tokenlist?sort_by=mc&sort_type=desc&offset=0&limit=${tokenLimit}`;
      const birdeyeResponse = await fetch(birdeyeUrl, {
        headers: {
          'X-API-KEY': BIRDEYE_API_KEY,
          'x-chain': 'solana'
        }
      });
      
      if (birdeyeResponse.ok) {
        const birdeyeData = await birdeyeResponse.json();
        const birdeyeTokens = (birdeyeData.data?.tokens || []).slice(0, tokenLimit);
        
        console.log(`Found ${birdeyeTokens.length} Birdeye tokens`);
        
        for (const token of birdeyeTokens) {
          const mintAddress = token.address;
          
          try {
            const txUrl = `https://api.helius.xyz/v0/addresses/${mintAddress}/transactions?api-key=${HELIUS_API_KEY}&limit=50`;
            const txResponse = await fetch(txUrl);
            const transactions = await txResponse.json();
            
            if (!transactions || transactions.length === 0) continue;
            
            tokensAnalyzed++;
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
                  rawScore: 0
                };
              }
              walletScores[wallet].totalTokens += 1;
              const changeBonus = (token.v24hChangePercent || 0) > 0 ? (token.v24hChangePercent || 0) : 0;
              walletScores[wallet].totalChangeBonus += changeBonus;
            }
            
            await new Promise(r => setTimeout(r, 500));
          } catch (err) {
            console.error('Error processing Birdeye token:', err.message);
          }
        }
      }
    } catch (err) {
      console.error('Birdeye error:', err.message);
    }
    
    // Calculate raw scores
    Object.values(walletScores).forEach(w => {
      w.rawScore = (w.earlyBuys * 10) + w.totalTokens + Math.floor(w.totalChangeBonus);
    });
    
    // Apply filters
    let filteredWallets = Object.values(walletScores)
      .filter(w => w.rawScore >= minScore && w.earlyBuys >= minEarly);
    
    // Sort by raw score
    filteredWallets.sort((a, b) => b.rawScore - a.rawScore);
    
    // Calculate percentile scores (0-100)
    const maxScore = filteredWallets[0]?.rawScore || 1;
    const minScoreVal = filteredWallets[filteredWallets.length - 1]?.rawScore || 0;
    const scoreRange = maxScore - minScoreVal || 1;
    
    // Convert to final format with percentiles and tiers
    const discoveredWallets = filteredWallets
      .slice(0, topCount)
      .map((w, i) => {
        // Calculate percentile (0-100)
        const percentile = Math.round(((w.rawScore - minScoreVal) / scoreRange) * 100);
        const tierInfo = getTierInfo(percentile);
        
        return {
          rank: i + 1,
          address: w.address,
          
          // Percentile score (0-100)
          successScore: percentile,
          
          // Tier information
          tier: tierInfo.tier,
          badge: tierInfo.emoji,
          tierColor: tierInfo.color,
          
          // Raw metrics
          earlyBuys: w.earlyBuys,
          totalTokensTraded: w.totalTokens,
          positiveChangeBonus: Math.floor(w.totalChangeBonus),
          rawScore: w.rawScore
        };
      });
    
    console.log(`Discovery complete: ${discoveredWallets.length} wallets found`);
    
    res.json({
      success: true,
      discoveredWallets,
      
      // Summary stats
      totalWalletsBeforeFilter: Object.keys(walletScores).length,
      totalWalletsAfterFilter: filteredWallets.length,
      tokensAnalyzed,
      
      // Tier distribution
      tierDistribution: {
        legendary: discoveredWallets.filter(w => w.tier === 'LEGENDARY').length,
        elite: discoveredWallets.filter(w => w.tier === 'ELITE').length,
        expert: discoveredWallets.filter(w => w.tier === 'EXPERT').length,
        advanced: discoveredWallets.filter(w => w.tier === 'ADVANCED').length,
        skilled: discoveredWallets.filter(w => w.tier === 'SKILLED').length,
        other: discoveredWallets.filter(w => !['LEGENDARY', 'ELITE', 'EXPERT', 'ADVANCED', 'SKILLED'].includes(w.tier)).length
      },
      
      appliedFilters: { tokenLimit, topCount, minScore, minEarly },
      message: 'Scores are 0-100 percentile. 👑=Top 5%, 💎=Top 10%, ⚡=Top 20%. Use ?limit=100&top=50 for more wallets',
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
    status: 'LOW CAP HUNTER API - Multi-Source Discovery with Tier System',
    endpoints: {
      wallet: '/api/wallet/:address?maxMC=1000000&minRate=40&minTrades=3',
      discover: '/api/discover?limit=50&top=20&minScore=0&minEarly=0',
      dexscreener: '/api/dexscreener/:address'
    },
    tiers: {
      legendary: '👑 95-100% (Top 5%)',
      elite: '💎 90-95% (Top 10%)',
      expert: '⚡ 80-90% (Top 20%)',
      advanced: '🔥 70-80%',
      skilled: '⭐ 60-70%',
      proficient: '📈 50-60%',
      competent: '✓ 40-50%',
      intermediate: '↗ 30-40%',
      developing: '📊 20-30%',
      novice: '🌱 0-20%'
    },
    sources: ['DexScreener', 'Birdeye', 'Helius'],
    timestamp: new Date() 
  });
});

// Start server
loadTokenRegistry();

app.listen(PORT, '0.0.0.0', () => {
  console.log('LOW CAP HUNTER API running on port', PORT);
});