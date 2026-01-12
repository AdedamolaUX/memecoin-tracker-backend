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

// Get pair addresses from DexScreener (SOL/USDT)
async function getPairAddresses(mint) {
  try {
    const url = `https://api.dexscreener.com/latest/dex/tokens/${mint}`;
    const response = await fetch(url);
    const data = await response.json();
    if (data.pairs && data.pairs.length > 0) {
      const solPair = data.pairs.find(p => p.quoteToken.symbol === 'SOL')?.pairAddress;
      const usdtPair = data.pairs.find(p => p.quoteToken.symbol === 'USDT')?.pairAddress;
      return [solPair, usdtPair].filter(p => p);
    }
  } catch (err) {
    console.log('DexScreener pairs failed:', err.message);
  }
  return [];
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

// MAIN DISCOVERY - With Pair Addresses + Apify Scraping
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
    
    // 1. Helius tx on Pair Addresses
    for (const mint of allTokens) {
      const pairAddresses = await getPairAddresses(mint);
      
      for (const pairAddress of pairAddresses) {
        try {
          const txUrl = `https://api.helius.xyz/v0/addresses/${pairAddress}/transactions?api-key=${HELIUS_API_KEY}&limit=50`;
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
            if (balance < 0.001) continue; // Relaxed
            
            if (!traderScores[owner]) {
              traderScores[owner] = {
                address: owner,
                earlyBuys: 0,
                score: 0
              };
            }
            traderScores[owner].earlyBuys += 1;
          }
          
          await new Promise(r => setTimeout(r, 500));
        } catch (err) {
          console.log('Helius failed for pair:', err.message);
        }
      }
    }
    
    // 2. Apify Scraping for Top Traders
    for (const tokenAddress of allTokens) {
      try {
        const runUrl = 'https://api.apify.com/v2/acts/crypto-scraper~dexscreener-top-traders-scraper/run-sync-get-dataset-items?token=' + APIFY_TOKEN;
        const runResponse = await fetch(runUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            tokenAddress: tokenAddress,
            chain: 'solana',
            limit: 20
          })
        });
        
        const traders = await runResponse.json();
        
        for (const trader of traders) {
          const wallet = trader.wallet.toLowerCase();
          
          if (BLACKLISTED_WALLETS.includes(wallet)) continue;
          if (await isInstitutional(wallet)) continue;
          
          const balance = await getWalletBalance(wallet);
          if (balance < 0.001) continue;
          
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
        
        await new Promise(r => setTimeout(r, 1000));
      } catch (err) {
        console.log('Apify scrape failed:', err.message);
      }
    }
    
    // Final scoring (relaxed)
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
      totalTokensProcessed: allTokens.length,
      message: discoveredWallets.length === 0 
        ? 'No top traders found in current tokens — try again soon!'
        : 'Top traders from DexScreener with skill validation!'
    });
    
  } catch (error) {
    console.error('Discovery error:', error);
    res.status(500).json({ error: error.message });
  }
});

// JUPITER SWAP QUOTE - New Endpoint
app.get('/api/swap-quote', async (req, res) => {
  try {
    const { inputMint, outputMint, amount, slippageBps = 50 } = req.query;
    
    if (!inputMint || !outputMint || !amount) {
      return res.status(400).json({ error: 'Missing inputMint, outputMint, or amount' });
    }
    
    const url = `https://quote-api.jup.ag/v6/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=${slippageBps}`;
    const response = await fetch(url);
    const data = await response.json();
    
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ANALYZE WALLET (unchanged)
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
      dexscreener: '/api/dexscreener/TOKEN_ADDRESS (token data)',
      swap-quote: '/api/swap-quote?inputMint=So11111111111111111111111111111111111111112&outputMint=DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263&amount=1000000000 (Jupiter swap quote)'
    }
  });
});

app.use(cors());
app.use(express.json());

loadTokenRegistry();

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});