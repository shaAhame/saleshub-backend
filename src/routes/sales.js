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
        SELECT s.*, si.item_description, si.serial_imei,
               si.invoice_value as item_invoice_value,
               si.cost as item_cost,
               si.supplier_name as item_supplier,
               si.qty as item_qty
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
        s.total_invoice_value = s.items.reduce((sum, item) =>
          sum + (parseFloat(item.invoice_value || 0) * parseInt(item.qty || 1)), 0);
      });
    }

    res.json(sales);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// EXPORT Excel — before /:id
router.get('/export/excel', auth, async (req, res) => {
  const { date, branch, from, to } = req.query;
  const userBranch = branchGuard(req);
  const effectiveBranch = userBranch || branch || null;

  let query = `
    SELECT s.branch, s.sale_date, s.inv_no, s.acc_inv_no, s.customer_name, s.contact,
           si.item_description, si.serial_imei, si.qty,
           si.invoice_value as unit_price,
           (si.invoice_value * COALESCE(si.qty, 1)) as total_value,
           si.cost, si.supplier_name,
           s.payment_method, s.sales_person, s.out_status, s.cashier,
           s.google_review, s.remarks
    FROM sales s
    LEFT JOIN sale_items si ON si.sale_id = s.id
    WHERE 1=1
  `;
  const params = [];
  if (effectiveBranch) { params.push(effectiveBranch); query += ` AND s.branch = $${params.length}`; }
  if (date) { params.push(date); query += ` AND s.sale_date = $${params.length}`; }
  if (from) { params.push(from); query += ` AND s.sale_date >= $${params.length}`; }
  if (to) { params.push(to); query += ` AND s.sale_date <= $${params.length}`; }
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
    { header: 'Qty', key: 'qty', width: 6 },
    { header: 'Unit Price', key: 'unit_price', width: 14 },
    { header: 'Total Value', key: 'total_value', width: 14 },
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
  res.setHeader('Content-Disposition', `attachment; filename=sales_${from || date || 'all'}_${to || ''}.xlsx`);
  await workbook.xlsx.write(res);
  res.end();
});

