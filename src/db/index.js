const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000
});

const initDB = async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username VARCHAR(50) UNIQUE NOT NULL,
      password VARCHAR(255) NOT NULL,
      role VARCHAR(20) NOT NULL CHECK (role IN ('admin', 'manager')),
      branch VARCHAR(20) CHECK (branch IN ('Prime', 'Liberty', 'Marino') OR branch IS NULL),
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS sales (
      id SERIAL PRIMARY KEY,
      branch VARCHAR(20) NOT NULL CHECK (branch IN ('Prime', 'Liberty', 'Marino')),
      sale_date DATE NOT NULL DEFAULT CURRENT_DATE,
      inv_no VARCHAR(100),
      acc_inv_no VARCHAR(100),
      customer_name VARCHAR(255),
      contact VARCHAR(50),
      payment_method VARCHAR(50),
      sales_person VARCHAR(100),
      out_status VARCHAR(10) DEFAULT 'NO',
      cashier VARCHAR(100),
      invoice_value NUMERIC(12,2),
      cost NUMERIC(12,2),
      google_review VARCHAR(10),
      remarks TEXT,
      supplier_name VARCHAR(255),
      created_by INTEGER REFERENCES users(id),
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS sale_items (
      id SERIAL PRIMARY KEY,
      sale_id INTEGER REFERENCES sales(id) ON DELETE CASCADE,
      item_description TEXT,
      serial_imei VARCHAR(100),
      invoice_value NUMERIC(12,2),
      cost NUMERIC(12,2),
      supplier_name VARCHAR(255),
      qty INTEGER DEFAULT 1,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  const bcrypt = require('bcryptjs');
  const crypto = require('crypto');

  // First-time seed only. Passwords come from Railway variables or are random –
  // never a fixed password that is visible in the code.
  const seedPass = (envName) => process.env[envName] || crypto.randomBytes(9).toString('base64url');

  const existing = await pool.query("SELECT id FROM users WHERE username = 'admin'");
  if (existing.rows.length === 0) {
    const adminPass = seedPass('SEED_ADMIN_PASSWORD');
    await pool.query(
      "INSERT INTO users (username, password, role, branch) VALUES ($1, $2, 'admin', NULL)",
      ['admin', await bcrypt.hash(adminPass, 10)]
    );
    console.log(`✅ Seeded admin – password: ${process.env.SEED_ADMIN_PASSWORD ? '(from SEED_ADMIN_PASSWORD)' : adminPass}`);

    const managers = [
      { username: 'manager_prime', branch: 'Prime' },
      { username: 'manager_liberty', branch: 'Liberty' },
      { username: 'manager_marino', branch: 'Marino' }
    ];
    for (const m of managers) {
      const pass = seedPass('SEED_MANAGER_PASSWORD');
      await pool.query(
        "INSERT INTO users (username, password, role, branch) VALUES ($1, $2, 'manager', $3)",
        [m.username, await bcrypt.hash(pass, 10), m.branch]
      );
      console.log(`✅ Seeded ${m.username} – password: ${process.env.SEED_MANAGER_PASSWORD ? '(from SEED_MANAGER_PASSWORD)' : pass}`);
    }
    console.log('⚠️  Change these passwords from the Users page now.');
  }

  // When a password is changed, logins made before that moment stop working
  try { await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS password_changed_at TIMESTAMPTZ`); } catch (e) {}

  // A manager MUST belong to a branch (a manager with no branch could see every branch)
  try {
    await pool.query(`ALTER TABLE users ADD CONSTRAINT users_manager_needs_branch CHECK (role = 'admin' OR branch IS NOT NULL)`);
  } catch (e) {
    if (!/already exists/i.test(e.message)) {
      console.warn('⚠️  SECURITY: some manager accounts have NO branch – they are blocked until you delete or recreate them:', e.message);
    }
  }

  // Security check on every start: warn about default passwords / branchless managers
  try {
    const { rows: users } = await pool.query('SELECT username, password, role, branch FROM users');
    for (const u of users) {
      for (const weak of ['admin123', 'manager123', 'password', '12345678']) {
        if (await bcrypt.compare(weak, u.password)) {
          console.warn(`⚠️  SECURITY: user "${u.username}" still uses a default/weak password – change it now!`);
          break;
        }
      }
      if (u.role === 'manager' && !u.branch) {
        console.warn(`⚠️  SECURITY: manager "${u.username}" has no branch – this account is blocked.`);
      }
    }
  } catch (e) {
    console.warn('Security check skipped:', e.message);
  }

  // Add columns if not exist (safe for existing deployments)
  try { await pool.query(`ALTER TABLE sale_items ADD COLUMN IF NOT EXISTS invoice_value NUMERIC(12,2)`); } catch(e) {}
  try { await pool.query(`ALTER TABLE sale_items ADD COLUMN IF NOT EXISTS cost NUMERIC(12,2)`); } catch(e) {}
  try { await pool.query(`ALTER TABLE sale_items ADD COLUMN IF NOT EXISTS supplier_name VARCHAR(255)`); } catch(e) {}
  try { await pool.query(`ALTER TABLE sale_items ADD COLUMN IF NOT EXISTS qty INTEGER DEFAULT 1`); } catch(e) {}
  try { await pool.query(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS item_description TEXT`); } catch(e) {}
  try { await pool.query(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS serial_imei VARCHAR(100)`); } catch(e) {}

  // MIGRATION: Move old item_description + serial_imei from sales into sale_items
  const oldSales = await pool.query(`
    SELECT id, item_description, serial_imei, invoice_value, cost, supplier_name FROM sales
    WHERE (item_description IS NOT NULL OR serial_imei IS NOT NULL)
    AND id NOT IN (SELECT DISTINCT sale_id FROM sale_items WHERE sale_id IS NOT NULL)
  `);

  if (oldSales.rows.length > 0) {
    console.log(`🔄 Migrating ${oldSales.rows.length} old sales to sale_items...`);
    for (const sale of oldSales.rows) {
      if (sale.item_description || sale.serial_imei) {
        await pool.query(
          'INSERT INTO sale_items (sale_id, item_description, serial_imei, invoice_value, cost, supplier_name, qty) VALUES ($1,$2,$3,$4,$5,$6,$7)',
          [sale.id, sale.item_description || null, sale.serial_imei || null,
           sale.invoice_value || null, sale.cost || null, sale.supplier_name || null, 1]
        );
      }
    }
    console.log('✅ Migration complete!');
  }

  // Keep alive ping every 14 minutes
  setInterval(async () => {
    try {
      await pool.query('SELECT 1');
      console.log('Keep alive ping ✅');
    } catch (err) {
      console.error('Keep alive failed:', err.message);
    }
  }, 14 * 60 * 1000);

  console.log('✅ Database initialized');
};

module.exports = { pool, initDB };
