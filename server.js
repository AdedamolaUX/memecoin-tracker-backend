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

// IMPROVED DISCOVERY ENDPOINT WITH SMART SCORING
app.get('/api/discover', async (req, res) => {
  try {
    const tokenLimit = Math.min(parseInt(req.query.limit) || 50, 100);
    const topCount = Math.min(parseInt(req.query.top) || 20, 50);
    const minScore = parseInt(req.query.minScore) || 0;

    console.log('=== IMPROVED DISCOVERY STARTING ===');

    const walletScores = {};
    const tokenData = {}; // Store token info for success tracking
    let tokensAnalyzed = 0;
    
    // SOURCE 1: DexScreener New Pairs (catch early opportunities)
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
        
        // Store token data for success tracking
        tokenData[mintAddress] = {
          symbol: token.baseToken.symbol,
          initialMC: token.fdv || token.marketCap || 0,
          currentMC: token.fdv || token.marketCap || 0,
          change24h: token.priceChange?.h24 || 0,
          volume24h: token.volume?.h24 || 0,
          createdAt: token.pairCreatedAt || Date.now()
        };
        
        try {
          const txUrl = `https://api.helius.xyz/v0/addresses/${mintAddress}/transactions?api-key=${HELIUS_API_KEY}&limit=200`;
          const txResponse = await fetch(txUrl);
          const transactions = await txResponse.json();
          
          if (!transactions || transactions.length === 0) continue;
          
          tokensAnalyzed++;
          
          // SMART ANALYSIS: Track buy order and timing
          const buyerTimestamps = new Map(); // wallet -> earliest buy timestamp
          const totalBuyers = new Set();
          
          // First pass: collect all buyers with timestamps
          for (const tx of transactions) {
            if (tx.tokenTransfers) {
              for (const transfer of tx.tokenTransfers) {
                if (transfer.mint === mintAddress && transfer.toUserAccount) {
                  const wallet = transfer.toUserAccount;
                  totalBuyers.add(wallet);
                  
                  if (!buyerTimestamps.has(wallet)) {
                    buyerTimestamps.set(wallet, tx.timestamp);
                  }
                }
              }
            }
          }
          
          // Sort buyers by timestamp to find early entries
          const sortedBuyers = Array.from(buyerTimestamps.entries())
            .sort((a, b) => a[1] - b[1]);
          
          const totalBuyerCount = sortedBuyers.length;
          
          // Second pass: Score wallets based on entry position
          sortedBuyers.forEach(([wallet, timestamp], index) => {
            if (!walletScores[wallet]) {
              walletScores[wallet] = {
                address: wallet,
                earlyEntryScore: 0,
                successScore: 0,
                consistencyScore: 0,
                recencyScore: 0,
                totalTokens: 0,
                earlyBuyCount: 0,
                lastActivity: 0,
                tokensFound: [],
                totalScore: 0
              };
            }
            
            const w = walletScores[wallet];
            w.totalTokens += 1;
            w.lastActivity = Math.max(w.lastActivity, timestamp);
            
            // EARLY ENTRY SCORING (40% weight)
            const position = index + 1;
            const positionPercentile = (position / totalBuyerCount) * 100;
            
            let earlyPoints = 0;
            if (positionPercentile <= 5) {
              earlyPoints = 10; // Top 5% of buyers
              w.earlyBuyCount += 1;
            } else if (positionPercentile <= 10) {
              earlyPoints = 7; // Top 10%
              w.earlyBuyCount += 1;
            } else if (positionPercentile <= 20) {
              earlyPoints = 4; // Top 20%
            } else if (positionPercentile <= 50) {
              earlyPoints = 1; // Top 50%
            }
            
            w.earlyEntryScore += earlyPoints;
            
            // SUCCESS SCORING (30% weight)
            // Did this token pump after they bought?
            const tokenPerformance = tokenData[mintAddress].change24h;
            if (tokenPerformance > 100) {
              w.successScore += 15; // 100%+ gain
            } else if (tokenPerformance > 50) {
              w.successScore += 10; // 50-100% gain
            } else if (tokenPerformance > 20) {
              w.successScore += 5; // 20-50% gain
            } else if (tokenPerformance > 0) {
              w.successScore += 2; // Positive gain
            }
            
            // Track this token
            w.tokensFound.push({
              symbol: tokenData[mintAddress].symbol,
              position: position,
              totalBuyers: totalBuyerCount,
              performance: tokenPerformance,
              earlyEntry: earlyPoints > 0
            });
          });
          
          await new Promise(r => setTimeout(r, 500));
        } catch (err) {
          console.error('Error processing token:', err.message);
        }
      }
    } catch (err) {
      console.error('DexScreener error:', err.message);
    }
    
    // SOURCE 2: Birdeye Token List (established tokens)
    console.log('Fetching from Birdeye...');
    try {
      const birdeyeUrl = `https://public-api.birdeye.so/defi/tokenlist?sort_by=v24hChangePercent&sort_type=desc&offset=0&limit=${tokenLimit}`;
      const birdeyeResponse = await fetch(birdeyeUrl, {
        headers: {
          'X-API-KEY': BIRDEYE_API_KEY,
          'x-chain': 'solana'
        }
      });
      
      if (birdeyeResponse.ok) {
        const birdeyeData = await birdeyeResponse.json();
        const birdeyeTokens = (birdeyeData.data?.tokens || [])
          .filter(t => (t.v24hChangePercent || 0) > 10) // Only pumping tokens
          .slice(0, Math.floor(tokenLimit / 2));
        
        console.log(`Found ${birdeyeTokens.length} pumping Birdeye tokens`);
        
        for (const token of birdeyeTokens) {
          const mintAddress = token.address;
          
          tokenData[mintAddress] = {
            symbol: token.symbol,
            currentMC: token.mc || 0,
            change24h: token.v24hChangePercent || 0,
            volume24h: token.v24hUSD || 0
          };
          
          try {
            const txUrl = `https://api.helius.xyz/v0/addresses/${mintAddress}/transactions?api-key=${HELIUS_API_KEY}&limit=100`;
            const txResponse = await fetch(txUrl);
            const transactions = await txResponse.json();
            
            if (!transactions || transactions.length === 0) continue;
            
            tokensAnalyzed++;
            
            // Similar analysis for Birdeye tokens
            for (const tx of transactions) {
              if (tx.tokenTransfers) {
                for (const transfer of tx.tokenTransfers) {
                  if (transfer.mint === mintAddress && transfer.toUserAccount) {
                    const wallet = transfer.toUserAccount;
                    
                    if (walletScores[wallet]) {
                      walletScores[wallet].successScore += 5; // Bonus for being in multiple pumping tokens
                      walletScores[wallet].totalTokens += 1;
                    }
                  }
                }
              }
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
    
    // CALCULATE FINAL SCORES
    const now = Date.now() / 1000;
    Object.values(walletScores).forEach(w => {
      // CONSISTENCY SCORING (20% weight)
      if (w.totalTokens >= 5) w.consistencyScore = 20;
      else if (w.totalTokens >= 3) w.consistencyScore = 15;
      else if (w.totalTokens >= 2) w.consistencyScore = 10;
      else w.consistencyScore = 5;
      
      // Bonus for multiple early entries
      if (w.earlyBuyCount >= 3) w.consistencyScore += 10;
      
      // RECENCY SCORING (10% weight)
      const daysSinceLastActivity = (now - w.lastActivity) / 86400;
      if (daysSinceLastActivity <= 1) {
        w.recencyScore = 10; // Active today
      } else if (daysSinceLastActivity <= 7) {
        w.recencyScore = 7; // Active this week
      } else if (daysSinceLastActivity <= 30) {
        w.recencyScore = 4; // Active this month
      } else {
        w.recencyScore = 1; // Inactive
      }
      
      // TOTAL SCORE (weighted sum)
      w.totalScore = 
        (w.earlyEntryScore * 0.4) + 
        (w.successScore * 0.3) + 
        (w.consistencyScore * 0.2) + 
        (w.recencyScore * 0.1);
    });
    
    // QUALITY FILTERS
    let filteredWallets = Object.values(walletScores).filter(w => {
      // Remove likely bots (too many trades)
      if (w.totalTokens > 100) return false;
      
      // Require minimum diversity
      if (w.totalTokens < 2) return false;
      
      // Require recent activity (last 30 days)
      const daysSinceActive = (now - w.lastActivity) / 86400;
      if (daysSinceActive > 30) return false;
      
      // Must meet minimum score
      if (w.totalScore < minScore) return false;
      
      return true;
    });
    
    // Sort by total score
    filteredWallets.sort((a, b) => b.totalScore - a.totalScore);
    
    // Calculate percentiles for UI display
    const maxScore = filteredWallets[0]?.totalScore || 1;
    const minScoreVal = filteredWallets[filteredWallets.length - 1]?.totalScore || 0;
    const scoreRange = maxScore - minScoreVal || 1;
    
    // Convert to final format
    const discoveredWallets = filteredWallets
      .slice(0, topCount)
      .map((w, i) => {
        const percentile = Math.round(((w.totalScore - minScoreVal) / scoreRange) * 100);
        const tierInfo = getTierInfo(percentile);
        
        return {
          rank: i + 1,
          address: w.address,
          
          // Overall score
          successScore: percentile,
          totalScore: Math.round(w.totalScore),
          
          // Tier
          tier: tierInfo.tier,
          badge: tierInfo.emoji,
          tierColor: tierInfo.color,
          
          // Detailed breakdown
          earlyEntryScore: Math.round(w.earlyEntryScore),
          successRateScore: Math.round(w.successScore),
          consistencyScore: Math.round(w.consistencyScore),
          recencyScore: Math.round(w.recencyScore),
          
          // Stats
          earlyBuys: w.earlyBuyCount,
          totalTokensTraded: w.totalTokens,
          daysSinceActive: Math.round((now - w.lastActivity) / 86400),
          tokensFound: w.tokensFound.slice(0, 5) // Top 5 tokens
        };
      });
    
    console.log(`=== DISCOVERY COMPLETE ===`);
    console.log(`Found ${discoveredWallets.length} high-quality wallets`);
    
    res.json({
      success: true,
      discoveredWallets,
      
      stats: {
        totalWalletsScanned: Object.keys(walletScores).length,
        walletsAfterFilters: filteredWallets.length,
        tokensAnalyzed: tokensAnalyzed,
        averageScore: discoveredWallets.length > 0 ? Math.round(discoveredWallets.reduce((sum, w) => sum + w.totalScore, 0) / discoveredWallets.length) : 0
      },
      
      tierDistribution: {
        legendary: discoveredWallets.filter(w => w.tier === 'LEGENDARY').length,
        elite: discoveredWallets.filter(w => w.tier === 'ELITE').length,
        expert: discoveredWallets.filter(w => w.tier === 'EXPERT').length,
        advanced: discoveredWallets.filter(w => w.tier === 'ADVANCED').length,
        skilled: discoveredWallets.filter(w => w.tier === 'SKILLED').length,
        other: discoveredWallets.filter(w => !['LEGENDARY', 'ELITE', 'EXPERT', 'ADVANCED', 'SKILLED'].includes(w.tier)).length
      },
      
      scoringBreakdown: {
        earlyEntry: '40% - Position in buy order (top 5% = 10pts)',
        successRate: '30% - Did tokens pump after entry',
        consistency: '20% - Number of different tokens',
        recency: '10% - How recently active'
      },
      
      appliedFilters: {
        tokenLimit,
        topCount,
        minScore,
        removedBots: 'Wallets with >100 trades removed',
        removedInactive: 'Wallets inactive >30 days removed',
        minTokens: 'Minimum 2 different tokens required'
      },
      
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
    status: 'LOW CAP HUNTER API - Improved Smart Discovery',
    version: '2.0',
    endpoints: {
      wallet: '/api/wallet/:address?maxMC=1000000&minRate=40&minTrades=3',
      discover: '/api/discover?limit=50&top=20&minScore=0',
      dexscreener: '/api/dexscreener/:address'
    },
    improvements: {
      smartScoring: 'Weighted algorithm: Early Entry 40%, Success 30%, Consistency 20%, Recency 10%',
      positionTracking: 'Analyzes buy order position (1st, 50th, 200th buyer)',
      botFiltering: 'Removes wallets with >100 trades and inactive wallets',
      successTracking: 'Verifies if early entries actually pumped'
    },
    tiers: {
      legendary: '👑 95-100% (Top 5%)',
      elite: '💎 90-95% (Top 10%)',
      expert: '⚡ 80-90% (Top 20%)',
      advanced: '🔥 70-80%',
      skilled: '⭐ 60-70%'
    },
    sources: ['DexScreener', 'Birdeye', 'Helius'],
    timestamp: new Date() 
  });
});

// Start server
loadTokenRegistry();

app.listen(PORT, '0.0.0.0', () => {
  console.log('LOW CAP HUNTER API v2.0 - Improved Algorithm running on port', PORT);
});