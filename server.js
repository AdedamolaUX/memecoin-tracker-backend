const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

const BIRDEYE_API_KEY = '73e8a243fd26414098b027317db6cbfd';
const HELIUS_API_KEY = 'a6f9ba84-1abf-4c90-8e04-fc0a61294407';
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';

let tokenCache = {};
const trackedWallets = new Map();
const walletClusters = new Map();
const activeAlerts = new Map();

const BLACKLISTED = new Set([
  'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4', 'JUP4Fb2cqiRUcaTHdrPC8h2gNsA2ETXiPDD33WcGuJB',
  'JUP2jxvXaqu7NQY1GmNF4m1vodw12LVXYxbFL2uJvfo', '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',
  '5Q544fKrFoe6tsEbD7S8EmEunGAV1gnGo', 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc',
  'AC5RDfQFmDS1deWZos921JfqscXdByf8BKHs5ACWjtL', '5VCwKtCXgCJ6kit5FybXjvriW3xELsFDhYrPSqtJNmcD',
  'GUfCR9mK6azb9vcpsxgXyj7XRPAKJd4KMHTTVvtncGgp', '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
  'CebN5WGQ4jvEPvsVU4EoHEpgzq1VV7AbicfhtW4xC9iM',
]);

// TELEGRAM
async function sendTelegram(msg) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return false;
  try {
    const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: msg, parse_mode: 'HTML', disable_web_page_preview: true })
    });
    const data = await res.json();
    return data.ok;
  } catch { return false; }
}

async function alertElite(w) {
  const ws = w.address.slice(0, 6) + '...' + w.address.slice(-4);
  let msg = `💎 <b>ELITE WALLET #${w.rank}</b>\n\n${w.badge} ${w.tier}\n<code>${ws}</code>\n\n`;
  msg += `💰 Total Profit: ${w.totalProfit} SOL\n`;
  msg += `📊 Realized: ${w.realizedProfit} SOL\n`;
  msg += `💼 Unrealized: ${w.unrealizedPNL} SOL\n`;
  msg += `📈 Margin: ${w.profitMargin}%\n`;
  msg += `🎯 ${w.earlyBuys} early buys\n`;
  msg += `📊 ${w.totalTokensTraded} tokens traded\n`;
  if (w.fundingWallet) {
    const fs = w.fundingWallet.slice(0, 6) + '...' + w.fundingWallet.slice(-4);
    msg += `\n👥 <b>Cluster:</b>\nFunding: <code>${fs}</code>\nSize: ${w.clusterSize} wallets\n`;
  }
  msg += `\n🔗 <a href="https://solscan.io/account/${w.address}">View on Solscan</a>`;
  await sendTelegram(msg);
}

async function alertTrade(a) {
  const ws = a.walletAddress.slice(0, 6) + '...' + a.walletAddress.slice(-4);
  let msg = `🚨 <b>NEW TRADE ALERT</b>\n\n👤 <code>${ws}</code>\n⏰ ${new Date(a.timestamp * 1000).toLocaleString()}\n\n🪙 <b>Bought:</b>\n`;
  (a.tokensBought || []).forEach(t => msg += `  • ${t.mint.slice(0, 6)}...${t.mint.slice(-4)}\n    Amount: ${t.amount || 'Unknown'}\n`);
  msg += `\n🔗 <a href="https://solscan.io/account/${a.walletAddress}">Solscan</a>`;
  if (a.tokensBought && a.tokensBought[0]) {
    msg += `\n📊 <a href="https://dexscreener.com/solana/${a.tokensBought[0].mint}">DexScreener</a>`;
  }
  await sendTelegram(msg);
}

// GET TOKEN PRICE IN SOL
async function getTokenPriceInSOL(tokenMint) {
  try {
    const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${tokenMint}`);
    const data = await res.json();
    if (data && data.pairs && data.pairs[0]) {
      const priceUSD = parseFloat(data.pairs[0].priceUsd) || 0;
      // Get SOL price in USD
      const solRes = await fetch('https://api.dexscreener.com/latest/dex/tokens/So11111111111111111111111111111111111111112');
      const solData = await solRes.json();
      const solPriceUSD = parseFloat(solData.pairs?.[0]?.priceUsd) || 100;
      return priceUSD / solPriceUSD; // Token price in SOL
    }
    return 0;
  } catch { return 0; }
}

// GET WALLET TOKEN BALANCES
async function getWalletBalances(addr) {
  try {
    const res = await fetch(`https://api.helius.xyz/v0/addresses/${addr}/balances?api-key=${HELIUS_API_KEY}`);
    const data = await res.json();
    if (!data || !data.tokens) return [];
    
    return data.tokens.map(t => ({
      mint: t.mint,
      amount: t.amount / Math.pow(10, t.decimals || 9)
    }));
  } catch { return []; }
}

