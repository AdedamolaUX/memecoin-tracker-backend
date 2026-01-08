// WALLET LINKING: Detect if multiple wallets belong to same trader
app.post('/api/analyze-links', async (req, res) => {
  try {
    const { wallets } = req.body; // Array of wallet addresses
    
    if (!wallets || wallets.length < 2) {
      return res.json({ error: 'Need at least 2 wallets to analyze', groups: [] });
    }
    
    console.log('Analyzing links between', wallets.length, 'wallets');
    
    // Get transaction data for all wallets
    const walletData = [];
    
    for (const address of wallets.slice(0, 10)) { // Limit to 10 to avoid rate limits
      try {
        const url = `https://api.helius.xyz/v0/addresses/${address}/transactions?api-key=${HELIUS_API_KEY}&limit=50`;
        const response = await fetch(url);
        const transactions = await response.json();
        
        if (transactions && transactions.length > 0) {
          // Extract tokens and timing
          const tokens = new Set();
          const timestamps = [];
          
          transactions.forEach(tx => {
            if (tx.tokenTransfers) {
              tx.tokenTransfers.forEach(transfer => {
                if (transfer.mint) {
                  tokens.add(transfer.mint);
                }
              });
            }
            timestamps.push(tx.timestamp);
          });
          
          walletData.push({
            address,
            tokens: Array.from(tokens),
            timestamps,
            avgTimestamp: timestamps.reduce((a, b) => a + b, 0) / timestamps.length
          });
        }
        
        await new Promise(r => setTimeout(r, 300)); // Rate limit
      } catch (err) {
        console.log('Skipping wallet:', address, err.message);
      }
    }
    
    console.log('Collected data for', walletData.length, 'wallets');
    
    // Detect links between wallets
    const links = [];
    const groups = [];
    const processed = new Set();
    
    for (let i = 0; i < walletData.length; i++) {
      if (processed.has(walletData[i].address)) continue;
      
      const group = [walletData[i]];
      processed.add(walletData[i].address);
      
      for (let j = i + 1; j < walletData.length; j++) {
        if (processed.has(walletData[j].address)) continue;
        
        const similarity = calculateWalletSimilarity(walletData[i], walletData[j]);
        
        if (similarity.score > 60) {
          group.push(walletData[j]);
          processed.add(walletData[j].address);
          
          links.push({
            wallet1: walletData[i].address,
            wallet2: walletData[j].address,
            similarity: similarity.score,
            reasons: similarity.reasons
          });
        }
      }
      
      if (group.length > 1) {
        groups.push({
          id: 'group_' + Date.now() + '_' + i,
          wallets: group.map(w => w.address),
          size: group.length,
          commonTokens: findCommonTokens(group),
          avgSimilarity: links
            .filter(l => group.some(g => g.address === l.wallet1 || g.address === l.wallet2))
            .reduce((sum, l) => sum + l.similarity, 0) / Math.max(links.length, 1)
        });
      }
    }
    
    console.log('Found', groups.length, 'linked groups');
    
    res.json({
      totalWallets: wallets.length,
      analyzedWallets: walletData.length,
      linkedGroups: groups.length,
      groups: groups,
      links: links,
      timestamp: new Date()
    });
    
  } catch (error) {
    console.error('Linking analysis error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Calculate similarity between two wallets
function calculateWalletSimilarity(wallet1, wallet2) {
  let score = 0;
  const reasons = [];
  
  // Check for common tokens
  const commonTokens = wallet1.tokens.filter(t => wallet2.tokens.includes(t));
  const tokenSimilarity = (commonTokens.length / Math.max(wallet1.tokens.length, wallet2.tokens.length)) * 100;
  score += tokenSimilarity * 0.5;
  
  if (commonTokens.length >= 3) {
    reasons.push(`${commonTokens.length} common tokens`);
  }
  
  // Check timing similarity (trading at similar times)
  const timeDiff = Math.abs(wallet1.avgTimestamp - wallet2.avgTimestamp);
  const hoursDiff = timeDiff / 3600;
  
  if (hoursDiff < 24) {
    score += 30;
    reasons.push('Similar trading times');
  } else if (hoursDiff < 168) { // 1 week
    score += 15;
  }
  
  // Check if timestamps cluster (trading within minutes of each other)
  let closeTimestamps = 0;
  for (const t1 of wallet1.timestamps) {
    for (const t2 of wallet2.timestamps) {
      if (Math.abs(t1 - t2) < 600) { // Within 10 minutes
        closeTimestamps++;
      }
    }
  }
  
  if (closeTimestamps >= 3) {
    score += 20;
    reasons.push(`${closeTimestamps} trades within 10 min`);
  }
  
  return { score: Math.min(100, Math.floor(score)), reasons };
}

// Find tokens common to all wallets in group
function findCommonTokens(wallets) {
  if (wallets.length === 0) return [];
  
  const allTokens = wallets[0].tokens;
  const common = allTokens.filter(token => 
    wallets.every(w => w.tokens.includes(token))
  );
  
  return common.slice(0, 5);
}