const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 3001;

// ALL KEYS ARE ENVIRONMENT VARIABLES - NO SECRETS IN CODE
const BIRDEYE_API_KEY = process.env.BIRDEYE_API_KEY || '';
const HELIUS_API_KEY = process.env.HELIUS_API_KEY || '';
const MORALIS_API_KEY = process.env.MORALIS_API_KEY || '';
const APIFY_TOKEN = process.env.APIFY_TOKEN || '';

let tokenCache = {};

// Expanded blacklist for institutions/bots
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

// Dynamic institutional check
async function isInstitutional(wallet) {
  try {
    const infoUrl = `https://api.helius.xyz/v0/addresses/${wallet}?api-key=${HELIUS_API_KEY}`;
    const infoResponse = await fetch(infoUrl);
    const infoData = await infoResponse.json();
    
    if (infoData.executable) return true;
    
    const balanceUrl = `https://api.helius.xyz/v0/addresses/${wallet}/balance?api-key=${HELIUS_API_KEY}`;
    const balanceResponse = await fetch(balanceUrl);
    const balanceData = await balanceResponse.json();
    
    if (balanceData && balanceData.balance > 500000 * 10**9) return true;
    
    return false;
  } catch (err) {
    return false;
  }
}

// Get wallet balance in SOL
async function getWalletBalance(wallet) {
  try {
    const url = `https://api.helius.xyz/v0/addresses/${wallet}/balance?api-key=${HELIUS_API_KEY}`;
    const response = await fetch(url);
    const data = await response.json();
    return (data?.lamports || 0) / 10**9;
  } catch (err) {
    return 0;
  }
}

// Get Moralis PnL (realized + unrealized)
async function getWalletPnL(wallet) {
  try {
    const url = `https://solana-gateway.moralis.io/account/mainnet/${wallet}/pnl`;
    const response = await fetch(url, {
      headers: {
        'accept': 'application/json',
        'X-API-Key': MORALIS_API_KEY
      }
    });
    const data = await response.json();
    
    if (data) {
      return {
        realized_profit_usd: data.realized_pnl?.usd || 0,
        unrealized_profit_usd: data.unrealized_pnl?.usd || 0,
        total_profit_usd: (data.realized_pnl?.usd || 0) + (data.unrealized_pnl?.usd || 0),
        total_trades: data.total_trades || 0,
        profitable_trades: data.profitable_trades || 0,
        win_rate: data.win_rate || 0,
        average_roi: data.average_roi || 0
      };
    }
  } catch (err) {
    console.log('Moralis PnL failed:', err.message);
  }
  return {
    realized_profit_usd: 0,
    unrealized_profit_usd: 0,
    total_profit_usd: 0,
    total_trades: 0,
    profitable_trades: 0,
    win_rate: 0,
    average_roi: 0
  };
}