// WALLET CLUSTER
async function findFunding(addr) {
  try {
    const res = await fetch(`https://api.helius.xyz/v0/addresses/${addr}/transactions?api-key=${HELIUS_API_KEY}&limit=100`);
    const txs = await res.json();
    if (!Array.isArray(txs)) return null;
    
    const deps = {};
    txs.forEach(tx => {
      if (tx.nativeTransfers) tx.nativeTransfers.forEach(t => {
        if (t.toUserAccount === addr && t.fromUserAccount !== addr) {
          if (!deps[t.fromUserAccount]) deps[t.fromUserAccount] = 0;
          deps[t.fromUserAccount] += t.amount / 1e9;
        }
      });
    });
    
    const sorted = Object.entries(deps).sort((a, b) => b[1] - a[1]);
    if (sorted.length === 0 || BLACKLISTED.has(sorted[0][0])) return null;
    return { fundingWallet: sorted[0][0], totalFunded: sorted[0][1] };
  } catch { return null; }
}

async function findCluster(funding) {
  try {
    const res = await fetch(`https://api.helius.xyz/v0/addresses/${funding}/transactions?api-key=${HELIUS_API_KEY}&limit=200`);
    const txs = await res.json();
    if (!Array.isArray(txs)) return [];
    
    const wallets = new Set();
    txs.forEach(tx => {
      if (tx.nativeTransfers) tx.nativeTransfers.forEach(t => {
        if (t.fromUserAccount === funding && t.toUserAccount !== funding) wallets.add(t.toUserAccount);
      });
    });
    return Array.from(wallets);
  } catch { return []; }
}

// PROFIT ANALYSIS WITH UNREALIZED PNL
async function analyzeProfit(addr) {
  try {
    const res = await fetch(`https://api.helius.xyz/v0/addresses/${addr}/transactions?api-key=${HELIUS_API_KEY}&limit=50`);
    const txs = await res.json();
    if (!Array.isArray(txs)) return { isProfitable: false, totalProfit: 0, realizedProfit: 0, unrealizedPNL: 0 };
    
    // Calculate realized profit (SOL in/out from swaps)
    let solIn = 0, solOut = 0;
    const tokensBought = {}; // Track tokens bought with their cost
    
    txs.forEach(tx => {
      if (tx.type === 'SWAP' && tx.nativeTransfers && tx.tokenTransfers) {
        // Track SOL spent/received
        tx.nativeTransfers.forEach(t => {
          const amt = t.amount / 1e9;
          if (t.fromUserAccount === addr) solIn += amt;
          if (t.toUserAccount === addr) solOut += amt;
        });
        
        // Track tokens bought (for unrealized PNL calculation)
        tx.tokenTransfers.forEach(t => {
          if (t.toUserAccount === addr && t.mint !== 'So11111111111111111111111111111111111111112') {
            if (!tokensBought[t.mint]) tokensBought[t.mint] = { amount: 0, costInSOL: 0 };
            
            // Find corresponding SOL spent in this transaction
            const solSpent = tx.nativeTransfers
              .filter(nt => nt.fromUserAccount === addr)
              .reduce((sum, nt) => sum + (nt.amount / 1e9), 0);
            
            tokensBought[t.mint].costInSOL += solSpent;
          }
        });
      }
    });
    
    const realizedProfit = solOut - solIn;
    
    // Calculate unrealized PNL (current holdings)
    let unrealizedPNL = 0;
    const balances = await getWalletBalances(addr);
    
    for (const balance of balances) {
      if (balance.mint === 'So11111111111111111111111111111111111111112') continue; // Skip SOL
      
      const priceInSOL = await getTokenPriceInSOL(balance.mint);
      const currentValueInSOL = balance.amount * priceInSOL;
      
      // If we tracked the cost, calculate PNL; otherwise just count current value
      if (tokensBought[balance.mint]) {
        unrealizedPNL += (currentValueInSOL - tokensBought[balance.mint].costInSOL);
      } else {
        // Conservative: assume they got it for free (airdrop, etc.)
        unrealizedPNL += currentValueInSOL;
      }
      
      await new Promise(r => setTimeout(r, 200)); // Rate limit
    }
    
    const totalProfit = realizedProfit + unrealizedPNL;
    
    return { 
      isProfitable: totalProfit >= 0.1, 
      totalProfit,
      realizedProfit,
      unrealizedPNL,
      profitMargin: solIn > 0 ? (totalProfit / solIn) * 100 : 0 
    };
  } catch (e) { 
    console.error('Profit analysis error:', e.message);
    return { isProfitable: false, totalProfit: 0, realizedProfit: 0, unrealizedPNL: 0 }; 
  }
}

