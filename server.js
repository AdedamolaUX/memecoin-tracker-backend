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
  // AMM Router wallets (buy/sell in seconds)
  '5m4VGV3u16U9QkKd74Ffc6ziv1Zqs44cVmA3oajAxkM6',
  'ExCZTxX1gV27Aeg7jb4hQBqkwDKHZnETEeWb9otCNBc',
  'EZQiSmPiXnfQrJzCEqYS5f8NBhoTPro4jQznEGRkcP9R',
  '2fPCxpdcAqm51CpM5CaSqCzY8XWfSg9Y9RAsSwXWR7tY',
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
  let msg = `💎 <b>SMART MONEY WALLET #${w.rank}</b>\n\n${w.badge} ${w.tier}\n<code>${ws}</code>\n\n⭐ Score: ${w.smartMoneyScore}\n🎯 ${w.earlyBuys} early entries\n📊 ${w.totalTokensTraded} tokens\n📈 Volume Score: ${w.volumeScore}\n`;
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
    const walletActivity = new Map(); // Track buy/sell activity per wallet
    
    data.data.items.forEach(tx => {
      if (tx.owner && tx.from && tx.to) {
        const wallet = tx.owner;
        const timestamp = tx.blockUnixTime || Math.floor(Date.now() / 1000);
        
        // Track if wallet bought or sold
        if (!walletActivity.has(wallet)) {
          walletActivity.set(wallet, { buys: 0, sells: 0, timestamps: [] });
        }
        const activity = walletActivity.get(wallet);
        activity.timestamps.push(timestamp);
        
        if (tx.to.address === tokenMint) {
          activity.buys++;
          if (!buyers.has(wallet)) {
            buyers.set(wallet, timestamp);
          }
        } else if (tx.from.address === tokenMint) {
          activity.sells++;
        }
      }
    });
    
    // Filter out AMM bots: wallets that buy AND sell within same timeframe (likely bots/MEV)
    const realBuyers = Array.from(buyers.entries()).filter(([wallet, timestamp]) => {
      const activity = walletActivity.get(wallet);
      if (!activity) return false;
      
      // If wallet both bought AND sold in the same tx batch, it's likely a bot/AMM
      if (activity.buys > 0 && activity.sells > 0) {
        const timeSpan = Math.max(...activity.timestamps) - Math.min(...activity.timestamps);
        // If buy/sell happened within 60 seconds, it's a bot
        if (timeSpan < 60) {
          return false;
        }
      }
      
      // If wallet has way more sells than buys, it's likely a market maker
      if (activity.sells > activity.buys * 2) {
        return false;
      }
      
      return true;
    });
    
    return realBuyers.map(([wallet, timestamp]) => ({ wallet, timestamp }));
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
    const alert = req.query.alert === 'true';

    console.log('=== SMART MONEY DISCOVERY START ===');

    let tokens = [];
    try {
      const birdeyeRes = await fetch(`https://public-api.birdeye.so/defi/tokenlist?sort_by=v24hUSD&sort_type=desc&offset=0&limit=${limit}`, {
        headers: { 'X-API-KEY': BIRDEYE_API_KEY, 'x-chain': 'solana' }
      });
      const birdeyeData = await birdeyeRes.json();
      if (birdeyeData.data && birdeyeData.data.tokens) {
        tokens = birdeyeData.data.tokens
          .filter(t => {
            const volume24h = t.v24hUSD || 0;
            const marketCap = t.mc || 0;
            return volume24h >= 10000 && marketCap > 0 && marketCap < 10000000;
          })
          .map(t => ({
            baseToken: { address: t.address, symbol: t.symbol },
            priceChange: { h24: t.v24hChangePercent || 0 },
            volume24h: t.v24hUSD || 0,
            marketCap: t.mc || 0
          }))
          .slice(0, limit);
        console.log(`✅ Birdeye: ${tokens.length} tokens (sorted by volume, filtered for <$10M cap)`);
      }
    } catch (e) {
      console.log(`❌ Birdeye error:`, e.message);
    }

    if (tokens.length === 0) {
      return res.json({ success: false, error: 'No tokens found' });
    }

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
              tokensFound: [],
              volumeScore: 0
            };
          }
          
          const w = scores[wallet];
          w.totalTokens++;
          w.lastActivity = Math.max(w.lastActivity, timestamp);
          
          const percentile = ((i + 1) / sorted.length) * 100;
          if (percentile <= 5) { 
            w.earlyEntryScore += 15;
            w.earlyBuyCount++; 
          } else if (percentile <= 10) { 
            w.earlyEntryScore += 10;
            w.earlyBuyCount++; 
          } else if (percentile <= 20) {
            w.earlyEntryScore += 5;
          }
          
          const volume = tokenData[mint].volume24h;
          if (volume > 1000000) w.volumeScore += 10;
          else if (volume > 500000) w.volumeScore += 7;
          else if (volume > 100000) w.volumeScore += 5;
          
          const perf = tokenData[mint].change24h;
          if (perf > 100) w.successScore += 15;
          else if (perf > 50) w.successScore += 10;
          else if (perf > 20) w.successScore += 5;
          
          w.tokensFound.push({ 
            symbol: tokenData[mint].symbol, 
            performance: perf,
            volume: volume,
            marketCap: tokenData[mint].marketCap
          });
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
      .sort((a, b) => {
        const scoreA = a.earlyEntryScore + a.volumeScore + (a.successScore * 0.5);
        const scoreB = b.earlyEntryScore + b.volumeScore + (b.successScore * 0.5);
        return scoreB - scoreA;
      })
      .slice(0, top * 2);
    
    console.log(`Smart money candidates (2+ tokens): ${candidates.length}`);
    
    const elite = [];
    for (const w of candidates) {
      console.log(`Analyzing ${w.address.slice(0, 8)}... (${w.earlyBuyCount} early buys, ${w.totalTokens} tokens)`);
      
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

    if (alert && discovered.length > 0) {
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
    status: 'Elite Tracker v4.0 - Smart Money Discovery',
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
  console.log('🚀 Elite Tracker v4.0 - Smart Money Discovery');
  console.log('📱 Telegram:', TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID ? '✅' : '❌');
});