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
      row_number INTEGER,
      customer_name VARCHAR(255),
      acc_inv_no VARCHAR(100),
      contact VARCHAR(50),
      inv_no VARCHAR(100),
      item_description TEXT,
      serial_imei VARCHAR(100),
      supplier_name VARCHAR(255),
      cost NUMERIC(12,2),
      invoice_value NUMERIC(12,2),
      payment_method VARCHAR(50),
      sales_person VARCHAR(100),
      out_status VARCHAR(100),
      remarks TEXT,
      cashier VARCHAR(100),
      google_review VARCHAR(50),
      created_by INTEGER REFERENCES users(id),
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );
  `);

  // Seed admin user if not exists (password: admin123)
  const bcrypt = require('bcryptjs');
  const existing = await pool.query("SELECT id FROM users WHERE username = 'admin'");
  if (existing.rows.length === 0) {
    const hash = await bcrypt.hash('admin123', 10);
    await pool.query(
      "INSERT INTO users (username, password, role, branch) VALUES ($1, $2, 'admin', NULL)",
      ['admin', hash]
    );
    // Seed branch managers
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

  console.log('✅ Database initialized');
};

module.exports = { pool, initDB };
