require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { initDB } = require('./db');
const { auth, managerScope } = require('./middleware/auth');

// Refuse to start with a missing / example JWT secret – anyone who knows the
// secret can forge an admin token and see every branch.
const weak = ['your-super-secret-key-change-this', 'any-long-random-string-here-change-this', 'secret'];
if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32 || weak.includes(process.env.JWT_SECRET)) {
  console.error('❌ JWT_SECRET is missing, too short (<32) or an example value. Set a long random value in Railway Variables.');
  process.exit(1);
}

const app = express();
app.use(cors());
app.use(express.json());

app.use('/api/auth', require('./routes/auth'));
// auth + managerScope run BEFORE the sales router: branch/date are forced for managers
app.use('/api/sales', auth, managerScope, require('./routes/sales'));
app.use('/api/purchase-invoice', require('./routes/purchase-invoice'));

app.get('/health', (_, res) => res.json({ status: 'ok' }));

const PORT = process.env.PORT || 3001;

initDB().then(() => {
  app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
}).catch(err => {
  console.error('DB init failed:', err);
  process.exit(1);
});
