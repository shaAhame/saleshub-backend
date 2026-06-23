const router = require('express').Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { pool } = require('../db');
const { auth, adminOnly } = require('../middleware/auth');

// Login
router.post('/login', async (req, res) => {
  const { username, password } = req.body;
  try {
    const result = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
    const user = result.rows[0];
    if (!user || !(await bcrypt.compare(password, user.password)))
      return res.status(401).json({ error: 'Invalid credentials' });
    const token = jwt.sign(
      { id: user.id, username: user.username, role: user.role, branch: user.branch },
      process.env.JWT_SECRET,
      { expiresIn: '12h' }
    );
    res.json({ token, user: { id: user.id, username: user.username, role: user.role, branch: user.branch } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get all users (admin only)
router.get('/users', auth, adminOnly, async (req, res) => {
  const result = await pool.query('SELECT id, username, role, branch, created_at FROM users ORDER BY id');
  res.json(result.rows);
});

// Create user (admin only)
router.post('/users', auth, adminOnly, async (req, res) => {
  const { username, password, role, branch } = req.body;
  try {
    const hash = await bcrypt.hash(password, 10);
    const result = await pool.query(
      'INSERT INTO users (username, password, role, branch) VALUES ($1,$2,$3,$4) RETURNING id, username, role, branch',
      [username, hash, role, branch || null]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Change password
router.put('/users/:id/password', auth, async (req, res) => {
  if (req.user.role !== 'admin' && req.user.id !== parseInt(req.params.id))
    return res.status(403).json({ error: 'Forbidden' });
  const { password } = req.body;
  const hash = await bcrypt.hash(password, 10);
  await pool.query('UPDATE users SET password = $1 WHERE id = $2', [hash, req.params.id]);
  res.json({ success: true });
});

// Delete user (admin only)
router.delete('/users/:id', auth, adminOnly, async (req, res) => {
  await pool.query('DELETE FROM users WHERE id = $1', [req.params.id]);
  res.json({ success: true });
});

module.exports = router;
