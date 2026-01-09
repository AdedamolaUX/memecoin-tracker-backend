const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 3001;

// ALL KEYS FROM ENVIRONMENT VARIABLES
const BIRDEYE_API_KEY = process.env.BIRDEYE_API_KEY || '';
const HELIUS_API_KEY = process.env.HELIUS_API_KEY || '';
const MORALIS_API_KEY = process.env.MORALIS_API_KEY || '';
const APIFY_TOKEN = process.env.APIFY_TOKEN || '';

let tokenCache = {};

// Blacklist
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

// Get Moralis PnL
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

// MAIN DISCOVERY - With DexScreener Top Traders Scraping
app.get('/api/discover', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    
    const traderScores = {};
    
    // Get trending + new tokens
    const newPairsUrl = 'https://api.dexscreener.com/latest/dex/search?q=new&chain=solana';
    const newResponse = await fetch(newPairsUrl);
    const newData = await newResponse.json();
    const newTokens = (newData.pairs || []).filter(p => p.chainId === 'solana').slice(0, limit);
    
    const birdeyeUrl = 'https://public-api.birdeye.so/defi/trending_tokens?chain=solana';
    const birdeyeResponse = await fetch(birdeyeUrl, {
      headers: { 'X-API-KEY': BIRDEYE_API_KEY, 'x-chain': 'solana' }
    });
    const birdeyeData = birdeyeResponse.ok ? await birdeyeResponse.json() : { data: [] };
    const trendingTokens = birdeyeData.data || [];
    
    const allTokens = [...newTokens.map(t => t.baseToken.address), ...trendingTokens.map(t => t.address)];
    
    // Scrape top traders using Apify
    for (const tokenAddress of allTokens) {
      if (!APIFY_TOKEN) {
        console.log('APIFY_TOKEN not set - skipping scraping');
        continue;
      }
      
      try {
        // Start sync run
        const runUrl = `https://api.apify.com/v2/acts/crypto-scraper~dexscreener-top-traders-scraper/run-sync-get-dataset-items?token=${APIFY_TOKEN}`;
        const runResponse = await fetch(runUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            tokens: [{ chain: 'solana', address: tokenAddress }],
            limit: 20
          })
        });
        
        if (!runResponse.ok) {
          console.log('Apify run failed:', await runResponse.text());
          continue;
        }
        
        const traders = await runResponse.json();
        
        for (const trader of traders) {
          const wallet = trader.wallet.toLowerCase();
          
          if (BLACKLISTED_WALLETS.includes(wallet)) continue;
          
          const balance = await getWalletBalance(wallet);
          if (balance < 0.01) continue;
          
          const pnl = await getWalletPnL(wallet);
          
          if (!traderScores[wallet]) {
            traderScores[wallet] = {
              address: wallet,
              recentProfitUSD: 0,
              recentUnrealizedUSD: 0,
              profitableTrades: pnl.profitable_trades || 0,
              winRate: pnl.win_rate || 0,
              score: 0
            };
          }
          
          traderScores[wallet].recentProfitUSD += (trader.realizedPnl || 0);
          traderScores[wallet].recentUnrealizedUSD += (trader.unrealizedPnl || 0);
        }
        
        await new Promise(r => setTimeout(r, 1200)); // Rate limit
      } catch (err) {
        console.log('Scraping error for token', tokenAddress, err.message);
      }
    }
    
    // Final scoring
    Object.values(traderScores).forEach(t => {
      const recentTotal = t.recentProfitUSD + t.recentUnrealizedUSD;
      t.score = recentTotal + 
                (t.winRate >= 0.25 ? t.winRate * 300 + t.profitableTrades * 30 : 0) +
                (t.profitableTrades < 5 && recentTotal > 500 ? 200 : 0);
    });
    
    const discoveredWallets = Object.values(traderScores)
      .sort((a, b) => b.score - a.score)
      .slice(0, 20)
      .map((t, i) => ({
        rank: i + 1,
        address: t.address,
        successScore: Math.floor(t.score),
        recentProfitUSD: Math.floor(t.recentProfitUSD),
        recentUnrealizedUSD: Math.floor(t.recentUnrealizedUSD),
        winRate: t.winRate,
        profitableTrades: t.profitableTrades
      }));
    
    res.json({
      success: true,
      discoveredWallets,
      totalTokensScraped: allTokens.length,
      message: discoveredWallets.length === 0 
        ? 'No top traders found in current tokens — try again in a few minutes.'
        : 'Top traders scraped from DexScreener with skill validation!'
    });
    
  } catch (error) {
    console.error('Discovery error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ANALYZE WALLET (unchanged)
app.get('/api/wallet/:address', async (req, res) => {
  // Your existing code
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
    message: 'Top traders scraped from DexScreener + skill validation',
    endpoints: {
      discover: '/api/discover?limit=50 (main feature - ranked traders)',
      wallet: '/api/wallet/WALLET_ADDRESS (detailed analysis)',
      dexscreener: '/api/dexscreener/TOKEN_ADDRESS (token data)'
    }
  });
});

app.use(cors());
app.use(express.json());

loadTokenRegistry();

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});