require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const QUICKNODE_URL = process.env.QUICKNODE_URL;
const BIRDEYE_API_KEY = process.env.BIRDEYE_API_KEY || 'b96aa5053c1d43ca9c267173bf5ab5b3';
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const TARGET_TOKENS = process.env.TARGET_TOKENS || '';

const MIN_MARKET_CAP = 1000;
const MAX_MARKET_CAP = 10_000_000;
const MIN_VOLUME = 10000;

const BLACKLISTED = new Set([
  'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4', 'JUP4Fb2cqiRUcaTHdrPC8h2gNsA2ETXiPDD33WcGuJB',
  'JUP2jxvXaqu7NQY1GmNF4m1vodw12LVXYxbFL2uJvfo', '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',
  '5Q544fKrFoe6tsEbD7S8EmEunGAV1gnGo', 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc',
  'AC5RDfQFmDS1deWZos921JfqscXdByf8BKHs5ACWjtL', '5VCwKtCXgCJ6kit5FybXjvriW3xELsFDhYrPSqtJNmcD',
  'GUfCR9mK6azb9vcpsxgXyj7XRPAKJd4KMHTTVvtncGgp', '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
  'CebN5WGQ4jvEPvsVU4EoHEpgzq1VV7AbicfhtW4xC9iM',
  '5m4VGV3u16U9QkKd74Ffc6ziv1Zqs44cVmA3oajAxkM6',
  'ExCZTxX1gV27Aeg7jb4hQBqkwDKHZnETEeWb9otCNBc',
  'EZQiSmPiXnfQrJzCEqYS5f8NBhoTPro4jQznEGRkcP9R',
  '2fPCxpdcAqm51CpM5CaSqCzY8XWfSg9Y9RAsSwXWR7tY',
]);

let knownTokens = new Map();
const trackedWallets = new Map();
const activeAlerts = new Map();
const walletClusters = new Map();

async function sendTelegram(msg) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return false;
  try {
    const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: msg, parse_mode: 'HTML' })
    });
    return res.ok;
  } catch { return false; }
}

async function loadTokens() {
  try {
    const res = await fetch('https://token.jup.ag/all');
    const tokens = await res.json();
    tokens.forEach(t => knownTokens.set(t.address, { symbol: t.symbol, name: t.name }));
    console.log(`✅ Loaded ${knownTokens.size} tokens`);
  } catch (err) {
    console.error('⚠️ Failed to load tokens:', err.message);
  }
}

function getTokenInfo(mint) {
  return knownTokens.get(mint) || { symbol: mint.slice(0, 8), name: 'Unknown' };
}

async function getTokenBuyers(mint, batchSize = 50) {
  const allWallets = new Map();
  
  for (let offset = 0; offset < 150; offset += batchSize) {
    try {
      await new Promise(r => setTimeout(r, 300));
      
      const res = await fetch(
        `https://public-api.birdeye.so/defi/txs/token?address=${mint}&tx_type=swap&sort_type=desc&offset=${offset}&limit=${batchSize}`,
        { headers: { 'X-API-KEY': BIRDEYE_API_KEY } }
      );
      
      const data = await res.json();
      
      if (!data.success || !data.data?.items) {
        if (offset === 0) console.log(`    ⚠️ Birdeye error: ${data.message || 'No data'}`);
        break;
      }
      
      for (const tx of data.data.items) {
        if (!tx.owner || BLACKLISTED.has(tx.owner)) continue;
        
        const isBuy = tx.to?.address === mint;
        if (!isBuy) continue;
        
        if (!allWallets.has(tx.owner)) {
          allWallets.set(tx.owner, {
            address: tx.owner,
            firstSeen: tx.blockUnixTime,
            txCount: 0,
            buyCount: 0,
            sellCount: 0
          });
        }
        
        const wallet = allWallets.get(tx.owner);
        wallet.txCount++;
        if (isBuy) wallet.buyCount++;
        else wallet.sellCount++;
      }
      
      if (data.data.items.length < batchSize) break;
    } catch (err) {
      console.log(`    ⚠️ Fetch error at offset ${offset}:`, err.message);
      break;
    }
  }
  
  const buyers = Array.from(allWallets.values())
    .filter(w => {
      if (w.sellCount > w.buyCount) return false;
      if (w.buyCount > 0 && w.sellCount > 0) {
        const timeDiff = Math.abs(w.firstSeen - w.lastSeen);
        if (timeDiff < 60) return false;
      }
      return true;
    });
  
  console.log(`    📊 Found ${buyers.length} buyers from ${allWallets.size} total wallets`);
  return buyers;
}

