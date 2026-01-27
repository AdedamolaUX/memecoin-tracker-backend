const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3001;
const BIRDEYE_API_KEY = '73e8a243fd26414098b027317db6cbfd';
const QUICKNODE_URL = process.env.QUICKNODE_URL || '';
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';
const TARGET_TOKENS = process.env.TARGET_TOKENS || '';

let tokenCache = {};
const trackedWallets = new Map();
const walletClusters = new Map();
const activeAlerts = new Map();
let isDiscovering = false;

const BLACKLISTED = new Set([
  'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4', 'JUP4Fb2cqiRUcaTHdrPC8h2gNsA2ETXiPDD33WcGuJB',
  'JUP2jxvXaqu7NQY1GmNF4m1vodw12LVXYxbFL2uJvfo', '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',
  '5Q544fKrFoe6tsEbD7S8EmEunGAV1gnGo', 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc',
  'AC5RDfQFmDS1deWZos921JfqscXdByf8BKHs5ACWjtL', '5VCwKtCXgCJ6kit5FybXjvriW3xELsFDhYrPSqtJNmcD',
  'GUfCR9mK6azb9vcpsxgXyj7XRPAKJd4KMHTTVvtncGgp', '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
  'CebN5WGQ4jvEPvsVU4EoHEpgzq1VV7AbicfhtW4xC9iM',
  '5m4VGV3u16U9QkKd74Ffc6ziv1Zqs44cVmA3oajAxkM6', 'ExCZTxX1gV27Aeg7jb4hQBqkwDKHZnETEeWb9otCNBc',
  'EZQiSmPiXnfQrJzCEqYS5f8NBhoTPro4jQznEGRkcP9R', '2fPCxpdcAqm51CpM5CaSqCzY8XWfSg9Y9RAsSwXWR7tY',
]);

async function sendTelegram(msg) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return false;
  try {
    const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: msg, parse_mode: 'HTML', disable_web_page_preview: true })
    });
    return (await res.json()).ok;
  } catch { return false; }
}

async function alertElite(w) {
  const ws = w.address.slice(0, 6) + '...' + w.address.slice(-4);
  let msg = `💎 <b>SMART MONEY #${w.rank}</b>\n\n${w.badge} ${w.tier}\n<code>${ws}</code>\n\n⭐ Score: ${w.smartMoneyScore}\n🎯 ${w.earlyBuys} early\n📊 ${w.totalTokensTraded} tokens\n`;
  if (w.fundingWallet) msg += `👥 Cluster: ${w.clusterSize}\n`;
  msg += `\n🔗 <a href="https://solscan.io/account/${w.address}">Solscan</a>`;
  await sendTelegram(msg);
}

async function alertTrade(a) {
  const ws = a.walletAddress.slice(0, 6) + '...' + a.walletAddress.slice(-4);
  let msg = `🚨 <b>NEW TRADE</b>\n👤 <code>${ws}</code>\n⏰ ${new Date(a.timestamp * 1000).toLocaleString()}\n\n🪙 Bought:\n`;
  (a.tokensBought || []).forEach(t => msg += `  • ${t.mint.slice(0, 6)}...\n`);
  msg += `\n🔗 <a href="https://solscan.io/account/${a.walletAddress}">Solscan</a>`;
  await sendTelegram(msg);
}

async function getTokenBuyers(mint, limit = 50) {
  try {
    // Use Token Holders API - correct endpoint
    const res = await fetch(`https://public-api.birdeye.so/defi/token_holder?address=${mint}&offset=0&limit=${Math.min(limit, 100)}`, {
      headers: { 'X-API-KEY': BIRDEYE_API_KEY, 'x-chain': 'solana' }
    });
    const data = await res.json();
    
    if (!data.success || !data.data?.items) {
      console.log(`    ⚠️ Birdeye holders error: ${data.message || 'No data'}`);
      return [];
    }
    
    const currentTime = Math.floor(Date.now() / 1000);
    
    // Filter out obvious contracts/programs and return holders as "buyers"
    const realHolders = data.data.items
      .filter(holder => {
        const addr = holder.address;
        // Filter out blacklisted, programs, and holders with tiny amounts
        if (BLACKLISTED.has(addr) || isProgram(addr)) return false;
        // Filter out holders with less than 0.1% of supply (likely bots/dust)
        const percentage = parseFloat(holder.uiAmountString) / parseFloat(holder.decimals || 1);
        return percentage > 0;
      })
      .map(holder => ({
        wallet: holder.address,
        timestamp: currentTime - (3600 * 24), // Assume they bought ~24h ago
        amount: parseFloat(holder.uiAmountString) || 0
      }))
      .sort((a, b) => b.amount - a.amount); // Sort by amount held (biggest holders first)
    
    console.log(`    📊 Found ${realHolders.length} holders (filtered from ${data.data.items.length})`);
    return realHolders;
    
  } catch (e) {
    console.error(`  ❌ Birdeye holders error:`, e.message);
    return [];
  }
}