// EXPORT PDF — before /:id
router.get('/export/pdf', auth, async (req, res) => {
  const { date, branch, from, to } = req.query;
  const userBranch = branchGuard(req);
  const effectiveBranch = userBranch || branch || null;

  let query = `
    SELECT s.branch, s.sale_date, s.customer_name, s.inv_no,
           si.item_description, si.serial_imei, si.qty,
           si.invoice_value,
           (si.invoice_value * COALESCE(si.qty, 1)) as total_value,
           s.payment_method, s.sales_person, s.out_status
    FROM sales s
    LEFT JOIN sale_items si ON si.sale_id = s.id
    WHERE 1=1
  `;
  const params = [];
  if (effectiveBranch) { params.push(effectiveBranch); query += ` AND s.branch = $${params.length}`; }
  if (date) { params.push(date); query += ` AND s.sale_date = $${params.length}`; }
  if (from) { params.push(from); query += ` AND s.sale_date >= $${params.length}`; }
  if (to) { params.push(to); query += ` AND s.sale_date <= $${params.length}`; }
  query += ' ORDER BY s.branch, s.sale_date, s.id, si.id';

  const { rows } = await pool.query(query, params);
  const doc = new PDFDocument({ margin: 30, size: 'A4', layout: 'landscape' });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename=sales_${from || date || 'all'}_${to || ''}.pdf`);
  doc.pipe(res);

  const title = `Sales Report — ${effectiveBranch || 'All Branches'} — ${from ? `${from} to ${to}` : date || 'All Dates'}`;
  doc.fontSize(14).font('Helvetica-Bold').text(title, { align: 'center' });
  doc.moveDown(0.5);

  const cols = ['Branch', 'Date', 'Customer', 'Item', 'IMEI', 'Qty', 'Unit Price', 'Total', 'Payment', 'Out'];
  const widths = [45, 55, 80, 100, 80, 25, 55, 60, 65, 35];
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
      r.qty || 1,
      r.invoice_value ? `Rs.${Number(r.invoice_value).toLocaleString()}` : '',
      r.total_value ? `Rs.${Number(r.total_value).toLocaleString()}` : '',
      r.payment_method, r.out_status
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

// SUPPLIER REPORT — before /:id
router.get('/supplier-report', auth, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const { from, to, branch } = req.query;

  try {
    let query = `
      SELECT s.branch, s.sale_date, s.customer_name, s.contact, s.inv_no,
             s.payment_method, s.sales_person,
             si.item_description, si.serial_imei,
             si.supplier_name, si.cost, si.invoice_value, si.qty
      FROM sales s
      JOIN sale_items si ON si.sale_id = s.id
      WHERE si.supplier_name IS NOT NULL AND si.supplier_name != ''
    `;
    const params = [];
    if (from) { params.push(from); query += ` AND s.sale_date >= $${params.length}`; }
    if (to) { params.push(to); query += ` AND s.sale_date <= $${params.length}`; }
    if (branch) { params.push(branch); query += ` AND s.branch = $${params.length}`; }
    query += ' ORDER BY si.supplier_name, s.sale_date, s.id';

    const { rows } = await pool.query(query, params);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// SUPPLIER REPORT EXPORT EXCEL — before /:id
router.get('/supplier-report/export/excel', auth, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const { from, to, branch, supplier } = req.query;

  let query = `
    SELECT si.supplier_name, s.sale_date, s.branch, s.customer_name,
           si.item_description, si.serial_imei, si.qty,
           si.cost, si.invoice_value as unit_price,
           (COALESCE(si.invoice_value, 0) * COALESCE(si.qty, 1)) as total_value,
           (COALESCE(si.invoice_value, 0) * COALESCE(si.qty, 1)) - (COALESCE(si.cost, 0) * COALESCE(si.qty, 1)) as profit
    FROM sales s
    JOIN sale_items si ON si.sale_id = s.id
    WHERE si.supplier_name IS NOT NULL AND si.supplier_name != ''
  `;
  const params = [];
  if (from) { params.push(from); query += ` AND s.sale_date >= $${params.length}`; }
  if (to) { params.push(to); query += ` AND s.sale_date <= $${params.length}`; }
  if (branch) { params.push(branch); query += ` AND s.branch = $${params.length}`; }
  if (supplier) { params.push(`%${supplier}%`); query += ` AND si.supplier_name ILIKE $${params.length}`; }
  query += ' ORDER BY si.supplier_name, s.sale_date';

  const { rows } = await pool.query(query, params);
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Supplier Report');

  sheet.columns = [
    { header: 'Supplier', key: 'supplier_name', width: 20 },
    { header: 'Date', key: 'sale_date', width: 12 },
    { header: 'Branch', key: 'branch', width: 10 },
    { header: 'Customer', key: 'customer_name', width: 20 },
    { header: 'Item Description', key: 'item_description', width: 30 },
    { header: 'Serial/IMEI', key: 'serial_imei', width: 20 },
    { header: 'Qty', key: 'qty', width: 6 },
    { header: 'Cost', key: 'cost', width: 14 },
    { header: 'Unit Price', key: 'unit_price', width: 14 },
    { header: 'Total Value', key: 'total_value', width: 14 },
    { header: 'Profit', key: 'profit', width: 14 },
  ];

  sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF4F46E5' } };
  rows.forEach(r => sheet.addRow(r));

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename=supplier_report_${from || 'all'}_${to || ''}.xlsx`);
  await workbook.xlsx.write(res);
  res.end();
});

