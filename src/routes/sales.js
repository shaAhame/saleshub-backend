const router = require('express').Router();
const { pool } = require('../db');
const { auth } = require('../middleware/auth');
const ExcelJS = require('exceljs');
const PDFDocument = require('pdfkit');

const branchGuard = (req) => {
  if (req.user.role === 'admin') return null;
  return req.user.branch;
};

// GET sales with items
router.get('/', auth, async (req, res) => {
  const { date, branch, imei } = req.query;
  const userBranch = branchGuard(req);
  const effectiveBranch = userBranch || branch || null;

  try {
    if (imei) {
      let query = `
        SELECT s.*, si.item_description, si.serial_imei, si.invoice_value as item_invoice_value
        FROM sales s
        JOIN sale_items si ON si.sale_id = s.id
        WHERE si.serial_imei ILIKE $1
      `;
      const params = [`%${imei}%`];
      if (effectiveBranch) { params.push(effectiveBranch); query += ` AND s.branch = $${params.length}`; }
      query += ' ORDER BY s.sale_date DESC';
      const result = await pool.query(query, params);
      return res.json(result.rows);
    }

    let query = 'SELECT * FROM sales WHERE 1=1';
    const params = [];
    if (effectiveBranch) { params.push(effectiveBranch); query += ` AND branch = $${params.length}`; }
    if (date) { params.push(date); query += ` AND sale_date = $${params.length}`; }
    query += ' ORDER BY sale_date DESC, id ASC';

    const salesResult = await pool.query(query, params);
    const sales = salesResult.rows;

    if (sales.length > 0) {
      const saleIds = sales.map(s => s.id);
      const itemsResult = await pool.query(
        'SELECT * FROM sale_items WHERE sale_id = ANY($1) ORDER BY id ASC',
        [saleIds]
      );
      const itemsBySaleId = {};
      itemsResult.rows.forEach(item => {
        if (!itemsBySaleId[item.sale_id]) itemsBySaleId[item.sale_id] = [];
        itemsBySaleId[item.sale_id].push(item);
      });
      sales.forEach(s => {
        s.items = itemsBySaleId[s.id] || [];
        // Calculate total invoice value from items
        s.total_invoice_value = s.items.reduce((sum, item) => sum + parseFloat(item.invoice_value || 0), 0);
      });
    }

    res.json(sales);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET single sale
router.get('/:id', auth, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM sales WHERE id = $1', [req.params.id]);
    const sale = result.rows[0];
    if (!sale) return res.status(404).json({ error: 'Not found' });
    const userBranch = branchGuard(req);
    if (userBranch && sale.branch !== userBranch) return res.status(403).json({ error: 'Forbidden' });
    const items = await pool.query('SELECT * FROM sale_items WHERE sale_id = $1 ORDER BY id', [sale.id]);
    sale.items = items.rows;
    res.json(sale);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// CREATE sale
router.post('/', auth, async (req, res) => {
  const userBranch = branchGuard(req);
  const branch = userBranch || req.body.branch;
  if (!branch) return res.status(400).json({ error: 'Branch required' });

  const {
    sale_date, inv_no, acc_inv_no, customer_name, contact,
    payment_method, sales_person, out_status, cashier,
    google_review, remarks, items = []
  } = req.body;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const effectiveOutStatus = req.user.role === 'admin' ? (out_status || 'NO') : 'NO';

    // Calculate total invoice value and cost from items
    const totalInvoiceValue = items.reduce((sum, item) => sum + parseFloat(item.invoice_value || 0), 0);
    const totalCost = items.reduce((sum, item) => sum + parseFloat(item.cost || 0), 0);

    const saleResult = await client.query(`
      INSERT INTO sales (branch, sale_date, inv_no, acc_inv_no, customer_name, contact,
        payment_method, sales_person, out_status, cashier, invoice_value,
        cost, google_review, remarks, created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
      RETURNING *`,
      [branch, sale_date || new Date(), inv_no, acc_inv_no, customer_name, contact,
       payment_method, sales_person, effectiveOutStatus, cashier,
       totalInvoiceValue || null, totalCost || null,
       google_review, remarks, req.user.id]
    );

    const sale = saleResult.rows[0];

    for (const item of items) {
      if (item.item_description || item.serial_imei) {
        await client.query(
          'INSERT INTO sale_items (sale_id, item_description, serial_imei, invoice_value, cost, supplier_name) VALUES ($1,$2,$3,$4,$5,$6)',
          [sale.id, item.item_description || null, item.serial_imei || null,
           item.invoice_value || null, item.cost || null, item.supplier_name || null]
        );
      }
    }

    await client.query('COMMIT');
    const itemsResult = await pool.query('SELECT * FROM sale_items WHERE sale_id = $1 ORDER BY id', [sale.id]);
    sale.items = itemsResult.rows;
    res.json(sale);
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(400).json({ error: err.message });
  } finally {
    client.release();
  }
});

// UPDATE sale
router.put('/:id', auth, async (req, res) => {
  const existing = await pool.query('SELECT * FROM sales WHERE id = $1', [req.params.id]);
  if (!existing.rows[0]) return res.status(404).json({ error: 'Not found' });
  const userBranch = branchGuard(req);
  if (userBranch && existing.rows[0].branch !== userBranch) return res.status(403).json({ error: 'Forbidden' });

  const {
    sale_date, inv_no, acc_inv_no, customer_name, contact,
    payment_method, sales_person, out_status, cashier,
    google_review, remarks, items = []
  } = req.body;

  const effectiveOutStatus = req.user.role === 'admin' ? out_status : existing.rows[0].out_status;
  const totalInvoiceValue = items.reduce((sum, item) => sum + parseFloat(item.invoice_value || 0), 0);
  const totalCost = items.reduce((sum, item) => sum + parseFloat(item.cost || 0), 0);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(`
      UPDATE sales SET sale_date=$1, inv_no=$2, acc_inv_no=$3, customer_name=$4, contact=$5,
        payment_method=$6, sales_person=$7, out_status=$8, cashier=$9,
        invoice_value=$10, cost=$11, google_review=$12, remarks=$13, updated_at=NOW()
      WHERE id=$14 RETURNING *`,
      [sale_date, inv_no, acc_inv_no, customer_name, contact,
       payment_method, sales_person, effectiveOutStatus, cashier,
       totalInvoiceValue || null, totalCost || null,
       google_review, remarks, req.params.id]
    );

    await client.query('DELETE FROM sale_items WHERE sale_id = $1', [req.params.id]);
    for (const item of items) {
      if (item.item_description || item.serial_imei) {
        await client.query(
          'INSERT INTO sale_items (sale_id, item_description, serial_imei, invoice_value, cost, supplier_name) VALUES ($1,$2,$3,$4,$5,$6)',
          [req.params.id, item.item_description || null, item.serial_imei || null,
           item.invoice_value || null, item.cost || null, item.supplier_name || null]
        );
      }
    }

    await client.query('COMMIT');
    const sale = result.rows[0];
    const itemsResult = await pool.query('SELECT * FROM sale_items WHERE sale_id = $1 ORDER BY id', [sale.id]);
    sale.items = itemsResult.rows;
    res.json(sale);
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(400).json({ error: err.message });
  } finally {
    client.release();
  }
});

// DELETE sale
router.delete('/:id', auth, async (req, res) => {
  const existing = await pool.query('SELECT * FROM sales WHERE id = $1', [req.params.id]);
  if (!existing.rows[0]) return res.status(404).json({ error: 'Not found' });
  const userBranch = branchGuard(req);
  if (userBranch && existing.rows[0].branch !== userBranch) return res.status(403).json({ error: 'Forbidden' });
  await pool.query('DELETE FROM sales WHERE id = $1', [req.params.id]);
  res.json({ success: true });
});

// EXPORT Excel
router.get('/export/excel', auth, async (req, res) => {
  const { date, branch } = req.query;
  const userBranch = branchGuard(req);
  const effectiveBranch = userBranch || branch || null;

  let query = `
    SELECT s.branch, s.sale_date, s.inv_no, s.acc_inv_no, s.customer_name, s.contact,
           si.item_description, si.serial_imei, si.invoice_value, si.cost, si.supplier_name,
           s.payment_method, s.sales_person, s.out_status, s.cashier,
           s.google_review, s.remarks
    FROM sales s
    LEFT JOIN sale_items si ON si.sale_id = s.id
    WHERE 1=1
  `;
  const params = [];
  if (effectiveBranch) { params.push(effectiveBranch); query += ` AND s.branch = $${params.length}`; }
  if (date) { params.push(date); query += ` AND s.sale_date = $${params.length}`; }
  query += ' ORDER BY s.branch, s.sale_date, s.id, si.id';

  const { rows } = await pool.query(query, params);
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Sales Report');

  sheet.columns = [
    { header: 'Branch', key: 'branch', width: 10 },
    { header: 'Date', key: 'sale_date', width: 12 },
    { header: 'INV No.', key: 'inv_no', width: 12 },
    { header: 'ACC INV No.', key: 'acc_inv_no', width: 14 },
    { header: 'Customer Name', key: 'customer_name', width: 20 },
    { header: 'Contact', key: 'contact', width: 14 },
    { header: 'Item Description', key: 'item_description', width: 28 },
    { header: 'Serial/IMEI', key: 'serial_imei', width: 20 },
    { header: 'Invoice Value', key: 'invoice_value', width: 14 },
    { header: 'Cost', key: 'cost', width: 12 },
    { header: 'Supplier', key: 'supplier_name', width: 18 },
    { header: 'Payment Method', key: 'payment_method', width: 16 },
    { header: 'Sales Person', key: 'sales_person', width: 15 },
    { header: 'Out Status', key: 'out_status', width: 10 },
    { header: 'Cashier', key: 'cashier', width: 14 },
    { header: 'Google Review', key: 'google_review', width: 14 },
    { header: 'Remarks', key: 'remarks', width: 20 },
  ];

  sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF4F46E5' } };
  rows.forEach(r => sheet.addRow(r));

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename=sales_${date || 'all'}.xlsx`);
  await workbook.xlsx.write(res);
  res.end();
});

// EXPORT PDF
router.get('/export/pdf', auth, async (req, res) => {
  const { date, branch } = req.query;
  const userBranch = branchGuard(req);
  const effectiveBranch = userBranch || branch || null;

  let query = `
    SELECT s.branch, s.sale_date, s.customer_name, s.inv_no,
           si.item_description, si.serial_imei, si.invoice_value,
           s.payment_method, s.sales_person, s.out_status
    FROM sales s
    LEFT JOIN sale_items si ON si.sale_id = s.id
    WHERE 1=1
  `;
  const params = [];
  if (effectiveBranch) { params.push(effectiveBranch); query += ` AND s.branch = $${params.length}`; }
  if (date) { params.push(date); query += ` AND s.sale_date = $${params.length}`; }
  query += ' ORDER BY s.branch, s.sale_date, s.id, si.id';

  const { rows } = await pool.query(query, params);
  const doc = new PDFDocument({ margin: 30, size: 'A4', layout: 'landscape' });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename=sales_${date || 'all'}.pdf`);
  doc.pipe(res);

  doc.fontSize(16).font('Helvetica-Bold').text(
    `Sales Report — ${effectiveBranch || 'All Branches'} — ${date || 'All Dates'}`,
    { align: 'center' }
  );
  doc.moveDown(0.5);

  const cols = ['Branch', 'Date', 'Customer', 'Item', 'Serial/IMEI', 'Inv.Value', 'Payment', 'Salesperson', 'Out'];
  const widths = [50, 60, 90, 110, 90, 60, 70, 70, 40];
  let x = 30;
  const y = doc.y;

  doc.fontSize(7).font('Helvetica-Bold');
  cols.forEach((col, i) => {
    doc.rect(x, y, widths[i], 18).fillAndStroke('#4F46E5', '#4F46E5');
    doc.fillColor('white').text(col, x + 2, y + 4, { width: widths[i] - 4 });
    x += widths[i];
  });
  doc.fillColor('black');

  let rowY = y + 18;
  rows.forEach((r, idx) => {
    x = 30;
    const bg = idx % 2 === 0 ? '#F8F7FF' : '#FFFFFF';
    const values = [
      r.branch,
      r.sale_date ? new Date(r.sale_date).toLocaleDateString() : '',
      r.customer_name, r.item_description, r.serial_imei,
      r.invoice_value, r.payment_method, r.sales_person, r.out_status
    ];
    doc.fontSize(6).font('Helvetica');
    values.forEach((val, i) => {
      doc.rect(x, rowY, widths[i], 16).fillAndStroke(bg, '#DDDDDD');
      doc.fillColor('black').text(String(val || ''), x + 2, rowY + 4, { width: widths[i] - 4 });
      x += widths[i];
    });
    rowY += 16;
    if (rowY > 540) { doc.addPage({ layout: 'landscape' }); rowY = 30; }
  });

  doc.end();
});

module.exports = router;