async function analyzeWalletProfit(address) {
  try {
    await new Promise(r => setTimeout(r, 500));
    
    const res = await fetch(
      `https://public-api.birdeye.so/v1/wallet/tx_list?wallet=${address}&limit=100`,
      { headers: { 'X-API-KEY': BIRDEYE_API_KEY } }
    );
    
    const data = await res.json();
    
    // DETAILED DEBUGGING
    console.log(`    🔍 DEBUG - API Status: ${res.status}`);
    console.log(`    🔍 DEBUG - Response success: ${data.success}`);
    console.log(`    🔍 DEBUG - Has data: ${!!data.data}`);
    console.log(`    🔍 DEBUG - Items count: ${data.data?.items?.length || 0}`);
    
    if (!data.success || !data.data?.items) {
      console.log(`    🔍 DEBUG - Full response:`, JSON.stringify(data).slice(0, 200));
      return { profit: 0, profitUSD: 0, swapCount: 0, tokenCount: 0 };
    }
    
    let solSpent = 0;
    let solReceived = 0;
    let swapCount = 0;
    const tokensTraded = new Set();
    
    console.log(`    🔍 DEBUG - Processing ${data.data.items.length} transactions...`);
    
    for (const tx of data.data.items) {
      if (tx.txType !== 'SWAP') continue;
      
      swapCount++;
      
      // Track tokens
      if (tx.from?.address) tokensTraded.add(tx.from.address);
      if (tx.to?.address) tokensTraded.add(tx.to.address);
      
      // Calculate SOL flow
      const fromIsSol = tx.from?.symbol === 'SOL' || tx.from?.address === 'So11111111111111111111111111111111111111112';
      const toIsSol = tx.to?.symbol === 'SOL' || tx.to?.address === 'So11111111111111111111111111111111111111112';
      
      if (fromIsSol && tx.from?.uiAmount) {
        solSpent += tx.from.uiAmount;
      }
      if (toIsSol && tx.to?.uiAmount) {
        solReceived += tx.to.uiAmount;
      }
    }
    
    const profitSOL = solReceived - solSpent;
    const profitUSD = profitSOL * 180; // Approximate SOL price
    
    console.log(`    📈 ${swapCount} swaps | Spent: ${solSpent.toFixed(2)} SOL | Received: ${solReceived.toFixed(2)} SOL`);
    console.log(`    💰 Profit: $${profitUSD.toFixed(2)} (${profitSOL.toFixed(2)} SOL) | Tokens: ${tokensTraded.size}`);
    
    return {
      profit: profitSOL,
      profitUSD,
      swapCount,
      tokenCount: tokensTraded.size
    };
    
  } catch (err) {
    console.log(`    ⚠️ Profit analysis error:`, err.message);
    return { profit: 0, profitUSD: 0, swapCount: 0, tokenCount: 0 };
  }
}

function isBot(wallet) {
  if (wallet.sellCount > wallet.buyCount * 2) return true;
  if (wallet.buyCount > 20 && wallet.sellCount > 20) return true;
  return false;
}