// SUPPLIER REPORT EXPORT PDF — before /:id
router.get('/supplier-report/export/pdf', auth, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const { from, to, branch, supplier } = req.query;

  let query = `
    SELECT si.supplier_name, s.sale_date, s.branch, s.customer_name,
           si.item_description, si.serial_imei, si.qty,
           si.cost, si.invoice_value,
           (COALESCE(si.invoice_value, 0) * COALESCE(si.qty, 1)) as total_value,
           (COALESCE(si.invoice_value, 0) * COALESCE(si.qty, 1)) - (COALESCE(si.cost, 0) * COALESCE(si.qty, 1)) as profit
    FROM sales s
    JOIN sale_items si ON si.sale_id = s.id
    WHERE si.supplier_name IS NOT NULL AND si.supplier_name != ''
  `;
  const params = [];
  if (from) { params.push(from); query += ` AND s.sale_date >= $${params.length}`; }
  if (to) { params.push(to); query += ` AND s.sale_date <= $${params.length}`; }
  if (branch) { params.push(branch); query += ` AND s.branch = $${params.length}`; }
  if (supplier) { params.push(`%${supplier}%`); query += ` AND si.supplier_name ILIKE $${params.length}`; }
  query += ' ORDER BY si.supplier_name, s.sale_date';

  const { rows } = await pool.query(query, params);

  const doc = new PDFDocument({ margin: 40, size: 'A4', layout: 'landscape', autoFirstPage: true });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename=supplier_report_${from || 'all'}_${to || ''}.pdf`);
  doc.pipe(res);

  doc.fontSize(14).font('Helvetica-Bold')
    .text(`Supplier Report — ${branch || 'All Branches'} — ${from || ''} to ${to || ''}`, { align: 'center' });
  doc.fontSize(9).font('Helvetica').fillColor('#6B7280')
    .text(`Generated: ${new Date().toLocaleDateString()}`, { align: 'center' });
  doc.moveDown(1);

  if (rows.length === 0) {
    doc.fontSize(12).fillColor('#111827').text('No data found for the selected filters.', { align: 'center' });
    doc.end();
    return;
  }

  const groups = rows.reduce((acc, row) => {
    const key = row.supplier_name;
    if (!acc[key]) acc[key] = [];
    acc[key].push(row);
    return acc;
  }, {});

  const cols = ['No', 'Date', 'Branch', 'Customer', 'Item', 'IMEI', 'Qty', 'Cost', 'Unit Price', 'Total', 'Profit'];
  const widths = [22, 55, 45, 75, 100, 75, 22, 50, 55, 55, 50];
  const tableWidth = widths.reduce((a, b) => a + b, 0);
  const startX = 40;
  const pageBottom = doc.page.height - 60;

  const drawHeaders = (yPos) => {
    let x = startX;
    doc.fontSize(6).font('Helvetica-Bold');
    cols.forEach((col, i) => {
      doc.rect(x, yPos, widths[i], 18).fillAndStroke('#4F46E5', '#4F46E5');
      doc.fillColor('white').text(col, x + 2, yPos + 5, { width: widths[i] - 4, align: 'left' });
      x += widths[i];
    });
    doc.fillColor('black');
    return yPos + 18;
  };

  let currentY = doc.y;

  Object.entries(groups).forEach(([supplierName, items]) => {
    if (currentY + 60 > pageBottom) {
      doc.addPage();
      currentY = 40;
    }

    doc.rect(startX, currentY, tableWidth, 20).fillAndStroke('#1E1B4B', '#1E1B4B');
    doc.fontSize(9).font('Helvetica-Bold').fillColor('white')
      .text(`${supplierName}  (${items.length} items)`, startX + 6, currentY + 5, { width: tableWidth - 12 });
    currentY += 20;
    currentY = drawHeaders(currentY);

    items.forEach((r, idx) => {
      if (currentY + 18 > pageBottom) {
        doc.addPage();
        currentY = 40;
        doc.rect(startX, currentY, tableWidth, 16).fillAndStroke('#1E1B4B', '#1E1B4B');
        doc.fontSize(8).font('Helvetica-Bold').fillColor('white')
          .text(`${supplierName} (continued)`, startX + 4, currentY + 4);
        currentY += 16;
        currentY = drawHeaders(currentY);
      }

      let x = startX;
      const bg = idx % 2 === 0 ? '#FFFFFF' : '#F8F7FF';
      const values = [
        idx + 1,
        r.sale_date ? new Date(r.sale_date).toLocaleDateString() : '',
        r.branch, r.customer_name, r.item_description, r.serial_imei,
        r.qty || 1,
        r.cost ? `Rs.${Number(r.cost).toLocaleString()}` : '-',
        r.invoice_value ? `Rs.${Number(r.invoice_value).toLocaleString()}` : '-',
        r.total_value ? `Rs.${Number(r.total_value).toLocaleString()}` : '-',
        r.profit ? `Rs.${Number(r.profit).toLocaleString()}` : '-',
      ];

      doc.fontSize(6).font('Helvetica');
      values.forEach((val, i) => {
        doc.rect(x, currentY, widths[i], 16).fillAndStroke(bg, '#DDDDDD');
        doc.fillColor('black').text(String(val || ''), x + 2, currentY + 4, { width: widths[i] - 4 });
        x += widths[i];
      });
      currentY += 16;
    });

    // Supplier total row
    const totalCost = items.reduce((s, r) => s + (parseFloat(r.cost || 0) * parseInt(r.qty || 1)), 0);
    const totalValue = items.reduce((s, r) => s + parseFloat(r.total_value || 0), 0);
    const totalProfit = items.reduce((s, r) => s + parseFloat(r.profit || 0), 0);

    if (currentY + 18 > pageBottom) { doc.addPage(); currentY = 40; }

    let x = startX;
    const totalValues = ['', '', '', '', '', 'TOTAL', '', `Rs.${totalCost.toLocaleString()}`, '', `Rs.${totalValue.toLocaleString()}`, `Rs.${totalProfit.toLocaleString()}`];
    doc.fontSize(7).font('Helvetica-Bold');
    totalValues.forEach((val, i) => {
      doc.rect(x, currentY, widths[i], 16).fillAndStroke('#EEF2FF', '#EEF2FF');
      doc.fillColor(
        i === 7 ? '#991B1B' :
        i === 9 ? '#065F46' :
        i === 10 ? (totalProfit >= 0 ? '#065F46' : '#991B1B') :
        '#4F46E5'
      ).text(String(val), x + 2, currentY + 4, { width: widths[i] - 4 });
      x += widths[i];
    });
    currentY += 16;
    currentY += 14;
  });

  // Grand Total
  if (currentY + 30 > pageBottom) { doc.addPage(); currentY = 40; }
  const grandCost = rows.reduce((s, r) => s + (parseFloat(r.cost || 0) * parseInt(r.qty || 1)), 0);
  const grandValue = rows.reduce((s, r) => s + parseFloat(r.total_value || 0), 0);
  const grandProfit = rows.reduce((s, r) => s + parseFloat(r.profit || 0), 0);

  doc.rect(startX, currentY, tableWidth, 22).fillAndStroke('#1E1B4B', '#1E1B4B');
  doc.fontSize(8).font('Helvetica-Bold').fillColor('white')
    .text(
      `GRAND TOTAL  |  Cost: Rs.${grandCost.toLocaleString()}  |  Total Value: Rs.${grandValue.toLocaleString()}  |  Profit: Rs.${grandProfit.toLocaleString()}`,
      startX + 6, currentY + 7, { width: tableWidth - 12 }
    );

  doc.end();
});

// GET single sale — MUST BE AFTER ALL NAMED ROUTES
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

    const totalInvoiceValue = items.reduce((sum, item) =>
      sum + (parseFloat(item.invoice_value || 0) * parseInt(item.qty || 1)), 0);
    const totalCost = items.reduce((sum, item) =>
      sum + (parseFloat(item.cost || 0) * parseInt(item.qty || 1)), 0);

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
          'INSERT INTO sale_items (sale_id, item_description, serial_imei, invoice_value, cost, supplier_name, qty) VALUES ($1,$2,$3,$4,$5,$6,$7)',
          [sale.id, item.item_description || null, item.serial_imei || null,
           item.invoice_value || null, item.cost || null,
           item.supplier_name || null, parseInt(item.qty || 1)]
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
  const totalInvoiceValue = items.reduce((sum, item) =>
    sum + (parseFloat(item.invoice_value || 0) * parseInt(item.qty || 1)), 0);
  const totalCost = items.reduce((sum, item) =>
    sum + (parseFloat(item.cost || 0) * parseInt(item.qty || 1)), 0);

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
          'INSERT INTO sale_items (sale_id, item_description, serial_imei, invoice_value, cost, supplier_name, qty) VALUES ($1,$2,$3,$4,$5,$6,$7)',
          [req.params.id, item.item_description || null, item.serial_imei || null,
           item.invoice_value || null, item.cost || null,
           item.supplier_name || null, parseInt(item.qty || 1)]
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

module.exports = router;
