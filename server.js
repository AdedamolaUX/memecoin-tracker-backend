const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 3001;

const BIRDEYE_API_KEY = '73e8a243fd26414098b027317db6cbfd';
const HELIUS_API_KEY = 'a6f9ba84-1abf-4c90-8e04-fc0a61294407';
const MORALIS_API_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJub25jZSI6ImEyMjUyZTcwLWQ1NGYtNDc2Zi04NzdlLTA1YmMzZjZkOGNmNSIsIm9yZ0lkIjoiNDg5MjY0IiwidXNlcklkIjoiNTAzMzkzIiwidHlwZUlkIjoiNTM5NmE0NmMtOGE3OC00NWI1LThlOWMtZDY0OTA4YmJjMWU2IiwidHlwZSI6IlBST0pFQ1QiLCJpYXQiOjE3Njc4NjI4NjMsImV4cCI6NDkyMzYyMjg2M30.YK8NJCVztDL39VYA1fMwyCL__3_lidUSFKbYFK8qcSQ';

let tokenCache = {};

// Blacklist (expanded)
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

// MAIN DISCOVERY - New Logic: Early + In Profit + Consistency
app.get('/api/discover', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    
    const walletScores = {};
    
    // DexScreener New Pairs
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
              currentUnrealizedProfit: 0,
              score: 0
            };
          }
          walletScores[owner].earlyBuys += 1;
          // Bonus if token is pumping
          if (mcData.change24h > 0) {
            walletScores[owner].currentUnrealizedProfit += mcData.change24h * 10;
          }
        }
        
        await new Promise(r => setTimeout(r, 500));
      } catch (err) {}
    }
    
    // Birdeye Trending Tokens (for current profit)
    const birdeyeUrl = `https://public-api.birdeye.so/defi/trending_tokens?chain=solana`;
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
              currentUnrealizedProfit: 0,
              score: 0
            };
          }
          if (token.priceChange?.h24 > 0) {
            walletScores[owner].currentUnrealizedProfit += token.priceChange.h24 * 10;
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
      
      // Base score from early entry + current profit
      w.score = w.earlyBuys * 30 + w.currentUnrealizedProfit + unrealizedProfit;
      
      // Consistency boost (win rate ≥25%)
      if (winRate >= 0.25) {
        w.score += winRate * 200 + profitableTrades * 20;
      }
      
      // Realized profit bonus
      w.score += realizedProfit / 10;
      
      // New traders with high current profit still rank
      if (totalTrades < 5 && w.currentUnrealizedProfit > 100) {
        w.score += 100; // Emerging star bonus
      }
    }
    
    const discoveredWallets = candidates
      .sort((a, b) => b.score - a.score)
      .slice(0, 20)
      .map((w, i) => ({
        rank: i + 1,
        address: w.address,
        successScore: Math.floor(w.score),
        earlyBuys: w.earlyBuys,
        currentUnrealizedBonus: Math.floor(w.currentUnrealizedProfit),
        realizedProfitUSD: Math.floor(w.realizedProfitUSD || 0),
        winRate: w.winRate || 0,
        profitableTrades: w.profitableTrades || 0
      }));
    
    res.json({
      success: true,
      discoveredWallets,
      totalCandidates: candidates.length,
      message: discoveredWallets.length === 0 
        ? 'No early profitable traders found yet — market too early or no matches.'
        : 'Early + in-profit traders with consistency scoring!'
    });
    
  } catch (error) {
    console.error('Discovery error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Other endpoints unchanged (wallet, dexscreener, home)

app.use(cors());
app.use(express.json());

loadTokenRegistry();

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});