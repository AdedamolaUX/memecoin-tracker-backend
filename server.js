require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const SOLSCAN_API_KEY = process.env.SOLSCAN_API_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const TARGET_TOKENS = process.env.TARGET_TOKENS || '';

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

async function getTokenBuyersFromSolscan(tokenAddress) {
  const walletMap = new Map();
  
  try {
    console.log(`    🔍 Fetching transfers for ${tokenAddress.slice(0, 8)}...`);
    
    const res = await fetch(
      `https://pro-api.solscan.io/v1.0/token/transfer?token=${tokenAddress}&page=1&page_size=100`,
      {
        headers: {
          'token': SOLSCAN_API_KEY,
          'accept': 'application/json'
        }
      }
    );
    
    if (!res.ok) {
      console.log(`    ⚠️ Solscan error: ${res.status} ${res.statusText}`);
      return [];
    }
    
    const data = await res.json();
    
    console.log(`    🔍 DEBUG - Response status: ${res.status}`);
    console.log(`    🔍 DEBUG - Data structure:`, Object.keys(data));
    console.log(`    🔍 DEBUG - Data length: ${data.data?.length || 0}`);
    
    if (!data.data || !Array.isArray(data.data)) {
      console.log(`    ⚠️ No transfer data returned`);
      return [];
    }
    
    for (const transfer of data.data) {
      const buyer = transfer.to_address;
      const amount = parseFloat(transfer.amount || 0);
      const timestamp = transfer.block_time;
      
      if (!buyer || BLACKLISTED.has(buyer)) continue;
      if (amount < 0.000001) continue;
      
      if (!walletMap.has(buyer)) {
        walletMap.set(buyer, {
          address: buyer,
          firstSeen: timestamp,
          buyCount: 0,
          totalAmount: 0
        });
      }
      
      const wallet = walletMap.get(buyer);
      wallet.buyCount++;
      wallet.totalAmount += amount;
    }
    
    const buyers = Array.from(walletMap.values())
      .sort((a, b) => a.firstSeen - b.firstSeen);
    
    console.log(`    📊 Found ${buyers.length} unique buyers from ${data.data.length} transfers`);
    
    return buyers;
    
  } catch (err) {
    console.log(`    ⚠️ Solscan fetch error:`, err.message);
    return [];
  }
}

