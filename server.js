const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

const BIRDEYE_API_KEY = '73e8a243fd26414098b027317db6cbfd';
const HELIUS_API_KEY = 'a6f9ba84-1abf-4c90-8e04-fc0a61294407';
const QUICKNODE_URL = process.env.QUICKNODE_URL || '';
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';

const useQuickNode = !!QUICKNODE_URL;
console.log('🔌 Using:', useQuickNode ? 'QuickNode' : 'Helius');

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
]);

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
  let msg = `💎 <b>ELITE WALLET #${w.rank}</b>\n\n${w.badge} ${w.tier}\n<code>${ws}</code>\n\n💰 ${w.totalProfit} SOL\n📊 Realized: ${w.realizedProfit} SOL\n📈 ${w.profitMargin}%\n🎯 ${w.earlyBuys} early\n📊 ${w.totalTokensTraded} tokens\n`;
  if (w.fundingWallet) msg += `\n👥 Cluster: <code>${w.fundingWallet.slice(0, 6)}...${w.fundingWallet.slice(-4)}</code> (${w.clusterSize})\n`;
  msg += `\n🔗 <a href="https://solscan.io/account/${w.address}">Solscan</a>`;
  await sendTelegram(msg);
}

async function alertTrade(a) {
  const ws = a.walletAddress.slice(0, 6) + '...' + a.walletAddress.slice(-4);
  let msg = `🚨 <b>NEW TRADE</b>\n\n👤 <code>${ws}</code>\n⏰ ${new Date(a.timestamp * 1000).toLocaleString()}\n\n🪙 Bought:\n`;
  (a.tokensBought || []).forEach(t => msg += `  • ${t.mint.slice(0, 6)}...${t.mint.slice(-4)}\n`);
  msg += `\n🔗 <a href="https://solscan.io/account/${a.walletAddress}">Solscan</a>`;
  if (a.tokensBought && a.tokensBought[0]) msg += `\n📊 <a href="https://dexscreener.com/solana/${a.tokensBought[0].mint}">DexScreener</a>`;
  await sendTelegram(msg);
}

async function getTokenBuyers(tokenMint, limit = 50) {
  try {
    // Ensure limit is between 1-50 for Birdeye API
    const validLimit = Math.min(Math.max(1, limit), 50);
    
    const res = await fetch(`https://public-api.birdeye.so/defi/txs/token?address=${tokenMint}&tx_type=swap&sort_type=desc&offset=0&limit=${validLimit}`, {
      headers: { 'X-API-KEY': BIRDEYE_API_KEY, 'x-chain': 'solana' }
    });
    const data = await res.json();
    
    if (!data.success) {
      console.log(`    ⚠️ Birdeye error: ${data.message || 'Unknown'}`);
      return [];
    }
    
    if (!data.data || !data.data.items || data.data.items.length === 0) {
      return [];
    }
    
    const buyers = new Map();
    data.data.items.forEach(tx => {
      if (tx.owner && tx.from && tx.to) {
        if (tx.to.address === tokenMint) {
          const wallet = tx.owner;
          const timestamp = tx.blockUnixTime || Math.floor(Date.now() / 1000);
          
          if (!buyers.has(wallet)) {
            buyers.set(wallet, timestamp);
          }
        }
      }
    });
    
    return Array.from(buyers.entries()).map(([wallet, timestamp]) => ({ wallet, timestamp }));
  } catch (e) {
    console.error(`  ❌ Birdeye txs error:`, e.message);
    return [];
  }
}