// MONITORING
async function monitorWallet(addr) {
  try {
    const res = await fetch(`https://api.helius.xyz/v0/addresses/${addr}/transactions?api-key=${HELIUS_API_KEY}&limit=5`);
    const txs = await res.json();
    if (!Array.isArray(txs) || txs.length === 0) return null;
    
    const tx = txs[0];
    const lastSeen = activeAlerts.get(addr)?.timestamp || 0;
    if (tx.timestamp <= lastSeen) return null;
    
    if (tx.type === 'SWAP' && tx.tokenTransfers) {
      const bought = tx.tokenTransfers.filter(t => t.toUserAccount === addr).map(t => ({ mint: t.mint, amount: t.tokenAmount }));
      if (bought.length > 0) {
        const alert = { walletAddress: addr, timestamp: tx.timestamp, tokensBought: bought };
        activeAlerts.set(addr, alert);
        return alert;
      }
    }
    return null;
  } catch { return null; }
}

setInterval(async () => {
  if (trackedWallets.size === 0) return;
  console.log(`🔍 Monitoring ${trackedWallets.size} wallets...`);
  for (const [addr, data] of trackedWallets) {
    const alert = await monitorWallet(addr);
    if (alert) {
      console.log('🚨 Trade detected:', addr.slice(0, 8));
      await alertTrade(alert);
      if (!data.alerts) data.alerts = [];
      data.alerts.unshift(alert);
      data.alerts = data.alerts.slice(0, 20);
    }
    await new Promise(r => setTimeout(r, 500));
  }
}, 30000);

// HELPERS
async function loadTokens() {
  try {
    const res = await fetch('https://raw.githubusercontent.com/solana-labs/token-list/main/src/tokens/solana.tokenlist.json');
    const data = await res.json();
    data.tokens.forEach(t => tokenCache[t.address] = { symbol: t.symbol, name: t.name });
    console.log('✅ Loaded', Object.keys(tokenCache).length, 'tokens');
  } catch (e) { console.error('Token registry error:', e.message); }
}

function isBot(w) {
  return w.totalTokens > 50 || ((Date.now() / 1000 - w.lastActivity) / 86400 < 1 && w.totalTokens > 10);
}

function isProgram(addr) {
  return /pump$/i.test(addr) || /111111/.test(addr) || /AToken/.test(addr) || /ZZZZ/i.test(addr);
}

function getTier(p) {
  if (p >= 95) return { tier: 'LEGENDARY', emoji: '👑', color: '#FFD700' };
  if (p >= 90) return { tier: 'ELITE', emoji: '💎', color: '#B9F2FF' };
  if (p >= 80) return { tier: 'EXPERT', emoji: '⚡', color: '#9D4EDD' };
  if (p >= 70) return { tier: 'ADVANCED', emoji: '🔥', color: '#FF6B35' };
  if (p >= 60) return { tier: 'SKILLED', emoji: '⭐', color: '#F72585' };
  return { tier: 'PROFICIENT', emoji: '📈', color: '#4361EE' };
}

