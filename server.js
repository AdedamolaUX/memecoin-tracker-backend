const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
app.use(cors());

app.get('/api/dexscreener/:token', async (req, res) => {
  try {
    const token = req.params.token;
    const url = 'https://api.dexscreener.com/latest/dex/tokens/' + token;
    const response = await fetch(url);
    const data = await response.json();
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

const PORT = 3001;
app.listen(PORT, () => {
  console.log('Server running on http://localhost:3001');
});