async function getTokenPriceInSOL(tokenMint) {
  try {
    const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${tokenMint}`);
    const data = await res.json();
    if (data && data.pairs && data.pairs[0]) {
      const priceUSD = parseFloat(data.pairs[0].priceUsd) || 0;
      const solRes = await fetch('https://api.dexscreener.com/latest/dex/tokens/So11111111111111111111111111111111111111112');
      const solData = await solRes.json();
      const solPriceUSD = parseFloat(solData.pairs?.[0]?.priceUsd) || 100;
      return priceUSD / solPriceUSD;
    }
    return 0;
  } catch { return 0; }
}

async function getWalletTransactions(address, limit = 100) {
  if (useQuickNode) {
    try {
      const response = await fetch(QUICKNODE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'getSignaturesForAddress',
          params: [address, { limit }]
        })
      });
      const data = await response.json();
      if (data.error) return null;
      const signatures = data.result || [];
      if (signatures.length === 0) return [];
      
      const txPromises = signatures.slice(0, Math.min(limit, 50)).map(sig => 
        fetch(QUICKNODE_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'getTransaction',
            params: [sig.signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }]
          })
        }).then(r => r.json())
      );
      
      const txResults = await Promise.all(txPromises);
      return txResults.map(r => {
        if (!r.result) return null;
        const tx = r.result;
        const tokenTransfers = [];
        const nativeTransfers = [];
        
        if (tx.meta && tx.meta.postTokenBalances && tx.meta.preTokenBalances) {
          tx.meta.postTokenBalances.forEach(post => {
            const pre = tx.meta.preTokenBalances.find(p => p.accountIndex === post.accountIndex);
            const preAmount = pre ? parseFloat(pre.uiTokenAmount.uiAmountString || '0') : 0;
            const postAmount = parseFloat(post.uiTokenAmount.uiAmountString || '0');
            if (postAmount !== preAmount) {
              const accounts = tx.transaction.message.accountKeys;
              const toAccount = accounts[post.accountIndex];
              const fromAccount = accounts[pre?.accountIndex || 0];
              
              tokenTransfers.push({
                mint: post.mint,
                toUserAccount: typeof toAccount === 'string' ? toAccount : (toAccount?.pubkey || ''),
                fromUserAccount: typeof fromAccount === 'string' ? fromAccount : (fromAccount?.pubkey || ''),
                tokenAmount: Math.abs(postAmount - preAmount)
              });
            }
          });
        }
        
        if (tx.meta && tx.meta.postBalances && tx.meta.preBalances) {
          tx.meta.postBalances.forEach((post, idx) => {
            const pre = tx.meta.preBalances[idx] || 0;
            if (post !== pre) {
              const accounts = tx.transaction.message.accountKeys;
              const account = accounts[idx];
              const accountStr = typeof account === 'string' ? account : (account?.pubkey || '');
              
              nativeTransfers.push({
                fromUserAccount: accountStr,
                toUserAccount: accountStr,
                amount: Math.abs(post - pre)
              });
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
  } else {
    try {
      const res = await fetch(`https://api.helius.xyz/v0/addresses/${address}/transactions?api-key=${HELIUS_API_KEY}&limit=${limit}`);
      return await res.json();
    } catch (e) {
      return null;
    }
  }
}

async function getWalletBalances(addr) {
  if (useQuickNode) {
    try {
      const response = await fetch(QUICKNODE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'getTokenAccountsByOwner',
          params: [addr, { programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' }, { encoding: 'jsonParsed' }]
        })
      });
      const data = await response.json();
      if (data.error || !data.result) return [];
      return data.result.value.map(account => ({
        mint: account.account.data.parsed.info.mint,
        amount: account.account.data.parsed.info.tokenAmount.uiAmount
      }));
    } catch (e) {
      return [];
    }
  } else {
    try {
      const res = await fetch(`https://api.helius.xyz/v0/addresses/${addr}/balances?api-key=${HELIUS_API_KEY}`);
      const data = await res.json();
      if (data && data.error) return [];
      if (!data || !data.tokens) return [];
      return data.tokens.map(t => ({ mint: t.mint, amount: t.amount / Math.pow(10, t.decimals || 9) }));
    } catch (e) {
      return [];
    }
  }
}

async function findFunding(addr) {
  const txs = await getWalletTransactions(addr, 100);
  if (!txs || !Array.isArray(txs)) return null;
  try {
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
  } catch (e) {
    return null;
  }
}

