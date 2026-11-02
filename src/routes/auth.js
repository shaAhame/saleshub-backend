const router = require('express').Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { pool } = require('../db');
const { auth, adminOnly } = require('../middleware/auth');

const BRANCHES = ['Prime', 'Liberty', 'Marino'];

// Simple in-memory brute-force limiter: 8 failed logins / 15 min per IP+username
const fails = new Map();
const WINDOW = 15 * 60 * 1000, MAX = 8;
const key = (req, u) => `${req.ip}|${String(u || '').toLowerCase()}`;
const blocked = (k) => {
  const f = fails.get(k);
  if (!f) return false;
  if (Date.now() - f.t > WINDOW) { fails.delete(k); return false; }
  return f.n >= MAX;
};
const addFail = (k) => {
  const f = fails.get(k);
  if (!f || Date.now() - f.t > WINDOW) fails.set(k, { n: 1, t: Date.now() });
  else f.n++;
};

// Login
router.post('/login', async (req, res) => {
  const { username, password } = req.body || {};
  const k = key(req, username);
  if (blocked(k)) return res.status(429).json({ error: 'Too many attempts. Try again in 15 minutes.' });

  try {
    const result = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
    const user = result.rows[0];
    if (!user || !(await bcrypt.compare(String(password || ''), user.password))) {
      addFail(k);
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    if (user.role === 'manager' && !BRANCHES.includes(user.branch))
      return res.status(403).json({ error: 'Account has no branch assigned. Contact admin.' });

    fails.delete(k);
    const token = jwt.sign(
      { id: user.id, username: user.username, role: user.role, branch: user.branch },
      process.env.JWT_SECRET,
      { expiresIn: '8h' }
    );
    res.json({ token, user: { id: user.id, username: user.username, role: user.role, branch: user.branch } });
  } catch (err) {
    res.status(500).json({ error: 'Login failed' });
  }
});

// Who am I – role/branch straight from the database (used by the frontend on load)
router.get('/me', auth, (req, res) => {
  const { id, username, role, branch } = req.user;
  res.json({ id, username, role, branch });
});

// Get all users (admin only)
router.get('/users', auth, adminOnly, async (req, res) => {
  const result = await pool.query('SELECT id, username, role, branch, created_at FROM users ORDER BY id');
  res.json(result.rows);
});

// Create user (admin only) – a manager MUST have a valid branch
router.post('/users', auth, adminOnly, async (req, res) => {
  const { username, password, role, branch } = req.body || {};
  if (!username || !password || password.length < 8)
    return res.status(400).json({ error: 'Username and a password of 8+ characters are required' });
  if (!['admin', 'manager'].includes(role))
    return res.status(400).json({ error: 'Invalid role' });
  if (role === 'manager' && !BRANCHES.includes(branch))
    return res.status(400).json({ error: 'A manager must be assigned to Prime, Liberty or Marino' });
  try {
    const hash = await bcrypt.hash(password, 10);
    const result = await pool.query(
      'INSERT INTO users (username, password, role, branch) VALUES ($1,$2,$3,$4) RETURNING id, username, role, branch',
      [username, hash, role, role === 'admin' ? null : branch]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Update username and/or password (admin only)
router.put('/users/:id', auth, adminOnly, async (req, res) => {
  const { username, password } = req.body || {};
  if (!username) return res.status(400).json({ error: 'Username is required' });
  if (password && password.length < 8)
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  try {
    if (password) {
      const hash = await bcrypt.hash(password, 10);
      await pool.query(
        'UPDATE users SET username = $1, password = $2, password_changed_at = NOW() WHERE id = $3',
        [username, hash, req.params.id]
      );
    } else {
      await pool.query(
        'UPDATE users SET username = $1 WHERE id = $2',
        [username, req.params.id]
      );
    }
    const result = await pool.query(
      'SELECT id, username, role, branch FROM users WHERE id = $1',
      [req.params.id]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Delete user (admin only, not yourself)
// Sales keep their history: the deleted user's sales stay in the branch,
// only the "created_by" link is cleared (this was causing "Error deleting user").
router.delete('/users/:id', auth, adminOnly, async (req, res) => {
  const id = parseInt(req.params.id);
  if (req.user.id === id)
    return res.status(400).json({ error: 'You cannot delete your own account' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('UPDATE sales SET created_by = NULL WHERE created_by = $1', [id]);
    const r = await client.query('DELETE FROM users WHERE id = $1', [id]);
    await client.query('COMMIT');
    if (r.rowCount === 0) return res.status(404).json({ error: 'User not found' });
    res.json({ success: true });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(400).json({ error: err.message });
  } finally {
    client.release();
  }
});

module.exports = router;
