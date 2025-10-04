const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = 3000;

// Endpoint to serve vip_configs.json
app.get('/vip_configs.json', (req, res) => {
  const filePath = path.join(__dirname, 'vip_configs.json');
  fs.readFile(filePath, 'utf8', (err, data) => {
    if (err) {
      console.error('Error reading vip_configs.json:', err);
      return res.status(500).json({ error: 'Internal Server Error' });
    }
    res.setHeader('Content-Type', 'application/json');
    res.send(data);
  });
});

// Start the server
app.listen(PORT, () => {
  console.log(`✅ Server is running at http://localhost:${PORT}/vip_configs.json`);
});
