const router = require('express').Router();
const { pool } = require('../db');
const { auth } = require('../middleware/auth');
const ExcelJS = require('exceljs');
const PDFDocument = require('pdfkit');

const branchGuard = (req) => {
  if (req.user.role === 'admin') return null;
  return req.user.branch;
};

// GET sales
router.get('/', auth, async (req, res) => {
  const { date, branch, imei } = req.query;
  const userBranch = branchGuard(req);
  const effectiveBranch = userBranch || branch || null;

  let query = 'SELECT * FROM sales WHERE 1=1';
  const params = [];
  if (effectiveBranch) { params.push(effectiveBranch); query += ` AND branch = $${params.length}`; }
  if (date) { params.push(date); query += ` AND sale_date = $${params.length}`; }
  if (imei) { params.push(`%${imei}%`); query += ` AND serial_imei ILIKE $${params.length}`; }
  query += ' ORDER BY sale_date DESC, id ASC';

  const result = await pool.query(query, params);
  res.json(result.rows);
});

// GET single sale
router.get('/:id', auth, async (req, res) => {
  const result = await pool.query('SELECT * FROM sales WHERE id = $1', [req.params.id]);
  const sale = result.rows[0];
  if (!sale) return res.status(404).json({ error: 'Not found' });
  const userBranch = branchGuard(req);
  if (userBranch && sale.branch !== userBranch) return res.status(403).json({ error: 'Forbidden' });
  res.json(sale);
});

// CREATE sale
router.post('/', auth, async (req, res) => {
  const userBranch = branchGuard(req);
  const branch = userBranch || req.body.branch;
  if (!branch) return res.status(400).json({ error: 'Branch required' });

  const {
    sale_date, customer_name, acc_inv_no, contact, inv_no,
    item_description, serial_imei, supplier_name, cost, invoice_value,
    payment_method, sales_person, out_status, remarks, cashier, google_review
  } = req.body;

  try {
    const effectiveOutStatus = req.user.role === 'admin' ? (out_status || 'NO') : 'NO';
    const result = await pool.query(`
      INSERT INTO sales (branch, sale_date, customer_name, acc_inv_no, contact, inv_no,
        item_description, serial_imei, supplier_name, cost, invoice_value,
        payment_method, sales_person, out_status, remarks, cashier, google_review, created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
      RETURNING *`,
      [branch, sale_date || new Date(), customer_name, acc_inv_no, contact, inv_no,
       item_description, serial_imei, supplier_name, cost || null, invoice_value || null,
       payment_method, sales_person, effectiveOutStatus, remarks, cashier, google_review, req.user.id]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// UPDATE sale
router.put('/:id', auth, async (req, res) => {
  const existing = await pool.query('SELECT * FROM sales WHERE id = $1', [req.params.id]);
  if (!existing.rows[0]) return res.status(404).json({ error: 'Not found' });
  const userBranch = branchGuard(req);
  if (userBranch && existing.rows[0].branch !== userBranch) return res.status(403).json({ error: 'Forbidden' });

  const {
    sale_date, customer_name, acc_inv_no, contact, inv_no,
    item_description, serial_imei, supplier_name, cost, invoice_value,
    payment_method, sales_person, out_status, remarks, cashier, google_review
  } = req.body;

  const effectiveOutStatus = req.user.role === 'admin' ? out_status : existing.rows[0].out_status;

  const result = await pool.query(`
    UPDATE sales SET sale_date=$1, customer_name=$2, acc_inv_no=$3, contact=$4,
      inv_no=$5, item_description=$6, serial_imei=$7, supplier_name=$8, cost=$9,
      invoice_value=$10, payment_method=$11, sales_person=$12, out_status=$13,
      remarks=$14, cashier=$15, google_review=$16, updated_at=NOW()
    WHERE id=$17 RETURNING *`,
    [sale_date, customer_name, acc_inv_no, contact, inv_no,
     item_description, serial_imei, supplier_name, cost || null, invoice_value || null,
     payment_method, sales_person, effectiveOutStatus, remarks, cashier, google_review, req.params.id]
  );
  res.json(result.rows[0]);
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

  let query = 'SELECT * FROM sales WHERE 1=1';
  const params = [];
  if (effectiveBranch) { params.push(effectiveBranch); query += ` AND branch = $${params.length}`; }
  if (date) { params.push(date); query += ` AND sale_date = $${params.length}`; }
  query += ' ORDER BY branch, sale_date, id';

  const { rows } = await pool.query(query, params);
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Sales Report');

  sheet.columns = [
    { header: 'No', key: 'id', width: 5 },
    { header: 'Branch', key: 'branch', width: 10 },
    { header: 'Date', key: 'sale_date', width: 12 },
    { header: 'Customer Name', key: 'customer_name', width: 20 },
    { header: 'ACC INV No.', key: 'acc_inv_no', width: 14 },
    { header: 'Contact', key: 'contact', width: 14 },
    { header: 'INV No.', key: 'inv_no', width: 12 },
    { header: 'Item Description', key: 'item_description', width: 25 },
    { header: 'Serial/IMEI', key: 'serial_imei', width: 20 },
    { header: 'Supplier', key: 'supplier_name', width: 18 },
    { header: 'Cost', key: 'cost', width: 12 },
    { header: 'Invoice Value', key: 'invoice_value', width: 14 },
    { header: 'Payment Method', key: 'payment_method', width: 16 },
    { header: 'Sales Person', key: 'sales_person', width: 15 },
    { header: 'Out Status', key: 'out_status', width: 14 },
    { header: 'Remarks', key: 'remarks', width: 20 },
    { header: 'Cashier', key: 'cashier', width: 14 },
    { header: 'Google Review', key: 'google_review', width: 14 },
  ];

  sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF4F46E5' } };
  rows.forEach(r => sheet.addRow(r));

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename=sales_${date || 'all'}_${effectiveBranch || 'all'}.xlsx`);
  await workbook.xlsx.write(res);
  res.end();
});

// EXPORT PDF
router.get('/export/pdf', auth, async (req, res) => {
  const { date, branch } = req.query;
  const userBranch = branchGuard(req);
  const effectiveBranch = userBranch || branch || null;

  let query = 'SELECT * FROM sales WHERE 1=1';
  const params = [];
  if (effectiveBranch) { params.push(effectiveBranch); query += ` AND branch = $${params.length}`; }
  if (date) { params.push(date); query += ` AND sale_date = $${params.length}`; }
  query += ' ORDER BY branch, sale_date, id';

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

  const cols = ['No', 'Branch', 'Date', 'Customer', 'INV No.', 'Item', 'Serial/IMEI', 'Cost', 'Inv.Value', 'Payment', 'Salesperson', 'Out'];
  const widths = [25, 50, 60, 90, 60, 100, 90, 55, 60, 70, 70, 50];
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
      idx + 1, r.branch,
      r.sale_date ? new Date(r.sale_date).toLocaleDateString() : '',
      r.customer_name, r.inv_no, r.item_description,
      r.serial_imei, r.cost, r.invoice_value,
      r.payment_method, r.sales_person, r.out_status
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
