const router = require('express').Router();
const { pool } = require('../db');
const { auth } = require('../middleware/auth');
const archiver = require('archiver');

const buildQuery = (req) => {
  const { date, from, to, branch, supplier } = req.query;
  let query = `
    SELECT s.branch, s.sale_date, s.customer_name, s.inv_no,
           si.item_description, si.serial_imei,
           si.supplier_name, si.cost, si.invoice_value, si.qty
    FROM sales s
    JOIN sale_items si ON si.sale_id = s.id
    WHERE si.supplier_name IS NOT NULL AND si.supplier_name != ''
    AND si.cost IS NOT NULL
  `;
  const params = [];
  if (date) { params.push(date); query += ` AND s.sale_date = $${params.length}`; }
  if (from) { params.push(from); query += ` AND s.sale_date >= $${params.length}`; }
  if (to) { params.push(to); query += ` AND s.sale_date <= $${params.length}`; }
  if (branch) { params.push(branch); query += ` AND s.branch = $${params.length}`; }
  if (supplier) { params.push(supplier); query += ` AND si.supplier_name = $${params.length}`; }
  query += ' ORDER BY si.supplier_name, s.sale_date, s.id';
  return { query, params };
};

router.get('/', auth, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  try {
    const { query, params } = buildQuery(req);
    const { rows } = await pool.query(query, params);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const generateSupplierDoc = async (supplierName, items, dateLabel) => {
  const {
    Document, Packer, Paragraph, Table, TableRow, TableCell,
    TextRun, AlignmentType, WidthType, BorderStyle, ShadingType
  } = require('docx');

  const supplierTotal = items.reduce((s, r) => s + (parseFloat(r.cost || 0) * parseInt(r.qty || 1)), 0);
  const children = [];

  children.push(new Paragraph({
    children: [new TextRun({ text: 'PURCHASE INVOICE', bold: true, size: 36, color: '1E1B4B' })],
    alignment: AlignmentType.CENTER,
    spacing: { after: 80 }
  }));

  children.push(new Paragraph({
    children: [new TextRun({ text: 'SalesHub — Branch Sales Management System', size: 20, color: '6B7280' })],
    alignment: AlignmentType.CENTER,
    spacing: { after: 60 }
  }));

  children.push(new Paragraph({
    border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: '1E1B4B' } },
    spacing: { after: 200 }
  }));

  children.push(new Table({
    width: { size: 9000, type: WidthType.DXA },
    borders: {
      top: { style: BorderStyle.NONE }, bottom: { style: BorderStyle.NONE },
      left: { style: BorderStyle.NONE }, right: { style: BorderStyle.NONE },
      insideH: { style: BorderStyle.NONE }, insideV: { style: BorderStyle.NONE },
    },
    rows: [new TableRow({
      children: [
        new TableCell({
          width: { size: 3000, type: WidthType.DXA },
          borders: { top: { style: BorderStyle.NONE }, bottom: { style: BorderStyle.NONE }, left: { style: BorderStyle.NONE }, right: { style: BorderStyle.NONE } },
          children: [
            new Paragraph({ children: [new TextRun({ text: 'SUPPLIER', bold: true, size: 18, color: '6B7280' })] }),
            new Paragraph({ children: [new TextRun({ text: supplierName, bold: true, size: 26, color: '1E1B4B' })] }),
          ]
        }),
        new TableCell({
          width: { size: 3000, type: WidthType.DXA },
          borders: { top: { style: BorderStyle.NONE }, bottom: { style: BorderStyle.NONE }, left: { style: BorderStyle.NONE }, right: { style: BorderStyle.NONE } },
          children: [
            new Paragraph({ children: [new TextRun({ text: 'DATE', bold: true, size: 18, color: '6B7280' })] }),
            new Paragraph({ children: [new TextRun({ text: dateLabel, bold: true, size: 22, color: '1E1B4B' })] }),
          ]
        }),
        new TableCell({
          width: { size: 3000, type: WidthType.DXA },
          borders: { top: { style: BorderStyle.NONE }, bottom: { style: BorderStyle.NONE }, left: { style: BorderStyle.NONE }, right: { style: BorderStyle.NONE } },
          children: [
            new Paragraph({ children: [new TextRun({ text: 'GENERATED', bold: true, size: 18, color: '6B7280' })] }),
            new Paragraph({ children: [new TextRun({ text: new Date().toLocaleDateString(), bold: true, size: 22, color: '1E1B4B' })] }),
          ]
        }),
      ]
    })]
  }));

  children.push(new Paragraph({ text: '', spacing: { after: 300 } }));

  children.push(new Table({
    width: { size: 9000, type: WidthType.DXA },
    rows: [new TableRow({
      children: [new TableCell({
        width: { size: 9000, type: WidthType.DXA },
        shading: { type: ShadingType.CLEAR, color: '1E1B4B', fill: '1E1B4B' },
        margins: { top: 100, bottom: 100, left: 160, right: 160 },
        children: [new Paragraph({
          children: [
            new TextRun({ text: `SUPPLIER: ${supplierName.toUpperCase()}`, bold: true, size: 24, color: 'FFFFFF' }),
            new TextRun({ text: `     (${items.length} item${items.length !== 1 ? 's' : ''})`, size: 19, color: 'CCCCCC' }),
          ]
        })]
      })]
    })]
  }));

  const colWidths = [400, 1000, 700, 2800, 1600, 400, 1000, 1100];
  const headers = ['No', 'Date', 'Branch', 'Item Description', 'Serial / IMEI', 'Qty', 'Unit Cost', 'Total Cost'];

  const headerRow = new TableRow({
    tableHeader: true,
    children: headers.map((h, i) => new TableCell({
      width: { size: colWidths[i], type: WidthType.DXA },
      shading: { type: ShadingType.CLEAR, color: '4F46E5', fill: '4F46E5' },
      margins: { top: 80, bottom: 80, left: 80, right: 80 },
      children: [new Paragraph({
        children: [new TextRun({ text: h, bold: true, color: 'FFFFFF', size: 17 })],
        alignment: i === 0 || i === 5 ? AlignmentType.CENTER : AlignmentType.LEFT
      })]
    }))
  });

  const dataRows = items.map((item, idx) => {
    const totalCost = parseFloat(item.cost || 0) * parseInt(item.qty || 1);
    const values = [
      String(idx + 1),
      item.sale_date ? new Date(item.sale_date).toLocaleDateString() : '',
      item.branch || '',
      item.item_description || '',
      item.serial_imei || '',
      String(item.qty || 1),
      `Rs. ${Number(item.cost).toLocaleString()}`,
      `Rs. ${totalCost.toLocaleString()}`
    ];
    const bg = idx % 2 === 0 ? 'FFFFFF' : 'F0F0FF';
    return new TableRow({
      children: values.map((val, i) => new TableCell({
        width: { size: colWidths[i], type: WidthType.DXA },
        shading: { type: ShadingType.CLEAR, color: bg, fill: bg },
        margins: { top: 60, bottom: 60, left: 80, right: 80 },
        children: [new Paragraph({
          children: [new TextRun({ text: val, size: 17, color: i === 7 ? '991B1B' : '111827', bold: i === 7 })],
          alignment: i === 0 || i === 5 ? AlignmentType.CENTER : AlignmentType.LEFT
        })]
      }))
    });
  });

  const totalRow = new TableRow({
    children: [
      new TableCell({
        columnSpan: 7,
        width: { size: 7900, type: WidthType.DXA },
        shading: { type: ShadingType.CLEAR, color: 'FEF2F2', fill: 'FEF2F2' },
        margins: { top: 100, bottom: 100, left: 80, right: 80 },
        children: [new Paragraph({
          children: [new TextRun({ text: `TOTAL — ${supplierName}`, bold: true, size: 20, color: '991B1B' })],
          alignment: AlignmentType.RIGHT
        })]
      }),
      new TableCell({
        width: { size: 1100, type: WidthType.DXA },
        shading: { type: ShadingType.CLEAR, color: 'FEF2F2', fill: 'FEF2F2' },
        margins: { top: 100, bottom: 100, left: 80, right: 80 },
        children: [new Paragraph({
          children: [new TextRun({ text: `Rs. ${supplierTotal.toLocaleString()}`, bold: true, size: 20, color: '991B1B' })],
          alignment: AlignmentType.LEFT
        })]
      })
    ]
  });

  children.push(new Table({
    width: { size: 9000, type: WidthType.DXA },
    rows: [headerRow, ...dataRows, totalRow]
  }));

  children.push(new Paragraph({ text: '', spacing: { after: 300 } }));

  children.push(new Paragraph({
    border: { top: { style: BorderStyle.DOUBLE, size: 6, color: '1E1B4B' } },
    spacing: { before: 200, after: 100 }
  }));

  children.push(new Table({
    width: { size: 9000, type: WidthType.DXA },
    borders: {
      top: { style: BorderStyle.NONE }, bottom: { style: BorderStyle.NONE },
      left: { style: BorderStyle.NONE }, right: { style: BorderStyle.NONE },
      insideH: { style: BorderStyle.NONE }, insideV: { style: BorderStyle.NONE },
    },
    rows: [new TableRow({
      children: [
        new TableCell({
          width: { size: 4500, type: WidthType.DXA },
          borders: { top: { style: BorderStyle.NONE }, bottom: { style: BorderStyle.NONE }, left: { style: BorderStyle.NONE }, right: { style: BorderStyle.NONE } },
          shading: { type: ShadingType.CLEAR, color: 'EEF2FF', fill: 'EEF2FF' },
          margins: { top: 120, bottom: 120, left: 160, right: 160 },
          children: [
            new Paragraph({ children: [new TextRun({ text: `${items.length} Item${items.length !== 1 ? 's' : ''}`, size: 19, color: '4F46E5' })] }),
            new Paragraph({ children: [new TextRun({ text: 'TOTAL PURCHASE COST', bold: true, size: 24, color: '1E1B4B' })] }),
          ]
        }),
        new TableCell({
          width: { size: 4500, type: WidthType.DXA },
          borders: { top: { style: BorderStyle.NONE }, bottom: { style: BorderStyle.NONE }, left: { style: BorderStyle.NONE }, right: { style: BorderStyle.NONE } },
          shading: { type: ShadingType.CLEAR, color: 'EEF2FF', fill: 'EEF2FF' },
          margins: { top: 120, bottom: 120, left: 160, right: 160 },
          children: [
            new Paragraph({
              children: [new TextRun({ text: `Rs. ${supplierTotal.toLocaleString()}`, bold: true, size: 32, color: '991B1B' })],
              alignment: AlignmentType.RIGHT
            }),
          ]
        }),
      ]
    })]
  }));

  children.push(new Paragraph({ text: '', spacing: { after: 200 } }));
  children.push(new Paragraph({
    border: { top: { style: BorderStyle.SINGLE, size: 3, color: 'E5E7EB' } },
    children: [new TextRun({ text: `Generated by SalesHub  |  ${new Date().toLocaleString()}`, size: 16, color: '9CA3AF' })],
    alignment: AlignmentType.CENTER,
    spacing: { before: 200 }
  }));

  const doc = new Document({ sections: [{ properties: {}, children }] });
  return await Packer.toBuffer(doc);
};

