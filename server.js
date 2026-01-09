const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 3001;

const BIRDEYE_API_KEY = '73e8a243fd26414098b027317db6cbfd';
const HELIUS_API_KEY = 'a6f9ba84-1abf-4c90-8e04-fc0a61294407';
const MORALIS_API_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJub25jZSI6ImEyMjUyZTcwLWQ1NGYtNDc2Zi04NzdlLTA1YmMzZjZkOGNmNSIsIm9yZ0lkIjoiNDg5MjY0IiwidXNlcklkIjoiNTAzMzkzIiwidHlwZUlkIjoiNTM5NmE0NmMtOGE3OC00NWI1LThlOWMtZDY0OTA4YmJjMWU2IiwidHlwZSI6IlBST0pFQ1QiLCJpYXQiOjE3Njc4NjI4NjMsImV4cCI6NDkyMzYyMjg2M30.YK8NJCVztDL39VYA1fMwyCL__3_lidUSFKbYFK8qcSQ';

let tokenCache = {};

// Expanded static blacklist
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
    
    if (balanceData && balanceData.balance > 500000 * 10**9) return true; // >500k SOL
    
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

// Get recent transaction count (approximate)
async function getRecentTxCount(wallet) {
  try {
    const url = `https://api.helius.xyz/v0/addresses/${wallet}/transactions?api-key=${HELIUS_API_KEY}&limit=1`;
    const response = await fetch(url);
    const data = await response.json();
    return data.length > 0 ? 10 : 0; // Simple proxy for activity
  } catch (err) {
    return 0;
  }
}

// Get realized PnL from Moralis
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
    if (data && data.realized_pnl) {
      return {
        realized_profit_usd: data.realized_pnl.usd || 0,
        realized_profit_sol: data.realized_pnl.sol || 0,
        total_trades: data.total_trades || 0,
        win_rate: data.win_rate || 0,
        profitable_trades: data.profitable_trades || 0,
        average_roi: data.average_roi || 0
      };
    }
  } catch (err) {
    console.log('Moralis PnL failed:', err.message);
  }
  return {
    realized_profit_usd: 0,
    realized_profit_sol: 0,
    total_trades: 0,
    win_rate: 0,
    profitable_trades: 0,
    average_roi: 0
  };
}

// MAIN DISCOVERY - Real traders only
app.get('/api/discover', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    
    const walletScores = {};
    
    // DexScreener New Pairs
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
          if (balance < 0.01) continue; // Skip empty wallets
          
          if (!walletScores[owner]) {
            walletScores[owner] = {
              address: owner,
              earlyBuys: 0,
              totalTokens: 0,
              totalChangeBonus: 0,
              score: 0
            };
          }
          walletScores[owner].earlyBuys += 1;
          walletScores[owner].totalTokens += 1;
          walletScores[owner].totalChangeBonus += (mcData.change24h > 0 ? mcData.change24h : 0);
        }
        
        await new Promise(r => setTimeout(r, 500));
      } catch (err) {}
    }
    
    // Birdeye Token List
    console.log('Fetching token list from Birdeye...');
    const birdeyeUrl = `https://public-api.birdeye.so/defi/tokenlist?sort_by=mc&sort_type=desc&offset=0&limit=${limit}`;
    const birdeyeResponse = await fetch(birdeyeUrl, {
      headers: {
        'X-API-KEY': BIRDEYE_API_KEY,
        'x-chain': 'solana'
      }
    });
    
    let birdeyeTokens = [];
    if (birdeyeResponse.ok) {
      const birdeyeData = await birdeyeResponse.json();
      birdeyeTokens = (birdeyeData.data?.tokens || []).slice(0, limit);
    }
    
    for (const token of birdeyeTokens) {
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
              totalTokens: 0,
              totalChangeBonus: 0,
              score: 0
            };
          }
          walletScores[owner].totalTokens += 1;
          walletScores[owner].totalChangeBonus += (token.priceChange?.h24 || 0 > 0 ? token.priceChange?.h24 || 0 : 0);
        }
        
        await new Promise(r => setTimeout(r, 500));
      } catch (err) {}
    }
    
    // PnL for top candidates
    const candidates = Object.values(walletScores)
      .sort((a, b) => b.totalTokens - a.totalTokens)
      .slice(0, 30);
    
    for (const w of candidates) {
      const pnl = await getWalletPnL(w.address);
      w.realized_profit_usd = pnl.realized_profit_usd || 0;
      w.profitable_trades = pnl.profitable_trades || 0;
      w.win_rate = pnl.win_rate || 0;
      w.average_roi = pnl.average_roi || 0;
      
      w.score = (w.earlyBuys * 20) + 
                (w.profitable_trades * 30) + 
                (w.win_rate * 10) + 
                (w.average_roi * 5) + 
                (w.realized_profit_usd > 1000 ? 100 : 0);
    }
    
    const discoveredWallets = candidates
      .sort((a, b) => b.score - a.score)
      .map((w, i) => ({
        rank: i + 1,
        address: w.address,
        successScore: Math.floor(w.score),
        earlyBuys: w.earlyBuys,
        totalTokensTraded: w.totalTokens,
        realizedProfitUSD: w.realized_profit_usd,
        profitableTrades: w.profitable_trades,
        winRate: w.win_rate,
        averageROI: w.average_roi
      }));
    
    res.json({
      success: true,
      discoveredWallets,
      totalWallets: Object.keys(walletScores).length,
      message: 'Real profitable traders with PnL data!'
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
    message: 'Your successful trader discovery API is ready.',
    endpoints: {
      discover: '/api/discover?limit=50 (main feature - ranked traders)',
      wallet: '/api/wallet/WALLET_ADDRESS (detailed analysis)',
      dexscreener: '/api/dexscreener/TOKEN_ADDRESS (token data)'
    },
    tip: 'Now showing real profitable traders with PnL!'
  });
});

app.use(cors());
app.use(express.json());

loadTokenRegistry();

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});