// ... (top unchanged)

app.get('/api/discover', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    
    const walletScores = {};
    
    // ... (DexScreener and Birdeye fetch unchanged)
    
    for (const token of newTokens) {
      // ... (tx fetch unchanged)
      
      const owners = new Set();
      for (const tx of transactions) {
        if (tx.tokenTransfers) {
          for (const transfer of tx.tokenTransfers) {
            if (transfer.fromOwnerAccount) owners.add(transfer.fromOwnerAccount.toLowerCase());
            if (transfer.toOwnerAccount) owners.add(transfer.toOwnerAccount.toLowerCase());
            // Fallback if not parsed: use from/to as owner if not ATA pattern
          }
        }
      }
      
      for (const owner of owners) {
        if (BLACKLISTED_WALLETS.includes(owner)) continue;
        if (await isInstitutional(owner)) continue;
        
        const balance = await getWalletBalance(owner);
        if (balance < 0.01 * 10**9) continue; // <0.01 SOL
        
        if (!walletScores[owner]) {
          walletScores[owner] = {
            address: owner,
            earlyBuys: 0,
            totalTokens: 0,
            totalChangeBonus: 0,
            score: 0
          };
        }
        walletScores[owner].earlyBuys += 1;
        walletScores[owner].totalTokens += 1;
        walletScores[owner].totalChangeBonus += (mcData.change24h > 0 ? mcData.change24h : 0);
      }
      
      // delay unchanged
    }
    
    // Same for Birdeye loop (use owner instead of from/toUserAccount)
    
    // Scoring and response unchanged
    
  } catch (error) {
    // error unchanged
  }
});

// Add getWalletBalance function (lamports to SOL)
async function getWalletBalance(wallet) {
  try {
    const url = `https://api.helius.xyz/v0/addresses/${wallet}/balance?api-key=${HELIUS_API_KEY}`;
    const response = await fetch(url);
    const data = await response.json();
    return (data?.lamports || 0) / 10**9;
  } catch (err) {
    return 0;
  }
}

// ... (rest unchanged)