// API ENDPOINTS
app.get('/api/discover', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 40, 50);
    const top = Math.min(parseInt(req.query.top) || 10, 20);
    const minProfit = parseFloat(req.query.minProfit) || 0.1;
    const alert = req.query.alert === 'true';

    console.log('=== DISCOVERY START ===');
    console.log('Params:', { limit, top, minProfit, alert });

    const scores = {};
    const tokenData = {};
    let analyzed = 0, errors = 0, filtered = 0;

    // Fetch new tokens
    const dexRes = await fetch('https://api.dexscreener.com/latest/dex/search?q=new&chain=solana');
    const dexData = await dexRes.json();
    const tokens = (dexData.pairs || []).filter(p => p.chainId === 'solana').slice(0, limit);
    
    console.log(`Analyzing ${tokens.length} tokens...`);

    // Analyze each token
    for (const token of tokens) {
      const mint = token.baseToken.address;
      tokenData[mint] = { symbol: token.baseToken.symbol, change24h: token.priceChange?.h24 || 0 };
      
      try {
        const txRes = await fetch(`https://api.helius.xyz/v0/addresses/${mint}/transactions?api-key=${HELIUS_API_KEY}&limit=100`);
        const txs = await txRes.json();
        if (!Array.isArray(txs) || txs.length === 0) { errors++; continue; }
        
        analyzed++;
        const buyers = new Map();
        
        txs.forEach(tx => {
          if (tx.tokenTransfers) tx.tokenTransfers.forEach(t => {
            if (t.mint === mint && t.toUserAccount && !BLACKLISTED.has(t.toUserAccount) && !isProgram(t.toUserAccount)) {
              if (!buyers.has(t.toUserAccount)) buyers.set(t.toUserAccount, tx.timestamp);
            }
          });
        });
        
        const sorted = Array.from(buyers.entries()).sort((a, b) => a[1] - b[1]);
        sorted.forEach(([wallet, ts], i) => {
          if (!scores[wallet]) scores[wallet] = { address: wallet, earlyEntryScore: 0, successScore: 0, totalTokens: 0, earlyBuyCount: 0, lastActivity: 0, tokensFound: [] };
          
          const w = scores[wallet];
          w.totalTokens++;
          w.lastActivity = Math.max(w.lastActivity, ts);
          
          const percentile = ((i + 1) / sorted.length) * 100;
          if (percentile <= 5) { w.earlyEntryScore += 10; w.earlyBuyCount++; }
          else if (percentile <= 10) { w.earlyEntryScore += 7; w.earlyBuyCount++; }
          
          const perf = tokenData[mint].change24h;
          if (perf > 100) w.successScore += 15;
          else if (perf > 50) w.successScore += 10;
          else if (perf > 20) w.successScore += 5;
          
          w.tokensFound.push({ symbol: tokenData[mint].symbol, performance: perf });
        });
        
        await new Promise(r => setTimeout(r, 800));
      } catch { errors++; }
    }

    console.log(`Found ${Object.keys(scores).length} wallets`);
    console.log('Analyzing profitability (including unrealized PNL)...');

    // Filter and analyze profitability
    const candidates = Object.values(scores)
      .filter(w => !isBot(w) && w.totalTokens >= 2)
      .sort((a, b) => (b.earlyEntryScore + b.successScore) - (a.earlyEntryScore + a.successScore))
      .slice(0, top * 2);
    
    const elite = [];
    for (const w of candidates) {
      console.log(`Checking ${w.address.slice(0, 8)}...`);
      
      const profit = await analyzeProfit(w.address);
      if (!profit.isProfitable || profit.totalProfit < minProfit) {
        filtered++;
        console.log(`  ❌ Total profit: ${profit.totalProfit.toFixed(3)} SOL (realized: ${profit.realizedProfit.toFixed(3)}, unrealized: ${profit.unrealizedPNL.toFixed(3)})`);
        continue;
      }
      
      console.log(`  ✅ Total: ${profit.totalProfit.toFixed(2)} SOL (realized: ${profit.realizedProfit.toFixed(2)}, unrealized: ${profit.unrealizedPNL.toFixed(2)})`);
      
      const funding = await findFunding(w.address);
      let cluster = [];
      if (funding) {
        cluster = await findCluster(funding.fundingWallet);
        walletClusters.set(funding.fundingWallet, cluster);
        console.log(`  👥 Cluster: ${cluster.length} wallets`);
      }
      
      w.totalProfit = profit.totalProfit;
      w.realizedProfit = profit.realizedProfit;
      w.unrealizedPNL = profit.unrealizedPNL;
      w.profitMargin = profit.profitMargin;
      w.fundingWallet = funding?.fundingWallet || null;
      w.clusterSize = cluster.length;
      
      elite.push(w);
      await new Promise(r => setTimeout(r, 1500)); // Slower for price lookups
      if (elite.length >= top) break;
    }

    console.log(`✅ Found ${elite.length} ELITE wallets`);

    const discovered = elite.map((w, i) => {
      const tier = getTier(95);
      return {
        rank: i + 1,
        address: w.address,
        tier: tier.tier,
        badge: tier.emoji,
        tierColor: tier.color,
        totalProfit: w.totalProfit.toFixed(2),
        realizedProfit: w.realizedProfit.toFixed(2),
        unrealizedPNL: w.unrealizedPNL.toFixed(2),
        profitMargin: w.profitMargin.toFixed(1),
        earlyBuys: w.earlyBuyCount,
        totalTokensTraded: w.totalTokens,
        fundingWallet: w.fundingWallet,
        clusterSize: w.clusterSize,
        tokensFound: w.tokensFound.slice(0, 3)
      };
    });

    // Send Telegram alerts
    if (alert && discovered.length > 0) {
      console.log(`📱 Sending alerts for ${Math.min(3, discovered.length)} wallets...`);
      for (const w of discovered.slice(0, 3)) {
        await alertElite(w);
        await new Promise(r => setTimeout(r, 1000));
      }
    }

    res.json({
      success: true,
      discoveredWallets: discovered,
      stats: { 
        tokensAnalyzed: analyzed, 
        walletsScanned: Object.keys(scores).length, 
        eliteWalletsFound: elite.length,
        heliusErrors: errors,
        filteredLowProfit: filtered,
        minProfitThreshold: `${minProfit} SOL (total including unrealized)`
      },
      telegramEnabled: !!(TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID),
      timestamp: new Date()
    });
  } catch (error) {
    console.error('Discovery error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/track/:address', async (req, res) => {
  const { address } = req.params;
  if (trackedWallets.has(address)) return res.json({ success: false, message: 'Already tracked' });
  
  trackedWallets.set(address, { address, addedAt: Date.now(), alerts: [] });
  console.log(`✅ Tracking: ${address.slice(0, 8)}...`);
  
  if (TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID) {
    await sendTelegram(`✅ <b>Tracking Started</b>\n\n<code>${address.slice(0, 6)}...${address.slice(-4)}</code>\n\nTotal: ${trackedWallets.size}\nMonitoring: Every 30 seconds`);
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
  res.json({ success: true, trackedWallets: Array.from(trackedWallets.values()), count: trackedWallets.size });
});

app.get('/api/alerts', (req, res) => {
  res.json({ success: true, alerts: Array.from(activeAlerts.values()).sort((a, b) => b.timestamp - a.timestamp).slice(0, 50) });
});

app.get('/api/clusters', (req, res) => {
  res.json({ success: true, clusters: Array.from(walletClusters.entries()).map(([f, w]) => ({ fundingWallet: f, walletCount: w.length, wallets: w.slice(0, 10) })) });
});

app.get('/api/telegram/test', async (req, res) => {
  const sent = await sendTelegram('🧪 <b>Test Alert</b>\n\nBot is working! ✅');
  res.json({ success: sent, configured: !!(TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID) });
});

app.post('/api/telegram/test', async (req, res) => {
  const sent = await sendTelegram('🧪 <b>Test Alert</b>\n\nBot is working! ✅');
  res.json({ success: sent, configured: !!(TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID) });
});

app.get('/', (req, res) => {
  res.json({ 
    status: 'Elite Tracker v3.1 - LIVE (with Unrealized PNL)',
    telegram: { configured: !!(TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID) },
    endpoints: {
      discover: '/api/discover?limit=40&top=10&alert=true&minProfit=0.1',
      track: 'POST /api/track/:address',
      untrack: 'DELETE /api/track/:address',
      tracked: '/api/tracked',
      alerts: '/api/alerts',
      clusters: '/api/clusters',
      test: '/api/telegram/test'
    },
    stats: { tracked: trackedWallets.size, clusters: walletClusters.size, alerts: activeAlerts.size },
    features: [
      'Elite wallet discovery (>0.1 SOL total profit)',
      'Realized + Unrealized PNL tracking',
      'Wallet cluster detection',
      'Real-time monitoring (30s intervals)',
      'Telegram alerts',
      'Bot & institutional filtering'
    ]
  });
});

loadTokens();
app.listen(PORT, '0.0.0.0', () => {
  console.log('🚀 Elite Tracker v3.1 on port', PORT);
  console.log('📱 Telegram:', TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID ? '✅' : '❌');
  console.log('💼 Unrealized PNL tracking: ✅');
});
```

---

## **🆕 What Changed:**

1. **Added `getTokenPriceInSOL()`** - Gets current token price
2. **Added `getWalletBalances()`** - Gets current token holdings
3. **Enhanced `analyzeProfit()`** - Now calculates:
   - ✅ **Realized profit** (SOL in/out)
   - ✅ **Unrealized PNL** (current value of holdings)
   - ✅ **Total profit** (realized + unrealized)
4. **Updated Telegram alerts** - Shows breakdown of both
5. **Stricter filtering** - Total profit must be ≥0.1 SOL

---

## **📊 Example Output:**
```
💎 ELITE WALLET #1

👑 LEGENDARY
7xKXtg...A83T

💰 Total Profit: 3.45 SOL
📊 Realized: 2.10 SOL
💼 Unrealized: 1.35 SOL
📈 Margin: 220.5%
🎯 5 early buys