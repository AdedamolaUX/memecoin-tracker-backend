const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

const BIRDEYE_API_KEY = '73e8a243fd26414098b027317db6cbfd';
const HELIUS_API_KEY = 'a6f9ba84-1abf-4c90-8e04-fc0a61294407';

let tokenCache = {};

// BLACKLIST: Known institutional wallets and DEX contracts
const BLACKLISTED_WALLETS = new Set([
  // Jupiter Aggregator
  'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',
  'JUP4Fb2cqiRUcaTHdrPC8h2gNsA2ETXiPDD33WcGuJB',
  
  // Raydium
  '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',
  '5Q544fKrFoe6tsEbD7S8EmEunGAV1gnGo',
  
  // Orca
  'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc',
  
  // OKX
  'AC5RDfQFmDS1deWZos921JfqscXdByf8BKHs5ACWjtL',
  
  // Binance
  'GJRs4FRmzQ4G1hPqD1ZBNkq3FHhT4JNSB6pvPEKsxz',
  '2ojv9BAiHUrvsm9gxDe7fJSzbNZSJcxZvf8dqmWGHG8S',
  
  // Pump.fun program
  '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
  
  // Known bot addresses (add more as you find them)
  'BQ2NZhb4zJq5eJgzTt8HiXXJYAKKYgLnVcWVSN7LMG4s',
  '5tzFkiKscXHK5ZXCGbeyPaFsqX4RZCNfxMqGdqPfFv1',
]);

// BOT DETECTION: Check if wallet behaves like a bot
function isLikelyBot(walletData) {
  // Too many trades (high frequency)
  if (walletData.totalTokens > 50) return true;
  
  // Only trades one token (likely sniper bot)
  if (walletData.totalTokens === 1 && walletData.tokensFound.length === 1) return true;
  
  // All trades are in first position (bot sniper)
  const allFirstPosition = walletData.tokensFound.every(t => t.position <= 3);
  if (allFirstPosition && walletData.tokensFound.length > 3) return true;
  
  // Very recent wallet (created just to snipe)
  const daysSinceActive = (Date.now() / 1000 - walletData.lastActivity) / 86400;
  if (daysSinceActive < 1 && walletData.totalTokens > 10) return true;
  
  return false;
}

// Check if address looks like a program/contract
function isProgramAddress(address) {
  // Solana programs typically end in specific patterns
  // This is a heuristic - not perfect but helps
  const programPatterns = [
    /pump$/i,     // pump.fun contracts
    /111111/,     // System program patterns
    /AToken/,     // Associated token patterns
  ];
  
  return programPatterns.some(pattern => pattern.test(address));
}

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

