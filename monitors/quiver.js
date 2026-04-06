const fs = require('fs');
const path = require('path');

const envPath = path.join(__dirname, '../.env');
fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
  const [key, ...rest] = line.split('=');
  if (key && rest.length) process.env[key.trim()] = rest.join('=').trim();
});

const TOKEN = process.env.QUIVER_API_TOKEN;
const BASE  = 'https://api.quiverquant.com';

async function quiver(endpoint) {
  const res = await fetch(`${BASE}${endpoint}`, {
    headers: { 'Authorization': `Token ${TOKEN}`, 'Accept': 'application/json' },
  });
  if (!res.ok) throw new Error(`Quiver ${endpoint} → ${res.status}`);
  return res.json();
}

module.exports = { quiver };