// MAIN DISCOVERY - Early + In Profit + Consistency (Unrealized PnL Included)
app.get('/api/discover', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    
    const walletScores = {};
    
    // DexScreener New Pairs (early entry)
    console.log('Fetching new pairs from DexScreener...');
    const newPairsUrl = 'https://api.dexscreener.com/latest/dex/search?q=new&chain=solana';
    const newResponse = await fetch(newPairsUrl);
    const newData = await newResponse.json();
    
    const newTokens = (newData.pairs || [])
      .filter(p => p.chainId === 'solana')
      .slice(0, limit);
    
    for (const token of newTokens) {
      const mintAddress = token.baseToken.address;
      const mcData = await getTokenMarketCap(mintAddress);
      
      try {
        const txUrl = `https://api.helius.xyz/v0/addresses/${mintAddress}/transactions?api-key=${HELIUS_API_KEY}&limit=50`;
        const txResponse = await fetch(txUrl);
        const transactions = await txResponse.json();
        
        if (!transactions || transactions.length === 0) continue;
        
        const owners = new Set();
        for (const tx of transactions) {
          if (tx.tokenTransfers) {
            for (const transfer of tx.tokenTransfers) {
              if (transfer.fromOwnerAccount) owners.add(transfer.fromOwnerAccount.toLowerCase());
              if (transfer.toOwnerAccount) owners.add(transfer.toOwnerAccount.toLowerCase());
            }
          }
        }
        
        for (const owner of owners) {
          if (BLACKLISTED_WALLETS.includes(owner)) continue;
          if (await isInstitutional(owner)) continue;
          
          const balance = await getWalletBalance(owner);
          if (balance < 0.01) continue;
          
          if (!walletScores[owner]) {
            walletScores[owner] = {
              address: owner,
              earlyBuys: 0,
              currentUnrealizedBonus: 0,
              score: 0
            };
          }
          walletScores[owner].earlyBuys += 1;
          if (mcData.change24h > 0) {
            walletScores[owner].currentUnrealizedBonus += mcData.change24h * 10;
          }
        }
        
        await new Promise(r => setTimeout(r, 500));
      } catch (err) {}
    }
    
    // Birdeye Trending Tokens (current profit)
    console.log('Fetching trending tokens from Birdeye...');
    const birdeyeUrl = 'https://public-api.birdeye.so/defi/trending_tokens?chain=solana';
    const birdeyeResponse = await fetch(birdeyeUrl, {
      headers: { 'X-API-KEY': BIRDEYE_API_KEY, 'x-chain': 'solana' }
    });
    
    let trendingTokens = [];
    if (birdeyeResponse.ok) {
      const birdeyeData = await birdeyeResponse.json();
      trendingTokens = birdeyeData.data || [];
    }
    
    for (const token of trendingTokens) {
      const mintAddress = token.address;
      
      try {
        const txUrl = `https://api.helius.xyz/v0/addresses/${mintAddress}/transactions?api-key=${HELIUS_API_KEY}&limit=50`;
        const txResponse = await fetch(txUrl);
        const transactions = await txResponse.json();
        
        if (!transactions || transactions.length === 0) continue;
        
        const owners = new Set();
        for (const tx of transactions) {
          if (tx.tokenTransfers) {
            for (const transfer of tx.tokenTransfers) {
              if (transfer.fromOwnerAccount) owners.add(transfer.fromOwnerAccount.toLowerCase());
              if (transfer.toOwnerAccount) owners.add(transfer.toOwnerAccount.toLowerCase());
            }
          }
        }
        
        for (const owner of owners) {
          if (BLACKLISTED_WALLETS.includes(owner)) continue;
          if (await isInstitutional(owner)) continue;
          
          const balance = await getWalletBalance(owner);
          if (balance < 0.01) continue;
          
          if (!walletScores[owner]) {
            walletScores[owner] = {
              address: owner,
              earlyBuys: 0,
              currentUnrealizedBonus: 0,
              score: 0
            };
          }
          if (token.priceChange?.h24 > 0) {
            walletScores[owner].currentUnrealizedBonus += token.priceChange.h24 * 10;
          }
        }
        
        await new Promise(r => setTimeout(r, 500));
      } catch (err) {}
    }
    
    // Final PnL + Consistency Scoring
    const candidates = Object.values(walletScores);
    
    for (const w of candidates) {
      const pnl = await getWalletPnL(w.address);
      
      const winRate = pnl.win_rate || 0;
      const profitableTrades = pnl.profitable_trades || 0;
      const totalTrades = pnl.total_trades || 0;
      const realizedProfit = pnl.realized_profit_usd || 0;
      const unrealizedProfit = pnl.unrealized_profit_usd || 0;
      
      // Base: Early entry + current unrealized profit
      w.score = w.earlyBuys * 30 + w.currentUnrealizedBonus + unrealizedProfit;
      
      // Consistency boost (win rate ≥25%)
      if (winRate >= 0.25) {
        w.score += winRate * 300 + profitableTrades * 20;
      }
      
      // Realized profit bonus
      w.score += realizedProfit / 10;
      
      // Emerging trader bonus: high current profit, low history
      if (totalTrades < 5 && (w.currentUnrealizedBonus + unrealizedProfit) > 500) {
        w.score += 200;
      }
      
      w.winRate = winRate;
      w.profitableTrades = profitableTrades;
      w.realizedProfitUSD = realizedProfit;
      w.unrealizedProfitUSD = unrealizedProfit;
    }
    
    const discoveredWallets = candidates
      .sort((a, b) => b.score - a.score)
      .slice(0, 20)
      .map((w, i) => ({
        rank: i + 1,
        address: w.address,
        successScore: Math.floor(w.score),
        earlyBuys: w.earlyBuys,
        currentUnrealizedBonus: Math.floor(w.currentUnrealizedBonus),
        realizedProfitUSD: Math.floor(w.realizedProfitUSD),
        unrealizedProfitUSD: Math.floor(w.unrealizedProfitUSD),
        winRate: w.winRate,
        profitableTrades: w.profitableTrades
      }));
    
    res.json({
      success: true,
      discoveredWallets,
      totalCandidates: candidates.length,
      message: discoveredWallets.length === 0 
        ? 'No early profitable traders found yet — market too early.'
        : 'Early + in-profit traders with consistency scoring!'
    });
    
  } catch (error) {
    console.error('Discovery error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ANALYZE WALLET - Your existing code (keep as is)
app.get('/api/wallet/:address', async (req, res) => {
  try {
    const { address } = req.params;
    
    const maxMarketCap = parseInt(req.query.maxMC) || 1000000;
    const minSuccessRate = parseInt(req.query.minRate) || 40;
    const minLowCapTrades = parseInt(req.query.minTrades) || 3;
    
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
              tokenEntries[transfer.mint] = { firstSeen: tx.timestamp };
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
    
    res.json(analysis);
    
  } catch (error) {
    console.error('Error:', error);
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
    status: 'Memecoin Tracker Backend is LIVE!',
    timestamp: new Date().toISOString(),
    uptime_seconds: Math.floor(process.uptime()),
    message: 'Your successful trader discovery API is ready.',
    endpoints: {
      discover: '/api/discover?limit=50 (main feature - ranked traders)',
      wallet: '/api/wallet/WALLET_ADDRESS (detailed analysis)',
      dexscreener: '/api/dexscreener/TOKEN_ADDRESS (token data)'
    },
    tip: 'All keys secure via environment variables!'
  });
});

app.use(cors());
app.use(express.json());

loadTokenRegistry();

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});