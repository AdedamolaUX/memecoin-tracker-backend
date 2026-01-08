const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const cheerio = require('cheerio');

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

// Get market cap (optional fallback)
async function getTokenMarketCap(address) {
  try {
    const response = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${address}`);
    const data = await response.json();
    if (data && data.pairs && data.pairs[0]) {
      const pair = data.pairs[0];
      return {
        marketCap: pair.fdv || pair.marketCap || 0,
        priceUsd: parseFloat(pair.priceUsd) || 0,
        liquidity: pair.liquidity?.usd || 0
      };
    }
  } catch (err) {
    console.log('Market cap fetch failed:', err.message);
  }
  return { marketCap: 0, priceUsd: 0, liquidity: 0 };
}

// ANALYZE WALLET (unchanged - keep your current version)
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
      return res.json({ address, error: 'No transactions found' });
    }

    const swaps = transactions.filter(tx => tx.type === 'SWAP' || (tx.tokenTransfers && tx.tokenTransfers.length > 0));

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
      lowCapEntries,
      totalTrades: swaps.length,
      earlyEntryRate,
      successfulLowCapExits: successfulLowCapTrades,
      score: Math.min(100, lowCapEntries * 20 + earlyEntryRate),
      analyzedTokens,
      specialistBadge: isSpecialist ? 'EARLY ENTRY SPECIALIST' : null
    };

    res.json(analysis);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// AUTO-DISCOVERY - Multi-page scraping from DexScreener Solana trending
app.get('/api/discover', async (req, res) => {
  try {
    const numPages = 5; // Change to 10 for 1000 tokens if needed
    const minAbsChange = parseInt(req.query.minPump) || 50; // |change| > this %

    console.log(`Scraping first ${numPages} pages of DexScreener Solana trending...`);

    const scrapedTokens = [];

    for (let page = 1; page <= numPages; page++) {
      const url = page === 1 
        ? 'https://dexscreener.com/solana?rankBy=trendingScoreH6&order=desc'
        : `https://dexscreener.com/solana/page-${page}?rankBy=trendingScoreH6&order=desc`;

      try {
        const response = await fetch(url);
        const html = await response.text();
        const $ = cheerio.load(html);

        $('ds-token-row').each((i, elem) => {
          const symbol = $(elem).find('.ds-token-symbol').text().trim() || 'Unknown';
          const name = $(elem).find('.ds-token-name').text().trim() || 'Unknown';

          const changeText = $(elem).find('.ds-price-change-24h').text().trim();
          const change24h = parseFloat(changeText.replace('%', '')) || 0;

          const volumeText = $(elem).find('.ds-volume-24h').text().trim();
          const volume = parseFloat(volumeText.replace('$', '').replace('K', '000').replace('M', '000000')) || 0;

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

        console.log(`Page ${page}: scraped ${$('ds-token-row').length} rows`);
        await new Promise(r => setTimeout(r, 1000)); // Polite delay

      } catch (err) {
        console.error(`Error on page ${page}:`, err.message);
      }
    }

    console.log(`Total volatile tokens found: ${scrapedTokens.length}`);

    if (scrapedTokens.length === 0) {
      return res.json({
        success: true,
        discoveredWallets: [],
        scrapedTokens: 0,
        message: 'No volatile tokens found. Try lowering minPump (e.g., ?minPump=20)'
      });
    }

    // Analyze top 20 volatile tokens for wallets
    const selectedTokens = scrapedTokens.slice(0, 20);

    const walletScores = {};

    for (const token of selectedTokens) {
      let mintAddress = null;

      try {
        const pairResponse = await fetch(`https://api.dexscreener.com/latest/dex/pairs/solana/${token.pairAddress}`);
        const pairData = await pairResponse.json();
        mintAddress = pairData.pair?.baseToken?.address;
      } catch (err) {}

      if (!mintAddress) continue;

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

// DEXSCREENER proxy
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

// HOME - Fixed with useful info
app.get('/', (req, res) => {
  res.json({
    status: 'Memecoin Tracker Backend is LIVE!',
    timestamp: new Date().toISOString(),
    uptime_seconds: process.uptime(),
    endpoints: {
      discover: '/api/discover?minPump=50 (try 20 for more results)',
      wallet_analysis: '/api/wallet/WALLET_ADDRESS',
      token_details: '/api/dexscreener/TOKEN_ADDRESS'
    },
    tip: 'Use a JSON formatter extension for pretty view'
  });
});

app.use(cors());
app.use(express.json());

loadTokenRegistry();

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});