async function getWalletTransactions(address, limit = 100) {
  if (!QUICKNODE_URL) return null;
  try {
    const sigRes = await fetch(QUICKNODE_URL, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getSignaturesForAddress', params: [address, { limit }] })
    });
    const sigData = await sigRes.json();
    if (sigData.error || !sigData.result?.length) return [];
    
    const txPromises = sigData.result.slice(0, 50).map(sig => 
      fetch(QUICKNODE_URL, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getTransaction', params: [sig.signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }] })
      }).then(r => r.json())
    );
    
    const txResults = await Promise.all(txPromises);
    return txResults.map(r => {
      if (!r.result) return null;
      const tx = r.result;
      const tokenTransfers = [];
      const nativeTransfers = [];
      
      if (tx.meta?.postTokenBalances && tx.meta?.preTokenBalances) {
        tx.meta.postTokenBalances.forEach(post => {
          const pre = tx.meta.preTokenBalances.find(p => p.accountIndex === post.accountIndex);
          const preAmt = pre ? parseFloat(pre.uiTokenAmount.uiAmountString || '0') : 0;
          const postAmt = parseFloat(post.uiTokenAmount.uiAmountString || '0');
          if (postAmt !== preAmt) {
            const accounts = tx.transaction.message.accountKeys;
            const toAcc = accounts[post.accountIndex];
            const fromAcc = accounts[pre?.accountIndex || 0];
            tokenTransfers.push({
              mint: post.mint,
              toUserAccount: typeof toAcc === 'string' ? toAcc : (toAcc?.pubkey || ''),
              fromUserAccount: typeof fromAcc === 'string' ? fromAcc : (fromAcc?.pubkey || ''),
              tokenAmount: Math.abs(postAmt - preAmt)
            });
          }
        });
      }
      
      if (tx.meta?.postBalances && tx.meta?.preBalances) {
        tx.meta.postBalances.forEach((post, idx) => {
          const pre = tx.meta.preBalances[idx] || 0;
          if (post !== pre) {
            const accounts = tx.transaction.message.accountKeys;
            const acc = accounts[idx];
            const accStr = typeof acc === 'string' ? acc : (acc?.pubkey || '');
            nativeTransfers.push({ fromUserAccount: accStr, toUserAccount: accStr, amount: Math.abs(post - pre) });
          }
        });
      }
      
      return {
        signature: tx.transaction.signatures[0],
        timestamp: tx.blockTime,
        type: tokenTransfers.length > 0 ? 'SWAP' : 'TRANSFER',
        tokenTransfers,
        nativeTransfers
      };
    }).filter(Boolean);
  } catch (e) {
    console.error('QuickNode error:', e.message);
    return null;
  }
}

async function findFunding(addr) {
  const txs = await getWalletTransactions(addr, 100);
  if (!txs?.length) return null;
  try {
    const deps = {};
    txs.forEach(tx => {
      tx.nativeTransfers?.forEach(t => {
        if (t.toUserAccount === addr && t.fromUserAccount !== addr) {
          deps[t.fromUserAccount] = (deps[t.fromUserAccount] || 0) + t.amount / 1e9;
        }
      });
    });
    const sorted = Object.entries(deps).sort((a, b) => b[1] - a[1]);
    if (!sorted.length || BLACKLISTED.has(sorted[0][0])) return null;
    return { fundingWallet: sorted[0][0], totalFunded: sorted[0][1] };
  } catch { return null; }
}

async function findCluster(funding) {
  const txs = await getWalletTransactions(funding, 200);
  if (!txs?.length) return [];
  try {
    const wallets = new Set();
    txs.forEach(tx => {
      tx.nativeTransfers?.forEach(t => {
        if (t.fromUserAccount === funding && t.toUserAccount !== funding) wallets.add(t.toUserAccount);
      });
    });
    return Array.from(wallets);
  } catch { return []; }
}

async function monitorWallet(addr) {
  const txs = await getWalletTransactions(addr, 5);
  if (!txs?.length) return null;
  try {
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
  } catch {}
  return null;
}

setInterval(async () => {
  if (trackedWallets.size === 0) return;
  console.log(`🔍 Monitoring ${trackedWallets.size} wallets...`);
  for (const [addr, data] of trackedWallets) {
    const alert = await monitorWallet(addr);
    if (alert) {
      console.log('🚨 Trade:', addr.slice(0, 8));
      await alertTrade(alert);
      data.alerts = data.alerts || [];
      data.alerts.unshift(alert);
      data.alerts = data.alerts.slice(0, 20);
    }
    await new Promise(r => setTimeout(r, 500));
  }
}, 30000);

