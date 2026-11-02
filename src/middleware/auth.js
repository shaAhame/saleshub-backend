const jwt = require('jsonwebtoken');
const { pool } = require('../db');

const BRANCHES = ['Prime', 'Liberty', 'Marino'];

// Today's date in Sri Lanka time (YYYY-MM-DD) – used to lock managers to "today"
const todayLK = () =>
  new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Colombo' });

// ───────────────────────────────────────────────────────────────
// 1. auth – verifies the token, then RE-READS the user from the DB.
//    Role and branch ALWAYS come from the database, never from the token.
//    • deleted user            → 401
//    • manager with no branch  → 403  (this was the "see every branch" leak)
// ───────────────────────────────────────────────────────────────
const auth = async (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token provided' });

  let decoded;
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }

  try {
    const { rows } = await pool.query(
      'SELECT id, username, role, branch, password_changed_at FROM users WHERE id = $1',
      [decoded.id]
    );
    const user = rows[0];
    if (!user) return res.status(401).json({ error: 'User no longer exists' });

    // Password was changed after this login → log out everywhere
    if (user.password_changed_at &&
        decoded.iat < Math.floor(new Date(user.password_changed_at).getTime() / 1000)) {
      return res.status(401).json({ error: 'Password was changed. Please log in again.' });
    }
    delete user.password_changed_at;

    if (user.role !== 'admin') {
      if (user.role !== 'manager' || !BRANCHES.includes(user.branch)) {
        return res.status(403).json({ error: 'Account has no valid branch. Contact admin.' });
      }
    }
    req.user = user; // fresh from DB
    next();
  } catch (err) {
    res.status(500).json({ error: 'Auth check failed' });
  }
};

const adminOnly = (req, res, next) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  next();
};

// ───────────────────────────────────────────────────────────────
// 2. managerScope – mounted in front of /api/sales.
//    Overwrites whatever the browser sent, so a manager can NOT use
//    another branch or another date even by calling the API directly.
//    Admin passes straight through.
// ───────────────────────────────────────────────────────────────
const managerScope = async (req, res, next) => {
  if (req.user.role === 'admin') return next();

  const branch = req.user.branch;
  const today = todayLK();
  const p = req.path;
  const isId = /^\/\d+$/.test(p);

  try {
    // Admin-only reports
    if (p.startsWith('/supplier-report')) {
      return res.status(403).json({ error: 'Admin only' });
    }

    // Exports are admin-only (same as the screen). Blocking here also stops a
    // manager pulling history through the API with ?from=&to=
    if (p.startsWith('/export')) {
      return res.status(403).json({ error: 'Admin only' });
    }

    // List (GET /) – force branch + today
    if (req.method === 'GET' && !isId) {
      req.query.branch = branch;
      if (!req.query.imei) req.query.date = today;   // IMEI lookup: own branch only, any date
      return next();
    }

    // Create – force branch + today, ignore anything from the body
    if (req.method === 'POST' && p === '/') {
      req.body = req.body || {};
      req.body.branch = branch;
      req.body.sale_date = today;
      req.body.out_status = 'NO';
      return next();
    }

    // Edit – managers cannot edit at all (delete + re-enter instead)
    if (req.method === 'PUT') {
      return res.status(403).json({ error: 'Managers cannot edit sales. Delete and re-enter.' });
    }

    // Read one / delete one – must be own branch (and today for delete)
    if (isId && (req.method === 'GET' || req.method === 'DELETE')) {
      const { rows } = await pool.query(
        'SELECT branch, sale_date::text AS d FROM sales WHERE id = $1', [p.slice(1)]
      );
      const sale = rows[0];
      if (!sale) return res.status(404).json({ error: 'Not found' });
      if (sale.branch !== branch) return res.status(403).json({ error: 'Forbidden' });
      if (req.method === 'DELETE' && sale.d !== today) {
        return res.status(403).json({ error: 'Managers can only delete today\'s entries' });
      }
      return next();
    }

    return res.status(403).json({ error: 'Forbidden' });
  } catch (err) {
    res.status(500).json({ error: 'Scope check failed' });
  }
};

module.exports = { auth, adminOnly, managerScope, todayLK };