async function findCluster(funding) {
  const txs = await getWalletTransactions(funding, 200);
  if (!txs || !Array.isArray(txs)) return [];
  try {
    const wallets = new Set();
    txs.forEach(tx => {
      if (tx.nativeTransfers) tx.nativeTransfers.forEach(t => {
        if (t.fromUserAccount === funding && t.toUserAccount !== funding) wallets.add(t.toUserAccount);
      });
    });
    return Array.from(wallets);
  } catch (e) {
    return [];
  }
}

async function analyzeProfit(addr) {
  const txs = await getWalletTransactions(addr, 50);
  if (!txs || !Array.isArray(txs)) return { isProfitable: false, totalProfit: 0, realizedProfit: 0, unrealizedPNL: 0 };
  try {
    let solIn = 0, solOut = 0;
    txs.forEach(tx => {
      if (tx.type === 'SWAP' && tx.nativeTransfers) {
        tx.nativeTransfers.forEach(t => {
          const amt = t.amount / 1e9;
          if (t.fromUserAccount === addr) solIn += amt;
          if (t.toUserAccount === addr) solOut += amt;
        });
      }
    });
    const realizedProfit = solOut - solIn;
    const totalProfit = realizedProfit;
    return {
      isProfitable: totalProfit >= 0.1,
      totalProfit,
      realizedProfit,
      unrealizedPNL: 0,
      profitMargin: solIn > 0 ? (totalProfit / solIn) * 100 : 0
    };
  } catch (e) {
    return { isProfitable: false, totalProfit: 0, realizedProfit: 0, unrealizedPNL: 0 };
  }
}