async function discoverSmartMoney(limit = 20, topN = 5) {
  console.log('\n=== SMART MONEY DISCOVERY ===');
  
  let tokens = [];
  
  if (TARGET_TOKENS) {
    tokens = TARGET_TOKENS.split(',').map(t => t.trim()).filter(Boolean);
    console.log('📋 Using manual token list');
    console.log(`✅ Loaded ${tokens.length} tokens`);
  } else {
    console.log('🔍 Auto-discovering tokens');
    try {
      const res = await fetch(
        `https://public-api.birdeye.so/defi/tokenlist?sort_by=v24hUSD&sort_type=desc&offset=0&limit=${limit}`,
        { headers: { 'X-API-KEY': BIRDEYE_API_KEY } }
      );
      const data = await res.json();
      
      if (data.success && data.data?.tokens) {
        tokens = data.data.tokens
          .filter(t => {
            const mc = t.mc || 0;
            const v24h = t.v24hUSD || 0;
            return mc >= MIN_MARKET_CAP && mc <= MAX_MARKET_CAP && v24h >= MIN_VOLUME;
          })
          .map(t => t.address)
          .slice(0, limit);
      }
      
      console.log(`✅ Found ${tokens.length} tokens`);
    } catch (err) {
      console.error('❌ Auto-discovery failed:', err.message);
      return { discoveredWallets: [], stats: {} };
    }
  }
  
  const scores = {};
  let tokenIndex = 0;
  
  for (const mint of tokens) {
    tokenIndex++;
    const info = getTokenInfo(mint);
    console.log(`[${tokenIndex}/${tokens.length}] ${info.symbol}...`);
    
    const buyers = await getTokenBuyers(mint);
    
    if (buyers.length === 0) {
      console.log('  ⚠️ No buyers');
      continue;
    }
    
    console.log(`  👥 ${buyers.length} buyers`);
    
    for (const buyer of buyers) {
      const wallet = buyer.address;
      if (BLACKLISTED.has(wallet)) continue;
      
      if (!scores[wallet]) {
        scores[wallet] = {
          address: wallet,
          totalTokens: 0,
          earlyEntryScore: 0,
          volumeScore: 0,
          performanceScore: 0
        };
      }
      
      const w = scores[wallet];
      w.totalTokens++;
      
      const buyerRank = buyers.findIndex(b => b.address === wallet);
      const percentile = buyerRank / buyers.length;
      
      if (percentile <= 0.05) w.earlyEntryScore += 15;
      else if (percentile <= 0.10) w.earlyEntryScore += 10;
      else if (percentile <= 0.20) w.earlyEntryScore += 5;
    }
    
    const topWallet = Object.values(scores).sort((a, b) => b.totalTokens - a.totalTokens)[0];
    if (topWallet) {
      console.log(`  🔝 Top: ${topWallet.totalTokens} tokens`);
    }
    
    await new Promise(r => setTimeout(r, 2000));
  }
  
  const walletList = Object.values(scores);
  console.log(`\nFound ${walletList.length} wallets`);
  
  const candidates = walletList
    .filter(w => !isBot(w) && w.totalTokens >= 1)
    .sort((a, b) => {
      const scoreA = a.earlyEntryScore + a.volumeScore + a.performanceScore * 0.5;
      const scoreB = b.earlyEntryScore + b.volumeScore + b.performanceScore * 0.5;
      return scoreB - scoreA;
    });
  
  console.log(`Candidates: ${candidates.length}`);
  
  const profitable = [];
  
  for (const wallet of candidates.slice(0, topN)) {
    console.log(`Analyzing ${wallet.address.slice(0, 8)}...`);
    
    const analysis = await analyzeWalletProfit(wallet.address);
    
    if (analysis.profitUSD >= 10 || analysis.profit >= 0.1) {
      console.log(`  ✅ Profitable trader!`);
      profitable.push({
        ...wallet,
        ...analysis
      });
    } else {
      console.log(`  ❌ Not profitable enough`);
    }
  }
  
  console.log(`\n✅ Found ${profitable.length} profitable smart money wallets`);
  
  for (const wallet of profitable) {
    trackedWallets.set(wallet.address, {
      address: wallet.address,
      addedAt: Date.now(),
      profitUSD: wallet.profitUSD,
      profitSOL: wallet.profit,
      tokens: wallet.totalTokens,
      swaps: wallet.swapCount
    });
  }
  
  if (profitable.length > 0 && TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID) {
    const msg = `🎯 <b>Smart Money Found</b>\n\n${profitable.map(w => 
      `<code>${w.address.slice(0, 6)}...${w.address.slice(-4)}</code>\n💰 $${w.profitUSD.toFixed(2)} | ${w.swapCount} trades`
    ).join('\n\n')}`;
    await sendTelegram(msg);
  }
  
  return {
    discoveredWallets: profitable,
    stats: {
      tokensAnalyzed: tokens.length,
      walletsScanned: walletList.length,
      smartMoneyFound: profitable.length
    }
  };
}

app.get('/api/discover', async (req, res) => {
  const { limit = 20, top = 5, alert = 'false' } = req.query;
  try {
    const result = await discoverSmartMoney(parseInt(limit), parseInt(top));
    res.json({
      success: true,
      ...result,
      telegramEnabled: !!(TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID)
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/track/:address', async (req, res) => {
  const { address } = req.params;
  if (trackedWallets.has(address)) return res.json({ success: false, message: 'Already tracked' });
  
  trackedWallets.set(address, { address, addedAt: Date.now(), alerts: [] });
  
  if (TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID) {
    await sendTelegram(`✅ <b>Tracking</b>\n\n<code>${address.slice(0, 6)}...${address.slice(-4)}</code>\n\nTotal: ${trackedWallets.size}`);
  }
  
  res.json({ success: true, trackedCount: trackedWallets.size });
});

app.delete('/api/track/:address', (req, res) => {
  const { address } = req.params;
  if (!trackedWallets.has(address)) return res.json({ success: false });
  
  trackedWallets.delete(address);
  activeAlerts.delete(address);
  
  res.json({ success: true, trackedCount: trackedWallets.size });
});

app.get('/api/tracked', (req, res) => {
  res.json({
    success: true,
    trackedWallets: Array.from(trackedWallets.values()),
    count: trackedWallets.size
  });
});

app.get('/api/alerts', (req, res) => {
  res.json({
    success: true,
    alerts: Array.from(activeAlerts.values())
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, 50)
  });
});

app.get('/', (req, res) => {
  res.json({
    status: 'Elite Tracker v4.5 - Smart Money Discovery with Enhanced Debugging',
    telegram: { configured: !!(TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID) },
    manualTokens: {
      enabled: !!TARGET_TOKENS,
      count: TARGET_TOKENS ? TARGET_TOKENS.split(',').length : 0
    },
    endpoints: {
      discover: '/api/discover?limit=20&top=5&alert=true',
      track: 'POST /api/track/:address',
      tracked: '/api/tracked'
    }
  });
});

loadTokens();

app.listen(PORT, '0.0.0.0', () => {
  console.log('🚀 Elite Tracker v4.5 - Smart Money Discovery with Enhanced Debugging');
  console.log(`📱 Telegram: ${TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID ? '✅' : '❌'}`);
  console.log(`📋 Manual Tokens: ${TARGET_TOKENS ? `✅ (${TARGET_TOKENS.split(',').length} tokens)` : '❌ (using auto-discovery)'}`);
});