async function analyzeWalletProfitFromSolscan(address) {
  try {
    await new Promise(r => setTimeout(r, 500));
    
    console.log(`    🔍 Fetching transaction history...`);
    
    const res = await fetch(
      `https://pro-api.solscan.io/v1.0/account/transactions?account=${address}&page=1&page_size=100`,
      {
        headers: {
          'token': SOLSCAN_API_KEY,
          'accept': 'application/json'
        }
      }
    );
    
    if (!res.ok) {
      console.log(`    ⚠️ Solscan error: ${res.status} ${res.statusText}`);
      return { profit: 0, profitUSD: 0, swapCount: 0, tokenCount: 0 };
    }
    
    const data = await res.json();
    
    console.log(`    🔍 DEBUG - API Status: ${res.status}`);
    console.log(`    🔍 DEBUG - Has data: ${!!data.data}`);
    console.log(`    🔍 DEBUG - Transactions count: ${data.data?.length || 0}`);
    
    if (!data.data || !Array.isArray(data.data)) {
      console.log(`    ⚠️ No transaction data`);
      return { profit: 0, profitUSD: 0, swapCount: 0, tokenCount: 0 };
    }
    
    let solSpent = 0;
    let solReceived = 0;
    let swapCount = 0;
    const tokensTraded = new Set();
    
    for (const tx of data.data) {
      if (!tx.parsedInstruction || tx.parsedInstruction.length === 0) continue;
      
      for (const instruction of tx.parsedInstruction) {
        if (instruction.type === 'swap' || instruction.program === 'raydium' || instruction.program === 'jupiter') {
          swapCount++;
          
          if (instruction.params) {
            if (instruction.params.source) tokensTraded.add(instruction.params.source);
            if (instruction.params.destination) tokensTraded.add(instruction.params.destination);
          }
        }
      }
      
      if (tx.lamportChange) {
        const solChange = Math.abs(tx.lamportChange) / 1e9;
        
        if (tx.lamportChange < 0) {
          solSpent += solChange;
        } else if (tx.lamportChange > 0) {
          solReceived += solChange;
        }
      }
    }
    
    const profitSOL = solReceived - solSpent;
    const profitUSD = profitSOL * 180;
    
    console.log(`    📈 ${data.data.length} txs, ${swapCount} swaps`);
    console.log(`    📈 Spent: ${solSpent.toFixed(3)} SOL | Received: ${solReceived.toFixed(3)} SOL`);
    console.log(`    💰 Profit: $${profitUSD.toFixed(2)} (${profitSOL.toFixed(3)} SOL) | Tokens: ${tokensTraded.size}`);
    
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

async function discoverSmartMoney(limit = 20, topN = 5) {
  console.log('\n=== SMART MONEY DISCOVERY (Solscan) ===');
  
  if (!SOLSCAN_API_KEY) {
    console.error('❌ SOLSCAN_API_KEY not configured!');
    return { discoveredWallets: [], stats: {} };
  }
  
  let tokens = [];
  
  if (TARGET_TOKENS) {
    tokens = TARGET_TOKENS.split(',').map(t => t.trim()).filter(Boolean);
    console.log('📋 Using manual token list');
    console.log(`✅ Loaded ${tokens.length} tokens`);
  } else {
    console.log('❌ No TARGET_TOKENS configured. Please add token addresses.');
    return { discoveredWallets: [], stats: {} };
  }
  
  const scores = {};
  let tokenIndex = 0;
  
  for (const mint of tokens) {
    tokenIndex++;
    const info = getTokenInfo(mint);
    console.log(`\n[${tokenIndex}/${tokens.length}] ${info.symbol}...`);
    
    const buyers = await getTokenBuyersFromSolscan(mint);
    
    if (buyers.length === 0) {
      console.log('  ⚠️ No buyers found');
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
          firstSeen: buyer.firstSeen
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
      console.log(`  🔝 Top wallet bought ${topWallet.totalTokens} of your tokens`);
    }
    
    await new Promise(r => setTimeout(r, 1000));
  }
  
  const walletList = Object.values(scores);
  console.log(`\n✅ Found ${walletList.length} unique wallets across all tokens`);
  
  const candidates = walletList
    .filter(w => w.totalTokens >= 1)
    .sort((a, b) => {
      const scoreA = a.earlyEntryScore + (a.totalTokens * 2);
      const scoreB = b.earlyEntryScore + (b.totalTokens * 2);
      return scoreB - scoreA;
    });
  
  console.log(`📊 Candidates for analysis: ${candidates.length}`);
  console.log(`\n=== ANALYZING TOP ${topN} WALLETS ===\n`);
  
  const profitable = [];
  
  for (const wallet of candidates.slice(0, topN)) {
    console.log(`\nAnalyzing ${wallet.address.slice(0, 8)}...${wallet.address.slice(-4)}`);
    console.log(`  📌 Bought ${wallet.totalTokens} of your tokens | Early entry score: ${wallet.earlyEntryScore}`);
    
    const analysis = await analyzeWalletProfitFromSolscan(wallet.address);
    
    if (analysis.profitUSD >= 5 || analysis.profit >= 0.05 || analysis.swapCount >= 10) {
      console.log(`  ✅ SMART MONEY WALLET!`);
      profitable.push({
        ...wallet,
        ...analysis
      });
    } else {
      console.log(`  ❌ Not enough trading activity`);
    }
    
    await new Promise(r => setTimeout(r, 1000));
  }
  
  console.log(`\n\n🎯 === RESULTS ===`);
  console.log(`✅ Found ${profitable.length} profitable smart money wallets`);
  
  if (profitable.length > 0) {
    console.log(`\n📋 Smart Money Wallets:`);
    for (const w of profitable) {
      console.log(`  • ${w.address.slice(0, 6)}...${w.address.slice(-4)}`);
      console.log(`    💰 Profit: $${w.profitUSD.toFixed(2)} (${w.profit.toFixed(3)} SOL)`);
      console.log(`    📊 ${w.swapCount} trades | ${w.tokenCount} tokens | Bought ${w.totalTokens} of YOUR tokens`);
    }
  }
  
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
    const msg = `🎯 <b>Smart Money Found!</b>\n\n${profitable.slice(0, 5).map(w => 
      `<code>${w.address.slice(0, 6)}...${w.address.slice(-4)}</code>\n💰 $${w.profitUSD.toFixed(2)} | ${w.swapCount} trades | ${w.totalTokens} of your tokens`
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
  const { limit = 20, top = 10 } = req.query;
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

app.get('/', (req, res) => {
  res.json({
    status: 'Elite Tracker v5.0 - Solscan Integration',
    solscan: { configured: !!SOLSCAN_API_KEY },
    telegram: { configured: !!(TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID) },
    manualTokens: {
      enabled: !!TARGET_TOKENS,
      count: TARGET_TOKENS ? TARGET_TOKENS.split(',').length : 0
    },
    endpoints: {
      discover: '/api/discover?top=10',
      track: 'POST /api/track/:address',
      tracked: '/api/tracked'
    }
  });
});

loadTokens();

app.listen(PORT, '0.0.0.0', () => {
  console.log('🚀 Elite Tracker v5.0 - Solscan Integration');
  console.log(`📱 Telegram: ${TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID ? '✅' : '❌'}`);
  console.log(`🔑 Solscan: ${SOLSCAN_API_KEY ? '✅' : '❌'}`);
  console.log(`📋 Manual Tokens: ${TARGET_TOKENS ? `✅ (${TARGET_TOKENS.split(',').length} tokens)` : '❌'}`);
});