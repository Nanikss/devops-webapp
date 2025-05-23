const express = require('express');
const app = express();
const PORT = 3000;

app.get('/', (req, res) => {
  res.send('🚀 Hello from your DevOps Web App on AWS!');
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
