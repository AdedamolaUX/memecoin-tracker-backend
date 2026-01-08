const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const cheerio = require('cheerio'); // For scraping DexScreener pages

const app = express();
const PORT = process.env.PORT || 3001;

const HELIUS_API_KEY = 'a6f9ba84-1abf-4c90-8e04-fc0a61294407';

let tokenCache = {};

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

// Get token metadata (fallback to Helius or DexScreener)
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
  } catch (err) {
    console.log('Helius metadata failed:', err.message);
  }
  
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
  } catch (err) {
    console.log('DexScreener metadata failed:', err.message);
  }
  
  return { symbol: address.slice(0, 4) + '...', name: 'Unknown' };
}

// Get market cap
async function getTokenMarketCap(address) {
  try {
    const response = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${address}`);
    const data = await response.json();
    
    if (data && data.pairs && data.pairs[0]) {
      const pair = data.pairs[0];
      return {
        marketCap: pair.fdv || pair.marketCap || 0,
        priceUsd: parseFloat(pair.priceUsd) || 0,
        liquidity: pair.liquidity?.usd || 0,
        age: pair.pairCreatedAt ? Date.now() - new Date(pair.pairCreatedAt).getTime() : null
      };
    }
  } catch (err) {
    console.log('Market cap fetch failed:', err.message);
  }
  return { marketCap: 0, priceUsd: 0, liquidity: 0, age: null };
}

// ANALYZE WALLET (unchanged)
app.get('/api/wallet/:address', async (req, res) => {
  // ... (your full existing /api/wallet code here - keep it exactly as is)
  // (I'm not repeating it to save space, but copy from your current file)
});

// AUTO-DISCOVERY - Multi-page scraping of DexScreener Solana trending (6H)
app.get('/api/discover', async (req, res) => {
  try {
    const numPages = 5; // First 5 pages = up to 500 tokens (adjust 1-10)
    const minAbsChange = parseInt(req.query.minPump) || 50; // |change| > this %
    
    console.log(`Scraping ${numPages} pages of DexScreener Solana trending (6H)...`);
    
    const scrapedTokens = [];
    
    for (let page = 1; page <= numPages; page++) {
      const url = page === 1 
        ? 'https://dexscreener.com/solana?rankBy=trendingScoreH6&order=desc'
        : `https://dexscreener.com/solana/page-${page}?rankBy=trendingScoreH6&order=desc`;
      
      try {
        const response = await fetch(url);
        const html = await response.text();
        const $ = cheerio.load(html);
        
        const rows = $('ds-token-row');
        console.log(`Page ${page}: Found ${rows.length} token rows`);
        
        rows.each((i, elem) => {
          const symbol = $(elem).find('.ds-token-symbol').text().trim() || 'Unknown';
          const name = $(elem).find('.ds-token-name').text().trim() || 'Unknown';
          
          const change24hText = $(elem).find('.ds-price-change.ds-price-change-24h').text().trim();
          const change24h = parseFloat(change24hText.replace('%', '')) || 0;
          
          const volumeText = $(elem).find('.ds-volume.ds-volume-24h').text().trim();
          const volume = parseFloat(volumeText.replace('$', '').replace('K', '000').replace('M', '000000').replace('B', '000000000')) || 0;
          
          const link = $(elem).find('a.ds-token-link').attr('href');
          const pairAddress = link ? link.split('/').pop() : null;
          
          if (pairAddress && Math.abs(change24h) > minAbsChange && volume > 20000) {
            scrapedTokens.push({
              symbol,
              name,
              change24h,
              volume,
              pairAddress
            });
          }
        });
        
        await new Promise(r => setTimeout(r, 1000)); // Be polite to server
        
      } catch (err) {
        console.error(`Error scraping page ${page}:`, err.message);
      }
    }
    
    console.log(`Scraping complete. Found ${scrapedTokens.length} volatile tokens (pumps & dips)`);
    
    if (scrapedTokens.length === 0) {
      return res.json({
        success: true,
        discoveredWallets: [],
        scrapedTokens: 0,
        message: 'No volatile tokens found on trending pages. Try lowering minPump.',
        timestamp: new Date()
      });
    }
    
    // Take top 20 volatile tokens for wallet analysis (to respect rate limits)
    const selectedTokens = scrapedTokens.slice(0, 20);
    
    const walletScores = {};
    
    for (const token of selectedTokens) {
      let mintAddress = null;
      
      // Get mint from pair address
      try {
        const pairResponse = await fetch(`https://api.dexscreener.com/latest/dex/pairs/solana/${token.pairAddress}`);
        const pairData = await pairResponse.json();
        mintAddress = pairData.pair?.baseToken?.address;
      } catch (err) {
        console.log('Failed to get mint for', token.symbol);
      }
      
      if (!mintAddress) continue;
      
      console.log('Analyzing wallets for:', token.symbol, `(${mintAddress})`, `Change: ${token.change24h}%`);
      
      try {
        const txUrl = `https://api.helius.xyz/v0/addresses/${mintAddress}/transactions?api-key=${HELIUS_API_KEY}&limit=50`;
        const txResponse = await fetch(txUrl);
        const transactions = await txResponse.json();
        
        if (!transactions || transactions.length === 0) continue;
        
        const wallets = new Set();
        
        for (const tx of transactions) {
          if (tx.tokenTransfers) {
            for (const transfer of tx.tokenTransfers) {
              if (transfer.toUserAccount) wallets.add(transfer.toUserAccount);
              if (transfer.fromUserAccount) wallets.add(transfer.fromUserAccount);
            }
          }
          if (tx.accountData) {
            for (const account of tx.accountData) {
              if (account.account) wallets.add(account.account);
            }
          }
        }
        
        for (const walletAddr of wallets) {
          if (!walletScores[walletAddr]) {
            walletScores[walletAddr] = {
              address: walletAddr,
              tokensFound: [],
              score: 0
            };
          }
          
          walletScores[walletAddr].score += Math.abs(token.change24h);
          walletScores[walletAddr].tokensFound.push({
            symbol: token.symbol,
            changePercent: token.change24h
          });
        }
        
        await new Promise(r => setTimeout(r, 500));
      } catch (err) {
        console.error('Helius error:', err.message);
      }
    }
    
    const discoveredWallets = Object.values(walletScores)
      .filter(w => w.tokensFound.length >= 1)
      .sort((a, b) => b.score - a.score)
      .slice(0, 20)
      .map((wallet, index) => ({
        rank: index + 1,
        address: wallet.address,
        score: Math.floor(wallet.score),
        tokensFound: wallet.tokensFound,
        discoveredFrom: wallet.tokensFound.map(t => t.symbol).join(', '),
        discoveredAt: new Date().toISOString()
      }));
    
    res.json({
      success: true,
      discoveredWallets,
      scrapedTokens: scrapedTokens.length,
      analyzedTokens: selectedTokens.length,
      totalWalletsFound: Object.keys(walletScores).length,
      timestamp: new Date()
    });
    
  } catch (error) {
    console.error('Discovery error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Keep your other endpoints (dexscreener, wallet, home) unchanged

app.use(cors());
app.use(express.json());

loadTokenRegistry();

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});