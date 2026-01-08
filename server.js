const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const WebSocket = require('ws'); // Add this for WS (we'll add to package.json too)

const app = express();
const PORT = process.env.PORT || 3001;

const HELIUS_API_KEY = 'a6f9ba84-1abf-4c90-8e04-fc0a61294407';

let tokenCache = {};

// Load token registry (unchanged)
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

// Get token metadata (unchanged)
async function getTokenMetadata(address) {
  // ... (keep your existing code)
}

// Get market cap (unchanged)
async function getTokenMarketCap(address) {
  // ... (keep your existing code)
}

// ANALYZE WALLET (unchanged)
app.get('/api/wallet/:address', async (req, res) => {
  // ... (keep your existing code)
});

// AUTO-DISCOVERY - Now uses DexScreener WebSocket for real-time trending (pumps & dips)
app.get('/api/discover', async (req, res) => {
  try {
    const minAbsChange = parseInt(req.query.minPump) || 50; // |change| > this %
    
    console.log('Connecting to DexScreener WebSocket for trending data...');
    
    const ws = new WebSocket('wss://io.dexscreener.com/dex/screener/pairs/h6/1?rankBy=trendingScoreH6&order=desc');
    
    let trendingPairs = [];
    
    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data);
        if (msg.pairs) {
          trendingPairs = msg.pairs.filter(p => p.chainId === 'solana');
          console.log(`Received ${trendingPairs.length} trending Solana pairs`);
          ws.close(); // Close once we have data
        }
      } catch (err) {}
    });
    
    ws.on('open', () => console.log('WS connected'));
    
    ws.on('close', () => {
      if (trendingPairs.length === 0) {
        return res.json({ message: 'No trending data received yet. Try again in a minute.' });
      }
      
      const volatileTokens = trendingPairs.filter(p => Math.abs(p.priceChange.h24 || 0) > minAbsChange && (p.volume.h24 || 0) > 20000);
      
      console.log(`Found ${volatileTokens.length} volatile tokens`);
      
      if (volatileTokens.length === 0) {
        return res.json({ message: 'No volatile tokens matching criteria. Try lower minPump.' });
      }
      
      // Proceed with wallet analysis on top 10 volatile
      // ... (same Helius logic as before, using p.baseToken.address as mintAddress, p.priceChange.h24 as changePercent)
      
      // Return discoveredWallets with negative changePercent shown
      
    });
    
    // Timeout if no data
    setTimeout(() => {
      if (trendingPairs.length === 0) {
        ws.close();
        res.json({ message: 'Timeout waiting for trending data' });
      }
    }, 10000);
    
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Other endpoints unchanged

app.use(cors());
app.use(express.json());

loadTokenRegistry();

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});