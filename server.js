require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const HELIUS_API_KEY = process.env.HELIUS_API_KEY;
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

async function getTokenBuyersFromHelius(tokenAddress) {
  const walletMap = new Map();
  
  try {
    console.log(`    🔍 Fetching signatures for ${tokenAddress.slice(0, 8)}...`);
    
    const sigRes = await fetch(
      `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'getSignaturesForAddress',
          params: [tokenAddress, { limit: 100 }]
        })
      }
    );
    
    const sigData = await sigRes.json();
    
    if (sigData.error) {
      console.log(`    ⚠️ Helius error: ${sigData.error.message}`);
      return [];
    }
    
    if (!sigData.result || sigData.result.length === 0) {
      console.log(`    ⚠️ No signatures found`);
      return [];
    }
    
    console.log(`    📊 Found ${sigData.result.length} signatures, analyzing...`);
    
    // Get transactions one by one
    const transactions = [];
    const signatures = sigData.result.slice(0, 30).map(s => s.signature);
    
    for (const sig of signatures) {
      const txRes = await fetch(
        `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'getTransaction',
            params: [sig, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }]
          })
        }
      );
      
      const txData = await txRes.json();
      if (txData.result) transactions.push(txData.result);
      await new Promise(r => setTimeout(r, 50));
    }
    
    // Parse transactions to find buyers
    for (const tx of transactions) {
      if (!tx || tx.meta?.err) continue;
      
      const accountKeys = tx.transaction?.message?.accountKeys;
      if (!accountKeys || accountKeys.length < 2) continue;
      
      // Get the signer (first account)
      let signer;
      if (typeof accountKeys[0] === 'string') {
        signer = accountKeys[0];
      } else if (accountKeys[0]?.pubkey) {
        signer = accountKeys[0].pubkey;
      }
      
      if (!signer || BLACKLISTED.has(signer)) continue;
      
      // Check if this involves token transfers
      const hasTokenTransfer = tx.meta?.postTokenBalances?.length > 0;
      if (!hasTokenTransfer) continue;
      
      if (!walletMap.has(signer)) {
        walletMap.set(signer, {
          address: signer,
          firstSeen: tx.blockTime || Date.now() / 1000,
          buyCount: 0
        });
      }
      
      walletMap.get(signer).buyCount++;
    }
    
    const buyers = Array.from(walletMap.values())
      .sort((a, b) => a.firstSeen - b.firstSeen);
    
    console.log(`    📊 Found ${buyers.length} unique buyers from ${transactions.length} transactions`);
    
    return buyers;
    
  } catch (err) {
    console.log(`    ⚠️ Helius fetch error:`, err.message);
    return [];
  }
}

async function analyzeWalletProfitFromHelius(address) {
  try {
    await new Promise(r => setTimeout(r, 500));
    
    console.log(`    🔍 Fetching transaction history...`);
    
    const sigRes = await fetch(
      `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'getSignaturesForAddress',
          params: [address, { limit: 100 }]
        })
      }
    );
    
    const sigData = await sigRes.json();
    
    if (sigData.error || !sigData.result) {
      console.log(`    ⚠️ No transaction data`);
      return { profit: 0, profitUSD: 0, swapCount: 0, tokenCount: 0 };
    }
    
    console.log(`    🔍 DEBUG - Found ${sigData.result.length} transactions`);
    
    // Get transactions one by one
    const transactions = [];
    const signatures = sigData.result.slice(0, 50).map(s => s.signature);
    
    for (const sig of signatures) {
      const txRes = await fetch(
        `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'getTransaction',
            params: [sig, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }]
          })
        }
      );
      
      const txData = await txRes.json();
      if (txData.result) transactions.push(txData.result);
      await new Promise(r => setTimeout(r, 50));
    }
    
    let solSpent = 0;
    let solReceived = 0;
    let swapCount = 0;
    const tokensTraded = new Set();
    
    // Analyze transactions
    for (const tx of transactions) {
      if (!tx || tx.meta?.err) continue;
      
      // Count swaps
      const hasTokenChange = tx.meta?.postTokenBalances?.length > 0;
      if (hasTokenChange) {
        swapCount++;
        
        for (const balance of tx.meta.postTokenBalances || []) {
          if (balance.mint) tokensTraded.add(balance.mint);
        }
      }
      
      // Calculate SOL flow
      const preBalance = tx.meta?.preBalances?.[0] || 0;
      const postBalance = tx.meta?.postBalances?.[0] || 0;
      const fee = tx.meta?.fee || 0;
      
      const netChange = (postBalance - preBalance + fee) / 1e9;
      
      if (netChange < 0) {
        solSpent += Math.abs(netChange);
      } else if (netChange > 0) {
        solReceived += netChange;
      }
    }
    
    const profitSOL = solReceived - solSpent;
    const profitUSD = profitSOL * 180;
    
    console.log(`    📈 ${transactions.length} txs, ${swapCount} swaps`);
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
  console.log('\n=== SMART MONEY DISCOVERY (Helius) ===');
  
  if (!HELIUS_API_KEY) {
    console.error('❌ HELIUS_API_KEY not configured!');
    return { discoveredWallets: [], stats: {} };
  }
  
  let tokens = [];
  
  if (TARGET_TOKENS) {
    tokens = TARGET_TOKENS.split(',').map(t => t.trim()).filter(Boolean);
    console.log('📋 Using manual token list');
    console.log(`✅ Loaded ${tokens.length} tokens`);
  } else {
    console.log('❌ No TARGET_TOKENS configured.');
    return { discoveredWallets: [], stats: {} };
  }
  
  const scores = {};
  let tokenIndex = 0;
  
  for (const mint of tokens) {
    tokenIndex++;
    const info = getTokenInfo(mint);
    console.log(`\n[${tokenIndex}/${tokens.length}] ${info.symbol}...`);
    
    const buyers = await getTokenBuyersFromHelius(mint);
    
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
    
    await new Promise(r => setTimeout(r, 2000));
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
    
    const analysis = await analyzeWalletProfitFromHelius(wallet.address);
    
    if (analysis.profitUSD >= 5 || analysis.profit >= 0.05 || analysis.swapCount >= 10) {
      console.log(`  ✅ SMART MONEY WALLET!`);
      profitable.push({
        ...wallet,
        ...analysis
      });
    } else {
      console.log(`  ❌ Not enough trading activity`);
    }
    
    await new Promise(r => setTimeout(r, 2000));
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
    status: 'Elite Tracker v5.1 - Helius Integration (Fixed)',
    helius: { configured: !!HELIUS_API_KEY },
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
  console.log('🚀 Elite Tracker v5.1 - Helius Integration (Fixed)');
  console.log(`📱 Telegram: ${TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID ? '✅' : '❌'}`);
  console.log(`🔑 Helius: ${HELIUS_API_KEY ? '✅' : '❌'}`);
  console.log(`📋 Manual Tokens: ${TARGET_TOKENS ? `✅ (${TARGET_TOKENS.split(',').length} tokens)` : '❌'}`);
});