app.get('/api/wallet/:address', async (req, res) => {
  try {
    const { address } = req.params;
    
    const maxMarketCap = parseInt(req.query.maxMC) || 1000000;
    const minSuccessRate = parseInt(req.query.minRate) || 40;
    const minLowCapTrades = parseInt(req.query.minTrades) || 3;
    
    console.log('Analyzing wallet:', address);
    
    const url = `https://api.helius.xyz/v0/addresses/${address}/transactions?api-key=${HELIUS_API_KEY}&limit=100`;
    const response = await fetch(url);
    const transactions = await response.json();
    
    if (!Array.isArray(transactions)) {
      console.error('Helius error:', transactions);
      return res.json({
        address,
        error: 'Failed to fetch transactions from Helius: ' + (transactions.error || 'Unknown error')
      });
    }
    
    if (transactions.length === 0) {
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
    
    res.json({
      address,
      isEarlyEntrySpecialist: isSpecialist,
      lowCapEntries,
      totalTrades: swaps.length,
      earlyEntryRate,
      successfulLowCapExits: successfulLowCapTrades,
      score: Math.min(100, lowCapEntries * 20 + earlyEntryRate),
      analyzedTokens,
      lastActive: transactions[0]?.timestamp || Math.floor(Date.now() / 1000),
      specialistBadge: isSpecialist ? 'EARLY ENTRY SPECIALIST' : null,
      filters: { maxMarketCap, minSuccessRate, minLowCapTrades }
    });
    
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/discover', async (req, res) => {
  try {
    const tokenLimit = Math.min(parseInt(req.query.limit) || 20, 50);
    const topCount = Math.min(parseInt(req.query.top) || 20, 50);
    const minScore = parseInt(req.query.minScore) || 0;

    console.log('=== DISCOVERY START ===');

    const walletScores = {};
    const tokenData = {};
    let tokensAnalyzed = 0;
    let heliusErrors = 0;
    let filteredOutBots = 0;
    let filteredOutInstitutional = 0;
    
    console.log('Fetching DexScreener tokens...');
    try {
      const newPairsUrl = 'https://api.dexscreener.com/latest/dex/search?q=new&chain=solana';
      const newResponse = await fetch(newPairsUrl);
      const newData = await newResponse.json();
      
      const newTokens = (newData.pairs || [])
        .filter(p => p.chainId === 'solana')
        .slice(0, tokenLimit);
      
      console.log(`Found ${newTokens.length} DexScreener tokens`);
      
      for (const token of newTokens) {
        const mintAddress = token.baseToken.address;
        
        tokenData[mintAddress] = {
          symbol: token.baseToken.symbol,
          initialMC: token.fdv || token.marketCap || 0,
          currentMC: token.fdv || token.marketCap || 0,
          change24h: token.priceChange?.h24 || 0,
          volume24h: token.volume?.h24 || 0,
          createdAt: token.pairCreatedAt || Date.now()
        };
        
        try {
          const txUrl = `https://api.helius.xyz/v0/addresses/${mintAddress}/transactions?api-key=${HELIUS_API_KEY}&limit=100`;
          const txResponse = await fetch(txUrl);
          const transactions = await txResponse.json();
          
          if (!Array.isArray(transactions)) {
            console.log(`${token.baseToken.symbol}: Helius error`);
            heliusErrors++;
            continue;
          }
          
          if (transactions.length === 0) continue;
          
          tokensAnalyzed++;
          
          const buyerTimestamps = new Map();
          const totalBuyers = new Set();
          
          for (const tx of transactions) {
            if (tx.tokenTransfers) {
              for (const transfer of tx.tokenTransfers) {
                if (transfer.mint === mintAddress && transfer.toUserAccount) {
                  const wallet = transfer.toUserAccount;
                  
                  // FILTER: Skip blacklisted wallets
                  if (BLACKLISTED_WALLETS.has(wallet)) {
                    filteredOutInstitutional++;
                    continue;
                  }
                  
                  // FILTER: Skip program addresses
                  if (isProgramAddress(wallet)) {
                    filteredOutInstitutional++;
                    continue;
                  }
                  
                  totalBuyers.add(wallet);
                  
                  if (!buyerTimestamps.has(wallet)) {
                    buyerTimestamps.set(wallet, tx.timestamp);
                  }
                }
              }
            }
          }
          
          const sortedBuyers = Array.from(buyerTimestamps.entries()).sort((a, b) => a[1] - b[1]);
          const totalBuyerCount = sortedBuyers.length;
          
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
            
            const position = index + 1;
            const positionPercentile = (position / totalBuyerCount) * 100;
            
            let earlyPoints = 0;
            if (positionPercentile <= 5) {
              earlyPoints = 10;
              w.earlyBuyCount += 1;
            } else if (positionPercentile <= 10) {
              earlyPoints = 7;
              w.earlyBuyCount += 1;
            } else if (positionPercentile <= 20) {
              earlyPoints = 4;
            } else if (positionPercentile <= 50) {
              earlyPoints = 1;
            }
            
            w.earlyEntryScore += earlyPoints;
            
            const tokenPerformance = tokenData[mintAddress].change24h;
            if (tokenPerformance > 100) w.successScore += 15;
            else if (tokenPerformance > 50) w.successScore += 10;
            else if (tokenPerformance > 20) w.successScore += 5;
            else if (tokenPerformance > 0) w.successScore += 2;
            
            w.tokensFound.push({
              symbol: tokenData[mintAddress].symbol,
              position,
              totalBuyers: totalBuyerCount,
              performance: tokenPerformance,
              earlyEntry: earlyPoints > 0
            });
          });
          
          await new Promise(r => setTimeout(r, 1000));
        } catch (err) {
          console.error(`Error processing ${token.baseToken.symbol}:`, err.message);
          heliusErrors++;
        }
      }
    } catch (err) {
      console.error('DexScreener error:', err.message);
    }
    
    console.log(`Total wallets before filtering: ${Object.keys(walletScores).length}`);
    console.log(`Filtered institutional: ${filteredOutInstitutional}`);
    
    const now = Date.now() / 1000;
    Object.values(walletScores).forEach(w => {
      if (w.totalTokens >= 5) w.consistencyScore = 20;
      else if (w.totalTokens >= 3) w.consistencyScore = 15;
      else if (w.totalTokens >= 2) w.consistencyScore = 10;
      else w.consistencyScore = 5;
      
      if (w.earlyBuyCount >= 3) w.consistencyScore += 10;
      
      const daysSinceLastActivity = (now - w.lastActivity) / 86400;
      if (daysSinceLastActivity <= 1) w.recencyScore = 10;
      else if (daysSinceLastActivity <= 7) w.recencyScore = 7;
      else if (daysSinceLastActivity <= 30) w.recencyScore = 4;
      else w.recencyScore = 1;
      
      w.totalScore = 
        (w.earlyEntryScore * 0.4) + 
        (w.successScore * 0.3) + 
        (w.consistencyScore * 0.2) + 
        (w.recencyScore * 0.1);
    });
    
    let filteredWallets = Object.values(walletScores).filter(w => {
      // FILTER: Remove bots
      if (isLikelyBot(w)) {
        filteredOutBots++;
        return false;
      }
      
      // FILTER: Too many tokens (likely bot)
      if (w.totalTokens > 50) return false;
      
      // FILTER: Require minimum activity
      if (w.totalTokens < 2) return false;
      
      // FILTER: Recent activity
      const daysSinceActive = (now - w.lastActivity) / 86400;
      if (daysSinceActive > 90) return false;
      
      // FILTER: Minimum score
      if (w.totalScore < minScore) return false;
      
      return true;
    });
    
    console.log(`Filtered out ${filteredOutBots} bots`);
    console.log(`Remaining wallets: ${filteredWallets.length}`);
    
    filteredWallets.sort((a, b) => b.totalScore - a.totalScore);
    
    const maxScore = filteredWallets[0]?.totalScore || 1;
    const minScoreVal = filteredWallets[filteredWallets.length - 1]?.totalScore || 0;
    const scoreRange = maxScore - minScoreVal || 1;
    
    const discoveredWallets = filteredWallets
      .slice(0, topCount)
      .map((w, i) => {
        const percentile = Math.round(((w.totalScore - minScoreVal) / scoreRange) * 100);
        const tierInfo = getTierInfo(percentile);
        
        return {
          rank: i + 1,
          address: w.address,
          successScore: percentile,
          totalScore: Math.round(w.totalScore),
          tier: tierInfo.tier,
          badge: tierInfo.emoji,
          tierColor: tierInfo.color,
          earlyEntryScore: Math.round(w.earlyEntryScore),
          successRateScore: Math.round(w.successScore),
          consistencyScore: Math.round(w.consistencyScore),
          recencyScore: Math.round(w.recencyScore),
          earlyBuys: w.earlyBuyCount,
          totalTokensTraded: w.totalTokens,
          daysSinceActive: Math.round((now - w.lastActivity) / 86400),
          tokensFound: w.tokensFound.slice(0, 5)
        };
      });
    
    console.log('=== DISCOVERY COMPLETE ===');
    
    res.json({
      success: true,
      discoveredWallets,
      stats: {
        totalWalletsScanned: Object.keys(walletScores).length,
        walletsAfterFilters: filteredWallets.length,
        tokensAnalyzed,
        heliusErrors,
        filteredInstitutional: filteredOutInstitutional,
        filteredBots: filteredOutBots,
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
        blacklistedWallets: BLACKLISTED_WALLETS.size,
        botDetection: 'Enabled',
        minTokens: 'Minimum 2 different tokens required'
      },
      timestamp: new Date()
    });
    
  } catch (error) {
    console.error('Discovery error:', error);
    res.status(500).json({ error: error.message });
  }
});

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
    status: 'LOW CAP HUNTER API - Bot Filtered',
    version: '2.2',
    endpoints: {
      wallet: '/api/wallet/:address',
      discover: '/api/discover?limit=20&top=20',
      dexscreener: '/api/dexscreener/:address'
    },
    features: {
      blacklist: `${BLACKLISTED_WALLETS.size} institutional wallets blocked`,
      botDetection: 'High-frequency traders filtered',
      qualityFilters: 'Min 2 tokens, active in 90 days'
    },
    timestamp: new Date() 
  });
});

loadTokenRegistry();

app.listen(PORT, '0.0.0.0', () => {
  console.log('LOW CAP HUNTER API v2.2 - Bot Filtered running on port', PORT);
});