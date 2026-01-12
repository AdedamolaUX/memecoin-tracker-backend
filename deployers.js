const fetch = require('node-fetch');

// Helper to get deployer wallet from token creation tx
async function getTokenDeployer(mint, HELIUS_API_KEY) {
  try {
    const url = `https://api.helius.xyz/v0/addresses/${mint}/transactions?api-key=${HELIUS_API_KEY}&limit=1&type=TOKEN_MINT`;
    const response = await fetch(url);
    const transactions = await response.json();
    
    if (transactions && transactions.length > 0) {
      const creationTx = transactions[0];
      // Deployer is usually the signer or first account
      return creationTx.accounts[0].toLowerCase() || creationTx.signatures[0].signer.toLowerCase();
    }
  } catch (err) {
    console.log('Helius deployer fetch failed:', err.message);
  }
  return null;
}

// Helper to get max historical MC (approx from DexScreener)
async function getMaxHistoricalMC(mint) {
  try {
    const dexUrl = `https://api.dexscreener.com/latest/dex/tokens/${mint}`;
    const response = await fetch(dexUrl);
    const data = await response.json();
    if (data.pairs && data.pairs[0]) {
      return data.pairs[0].fdv || data.pairs[0].marketCap || 0;
    }
  } catch (err) {}
  return 0;
}

// Main function: Find successful deployers
async function getSuccessfulDeployers(limit = 50, HELIUS_API_KEY, BIRDEYE_API_KEY) {
  try {
    // Get new/trending tokens
    const newPairsUrl = 'https://api.dexscreener.com/latest/dex/search?q=new&chain=solana';
    const newResponse = await fetch(newPairsUrl);
    const newData = await newResponse.json();
    const newTokens = (newData.pairs || []).filter(p => p.chainId === 'solana').slice(0, limit);
    
    const birdeyeUrl = 'https://public-api.birdeye.so/defi/trending_tokens?chain=solana';
    const birdeyeResponse = await fetch(birdeyeUrl, {
      headers: { 'X-API-KEY': BIRDEYE_API_KEY, 'x-chain': 'solana' }
    });
    const birdeyeData = birdeyeResponse.ok ? await birdeyeResponse.json() : { data: [] };
    const trendingTokens = birdeyeData.data || [];
    
    const allTokens = [...newTokens.map(t => t.baseToken.address), ...trendingTokens.map(t => t.address)];
    
    const deployerScores = {};
    
    for (const mint of allTokens) {
      try {
        const deployer = await getTokenDeployer(mint, HELIUS_API_KEY);
        if (!deployer) continue;
        
        const maxMC = await getMaxHistoricalMC(mint);
        if (maxMC < 100000) continue; // Skip non-successful
        
        if (!deployerScores[deployer]) {
          deployerScores[deployer] = {
            address: deployer,
            successfulLaunches: 0,
            totalLaunches: 0,
            score: 0
          };
        }
        
        deployerScores[deployer].successfulLaunches += 1;
        deployerScores[deployer].totalLaunches += 1;
        deployerScores[deployer].score = deployerScores[deployer].successfulLaunches * 100 + deployerScores[deployer].totalLaunches * 10;
        
        await new Promise(r => setTimeout(r, 500)); // Rate limit
      } catch (err) {
        console.log('Error processing token', mint, ':', err.message);
      }
    }
    
    return Object.values(deployerScores)
      .sort((a, b) => b.score - a.score)
      .slice(0, 20)
      .map((d, i) => ({
        rank: i + 1,
        address: d.address,
        successScore: Math.floor(d.score),
        successfulLaunches: d.successfulLaunches,
        totalLaunches: d.totalLaunches
      }));
  } catch (error) {
    console.error('Deployers error:', error);
    return [];
  }
}

module.exports = { getSuccessfulDeployers };