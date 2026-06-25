const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
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
      google_review VARCHAR(10),
      remarks TEXT,
      supplier_name VARCHAR(255),
      cost NUMERIC(12,2),
      created_by INTEGER REFERENCES users(id),
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS sale_items (
      id SERIAL PRIMARY KEY,
      sale_id INTEGER REFERENCES sales(id) ON DELETE CASCADE,
      item_description TEXT,
      serial_imei VARCHAR(100),
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  const bcrypt = require('bcryptjs');
  const existing = await pool.query("SELECT id FROM users WHERE username = 'admin'");
  if (existing.rows.length === 0) {
    const hash = await bcrypt.hash('admin123', 10);
    await pool.query(
      "INSERT INTO users (username, password, role, branch) VALUES ($1, $2, 'admin', NULL)",
      ['admin', hash]
    );
    const managers = [
      { username: 'manager_prime', branch: 'Prime' },
      { username: 'manager_liberty', branch: 'Liberty' },
      { username: 'manager_marino', branch: 'Marino' }
    ];
    for (const m of managers) {
      const h = await bcrypt.hash('manager123', 10);
      await pool.query(
        "INSERT INTO users (username, password, role, branch) VALUES ($1, $2, 'manager', $3)",
        [m.username, h, m.branch]
      );
    }
    console.log('✅ Default users seeded');
  }

  // Add sale_items table if not exists (for existing deployments)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sale_items (
      id SERIAL PRIMARY KEY,
      sale_id INTEGER REFERENCES sales(id) ON DELETE CASCADE,
      item_description TEXT,
      serial_imei VARCHAR(100),
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  console.log('✅ Database initialized');
};

module.exports = { pool, initDB };