async function monitorWallet(addr) {
  const txs = await getWalletTransactions(addr, 5);
  if (!txs || !Array.isArray(txs) || txs.length === 0) return null;
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

async function loadTokens() {
  try {
    const res = await fetch('https://raw.githubusercontent.com/solana-labs/token-list/main/src/tokens/solana.tokenlist.json');
    const data = await res.json();
    data.tokens.forEach(t => tokenCache[t.address] = { symbol: t.symbol, name: t.name });
    console.log('✅ Loaded', Object.keys(tokenCache).length, 'tokens');
  } catch (e) {}
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
  if (isDiscovering) {
    return res.status(429).json({ success: false, error: 'Discovery in progress' });
  }
  isDiscovering = true;
  
  try {
    const limit = Math.min(parseInt(req.query.limit) || 20, 30);
    const top = Math.min(parseInt(req.query.top) || 5, 10);
    const minProfit = parseFloat(req.query.minProfit) || 0.1;
    const alert = req.query.alert === 'true';

    console.log('=== DISCOVERY START ===');

    let tokens = [];
    try {
      const birdeyeRes = await fetch(`https://public-api.birdeye.so/defi/tokenlist?sort_by=v24hChangePercent&sort_type=desc&offset=0&limit=${limit}`, {
        headers: { 'X-API-KEY': BIRDEYE_API_KEY, 'x-chain': 'solana' }
      });
      const birdeyeData = await birdeyeRes.json();
      if (birdeyeData.data && birdeyeData.data.tokens) {
        tokens = birdeyeData.data.tokens.map(t => ({
          baseToken: { address: t.address, symbol: t.symbol },
          priceChange: { h24: t.v24hChangePercent || 0 }
        })).slice(0, limit);
        console.log(`✅ Birdeye: ${tokens.length} tokens`);
      }
    } catch (e) {}

    if (tokens.length === 0) {
      return res.json({ success: false, error: 'No tokens found' });
    }

    const scores = {};
    const tokenData = {};
    let analyzed = 0;

    for (const token of tokens) {
      const mint = token.baseToken.address;
      tokenData[mint] = { symbol: token.baseToken.symbol, change24h: token.priceChange?.h24 || 0 };
      
      try {
        console.log(`[${analyzed + 1}/${tokens.length}] ${token.baseToken.symbol}...`);
        await new Promise(r => setTimeout(r, 2000)); // Increased to 2s for Birdeye rate limits
        
        const buyers = await getTokenBuyers(mint, 50);
        
        if (buyers.length === 0) {
          console.log(`  ⚠️ No buyers found`);
          continue;
        }
        
        console.log(`  👥 ${buyers.length} buyers`);
        analyzed++;
        
        const sorted = buyers.sort((a, b) => a.timestamp - b.timestamp);
        
        sorted.forEach(({ wallet, timestamp }, i) => {
          if (BLACKLISTED.has(wallet) || isProgram(wallet)) return;
          
          if (!scores[wallet]) {
            scores[wallet] = { 
              address: wallet, 
              earlyEntryScore: 0, 
              successScore: 0, 
              totalTokens: 0, 
              earlyBuyCount: 0, 
              lastActivity: 0, 
              tokensFound: [] 
            };
          }
          
          const w = scores[wallet];
          w.totalTokens++;
          w.lastActivity = Math.max(w.lastActivity, timestamp);
          
          const percentile = ((i + 1) / sorted.length) * 100;
          if (percentile <= 5) { w.earlyEntryScore += 10; w.earlyBuyCount++; }
          else if (percentile <= 10) { w.earlyEntryScore += 7; w.earlyBuyCount++; }
          
          const perf = tokenData[mint].change24h;
          if (perf > 100) w.successScore += 15;
          else if (perf > 50) w.successScore += 10;
          else if (perf > 20) w.successScore += 5;
          
          w.tokensFound.push({ symbol: tokenData[mint].symbol, performance: perf });
        });
        
        const topWallet = Object.values(scores).sort((a, b) => b.totalTokens - a.totalTokens)[0];
        if (topWallet) console.log(`  🔝 Top wallet: ${topWallet.totalTokens} tokens`);
        
      } catch (e) {
        console.error(`  ❌ Error for ${token.baseToken.symbol}:`, e.message);
      }
    }

    console.log(`Found ${Object.keys(scores).length} unique wallets`);
    
    const candidates = Object.values(scores)
      .filter(w => !isBot(w) && w.totalTokens >= 2)
      .sort((a, b) => (b.earlyEntryScore + b.successScore) - (a.earlyEntryScore + a.successScore))
      .slice(0, top * 2);
    
    console.log(`Candidates (2+ tokens): ${candidates.length}`);
    
    const elite = [];
    for (const w of candidates) {
      console.log(`Checking ${w.address.slice(0, 8)}...`);
      const profit = await analyzeProfit(w.address);
      
      if (!profit.isProfitable || profit.totalProfit < minProfit) {
        console.log(`  ❌ ${profit.totalProfit.toFixed(3)} SOL`);
        continue;
      }
      
      console.log(`  ✅ ${profit.totalProfit.toFixed(2)} SOL`);
      
      const funding = await findFunding(w.address);
      let cluster = [];
      if (funding) {
        cluster = await findCluster(funding.fundingWallet);
        walletClusters.set(funding.fundingWallet, cluster);
      }
      
      w.totalProfit = profit.totalProfit;
      w.realizedProfit = profit.realizedProfit;
      w.unrealizedPNL = profit.unrealizedPNL;
      w.profitMargin = profit.profitMargin;
      w.fundingWallet = funding?.fundingWallet || null;
      w.clusterSize = cluster.length;
      
      elite.push(w);
      await new Promise(r => setTimeout(r, 2000));
      if (elite.length >= top) break;
    }

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

    if (alert && discovered.length > 0) {
      for (const w of discovered.slice(0, 3)) {
        await alertElite(w);
        await new Promise(r => setTimeout(r, 1000));
      }
    }

    res.json({
      success: true,
      discoveredWallets: discovered,
      stats: { tokensAnalyzed: analyzed, walletsScanned: Object.keys(scores).length, eliteWalletsFound: elite.length },
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
    status: 'Elite Tracker v3.7 - FIXED Buyer Discovery',
    telegram: { configured: !!(TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID) },
    endpoints: {
      discover: '/api/discover?limit=20&top=5&alert=true',
      track: 'POST /api/track/:address',
      tracked: '/api/tracked',
      test: '/api/telegram/test'
    }
  });
});

loadTokens();
app.listen(PORT, '0.0.0.0', () => {
  console.log('🚀 Elite Tracker v3.7 - FIXED Buyer Discovery');
  console.log('📱 Telegram:', TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID ? '✅' : '❌');
});