router.get('/word', auth, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  try {
    const { query, params } = buildQuery(req);
    const { rows } = await pool.query(query, params);
    if (rows.length === 0) return res.status(404).json({ error: 'No data found' });

    const { date, from, to } = req.query;
    const dateLabel = date ? date : `${from}_to_${to}`;
    const dateLabelDisplay = date ? date : `${from} to ${to}`;

    const groups = rows.reduce((acc, row) => {
      const key = row.supplier_name;
      if (!acc[key]) acc[key] = [];
      acc[key].push(row);
      return acc;
    }, {});

    if (Object.keys(groups).length === 1) {
      const [supplierName, items] = Object.entries(groups)[0];
      const buffer = await generateSupplierDoc(supplierName, items, dateLabelDisplay);
      const safeName = supplierName.replace(/[^a-zA-Z0-9]/g, '_');
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
      res.setHeader('Content-Disposition', `attachment; filename="${safeName}_invoice_${dateLabel}.docx"`);
      return res.send(buffer);
    }

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="purchase_invoices_${dateLabel}.zip"`);

    const archive = archiver('zip', { zlib: { level: 9 } });
    archive.pipe(res);

    for (const [supplierName, items] of Object.entries(groups)) {
      const buffer = await generateSupplierDoc(supplierName, items, dateLabelDisplay);
      const safeName = supplierName.replace(/[^a-zA-Z0-9]/g, '_');
      archive.append(buffer, { name: `${safeName}_invoice_${dateLabel}.docx` });
    }

    await archive.finalize();
  } catch (err) {
    console.error('Word generation error:', err);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

router.get('/word/:supplier', auth, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  try {
    req.query.supplier = req.params.supplier;
    const { query, params } = buildQuery(req);
    const { rows } = await pool.query(query, params);
    if (rows.length === 0) return res.status(404).json({ error: 'No data found for this supplier' });

    const { date, from, to } = req.query;
    const dateLabel = date ? date : `${from}_to_${to}`;
    const dateLabelDisplay = date ? date : `${from} to ${to}`;
    const supplierName = req.params.supplier;

    const buffer = await generateSupplierDoc(supplierName, rows, dateLabelDisplay);
    const safeName = supplierName.replace(/[^a-zA-Z0-9]/g, '_');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}_invoice_${dateLabel}.docx"`);
    res.send(buffer);
  } catch (err) {
    console.error('Word generation error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