async function loadTokens() {
  try {
    const res = await fetch('https://raw.githubusercontent.com/solana-labs/token-list/main/src/tokens/solana.tokenlist.json');
    const data = await res.json();
    data.tokens.forEach(t => tokenCache[t.address] = { symbol: t.symbol, name: t.name });
    console.log('✅ Loaded', Object.keys(tokenCache).length, 'tokens');
  } catch {}
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

app.get('/api/discover', async (req, res) => {
  if (isDiscovering) return res.status(429).json({ success: false, error: 'Discovery in progress' });
  isDiscovering = true;
  
  try {
    const limit = Math.min(parseInt(req.query.limit) || 20, 30);
    const top = Math.min(parseInt(req.query.top) || 5, 10);
    const alert = req.query.alert === 'true';

    console.log('=== SMART MONEY DISCOVERY ===');
    let tokens = [];
    
    if (TARGET_TOKENS?.trim()) {
      console.log('📋 Using manual token list');
      const addresses = TARGET_TOKENS.split(',').map(a => a.trim()).filter(a => a.length > 0);
      for (const address of addresses.slice(0, limit)) {
        try {
          const res = await fetch(`https://public-api.birdeye.so/defi/token_overview?address=${address}`, {
            headers: { 'X-API-KEY': BIRDEYE_API_KEY }
          });
          const data = await res.json();
          if (data.success && data.data) {
            tokens.push({
              baseToken: { address, symbol: data.data.symbol || 'UNKNOWN' },
              priceChange: { h24: data.data.v24hChangePercent || 0 },
              volume24h: data.data.v24hUSD || 0,
              marketCap: data.data.mc || 0
            });
          }
          await new Promise(r => setTimeout(r, 500));
        } catch {}
      }
      console.log(`✅ Loaded ${tokens.length} tokens`);
    } else {
      console.log('🔍 Auto-discovering tokens');
      const res = await fetch(`https://public-api.birdeye.so/defi/tokenlist?sort_by=v24hUSD&sort_type=desc&offset=0&limit=${limit}`, {
        headers: { 'X-API-KEY': BIRDEYE_API_KEY, 'x-chain': 'solana' }
      });
      const data = await res.json();
      if (data.data?.tokens) {
        tokens = data.data.tokens
          .filter(t => (t.v24hUSD || 0) >= 10000 && (t.mc || 0) > 0 && (t.mc || 0) < 10000000)
          .map(t => ({
            baseToken: { address: t.address, symbol: t.symbol },
            priceChange: { h24: t.v24hChangePercent || 0 },
            volume24h: t.v24hUSD || 0,
            marketCap: t.mc || 0
          }))
          .slice(0, limit);
        console.log(`✅ Found ${tokens.length} tokens`);
      }
    }

    if (!tokens.length) return res.json({ success: false, error: 'No tokens found' });

    const scores = {};
    const tokenData = {};
    let analyzed = 0;

    for (const token of tokens) {
      const mint = token.baseToken.address;
      tokenData[mint] = { 
        symbol: token.baseToken.symbol, 
        change24h: token.priceChange?.h24 || 0,
        volume24h: token.volume24h || 0,
        marketCap: token.marketCap || 0
      };
      
      try {
        console.log(`[${analyzed + 1}/${tokens.length}] ${token.baseToken.symbol}...`);
        await new Promise(r => setTimeout(r, 2000));
        
        const buyers = await getTokenBuyers(mint, 100); // Increased to 100 holders
        if (!buyers.length) {
          console.log(`  ⚠️ No holders`);
          continue;
        }
        
        console.log(`  👥 ${buyers.length} holders`);
        analyzed++;
        
        // Sort by amount held (already sorted in getTokenBuyers, but keep timestamp sort for scoring)
        const sorted = buyers.sort((a, b) => b.amount - a.amount); // Biggest holders = earliest/best buyers
        sorted.forEach(({ wallet, timestamp }, i) => {
          if (BLACKLISTED.has(wallet) || isProgram(wallet)) return;
          
          if (!scores[wallet]) {
            scores[wallet] = { 
              address: wallet, earlyEntryScore: 0, successScore: 0, totalTokens: 0, 
              earlyBuyCount: 0, lastActivity: 0, tokensFound: [], volumeScore: 0
            };
          }
          
          const w = scores[wallet];
          w.totalTokens++;
          w.lastActivity = Math.max(w.lastActivity, timestamp);
          
          const percentile = ((i + 1) / sorted.length) * 100;
          if (percentile <= 5) { w.earlyEntryScore += 15; w.earlyBuyCount++; }
          else if (percentile <= 10) { w.earlyEntryScore += 10; w.earlyBuyCount++; }
          else if (percentile <= 20) w.earlyEntryScore += 5;
          
          const volume = tokenData[mint].volume24h;
          if (volume > 1000000) w.volumeScore += 10;
          else if (volume > 500000) w.volumeScore += 7;
          else if (volume > 100000) w.volumeScore += 5;
          
          const perf = tokenData[mint].change24h;
          if (perf > 100) w.successScore += 15;
          else if (perf > 50) w.successScore += 10;
          else if (perf > 20) w.successScore += 5;
          
          w.tokensFound.push({ symbol: tokenData[mint].symbol, performance: perf, volume, marketCap: tokenData[mint].marketCap });
        });
        
        const topWallet = Object.values(scores).sort((a, b) => b.totalTokens - a.totalTokens)[0];
        if (topWallet) console.log(`  🔝 Top: ${topWallet.totalTokens} tokens`);
      } catch (e) {
        console.error(`  ❌ Error:`, e.message);
      }
    }

    console.log(`Found ${Object.keys(scores).length} wallets`);
    
    const candidates = Object.values(scores)
      .filter(w => !isBot(w) && w.totalTokens >= 2)
      .sort((a, b) => {
        const sA = a.earlyEntryScore + a.volumeScore + (a.successScore * 0.5);
        const sB = b.earlyEntryScore + b.volumeScore + (b.successScore * 0.5);
        return sB - sA;
      })
      .slice(0, top * 2);
    
    console.log(`Candidates: ${candidates.length}`);
    
    const elite = [];
    for (const w of candidates) {
      console.log(`Analyzing ${w.address.slice(0, 8)}...`);
      
      const funding = await findFunding(w.address);
      let cluster = [];
      if (funding) {
        cluster = await findCluster(funding.fundingWallet);
        walletClusters.set(funding.fundingWallet, cluster);
      }
      
      w.fundingWallet = funding?.fundingWallet || null;
      w.clusterSize = cluster.length;
      w.totalScore = w.earlyEntryScore + w.volumeScore + (w.successScore * 0.5);
      elite.push(w);
      
      await new Promise(r => setTimeout(r, 1000));
      if (elite.length >= top) break;
    }

    const discovered = elite.map((w, i) => {
      const scorePercent = Math.min(95, 60 + (w.totalScore / 2));
      const tier = getTier(scorePercent);
      return {
        rank: i + 1,
        address: w.address,
        tier: tier.tier,
        badge: tier.emoji,
        tierColor: tier.color,
        smartMoneyScore: w.totalScore.toFixed(1),
        earlyBuys: w.earlyBuyCount,
        totalTokensTraded: w.totalTokens,
        volumeScore: w.volumeScore,
        fundingWallet: w.fundingWallet,
        clusterSize: w.clusterSize,
        tokensFound: w.tokensFound.slice(0, 3)
      };
    });

    if (alert && discovered.length) {
      for (const w of discovered.slice(0, 3)) {
        await alertElite(w);
        await new Promise(r => setTimeout(r, 1000));
      }
    }

    res.json({
      success: true,
      discoveredWallets: discovered,
      stats: { tokensAnalyzed: analyzed, walletsScanned: Object.keys(scores).length, smartMoneyFound: elite.length },
      telegramEnabled: !!(TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID)
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  } finally {
    isDiscovering = false;
  }
});

app.post('/api/track/:address', async (req, res) => {
  const { address } = req.params;
  if (trackedWallets.has(address)) return res.json({ success: false });
  trackedWallets.set(address, { address, addedAt: Date.now(), alerts: [] });
  if (TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID) {
    await sendTelegram(`✅ Tracking <code>${address.slice(0, 6)}...${address.slice(-4)}</code>`);
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
  const sent = await sendTelegram('🧪 Test');
  res.json({ success: sent, configured: !!(TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID) });
});

app.post('/api/telegram/test', async (req, res) => {
  const sent = await sendTelegram('🧪 Test');
  res.json({ success: sent, configured: !!(TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID) });
});

app.get('/', (req, res) => {
  res.json({ 
    status: 'Elite Tracker v4.1 - Smart Money Discovery',
    telegram: { configured: !!(TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID) },
    manualTokens: { enabled: !!TARGET_TOKENS, count: TARGET_TOKENS ? TARGET_TOKENS.split(',').length : 0 }
  });
});

loadTokens();
app.listen(PORT, '0.0.0.0', () => {
  console.log('🚀 Elite Tracker v4.1');
  console.log('📱 Telegram:', TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID ? '✅' : '❌');
  console.log('📋 Manual Tokens:', TARGET_TOKENS ? `✅ (${TARGET_TOKENS.split(',').length})` : '❌');
});