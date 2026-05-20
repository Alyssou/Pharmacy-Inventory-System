const express = require('express');
const session = require('express-session');
const crypto  = require('crypto');
const path    = require('path');
const db      = require('./db');

function generateId(prefix) {
  return `${prefix}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
}

const MedicineRepository      = require('./repositories/MedicineRepository');
const BatchRepository         = require('./repositories/BatchRepository');
const SaleRepository          = require('./repositories/SaleRepository');
const StockMovementRepository = require('./repositories/StockMovementRepository');
const SaleService             = require('./services/SaleService');

const medicineRepo = new MedicineRepository(db);
const batchRepo    = new BatchRepository(db);
const saleRepo     = new SaleRepository(db);
const movementRepo = new StockMovementRepository(db);
const saleService  = new SaleService(db, batchRepo, saleRepo, movementRepo, medicineRepo);

const app = express();
app.use(express.json());
app.use(session({
  secret: 'pharmacy-cs2712-prototype',
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, maxAge: 8 * 60 * 60 * 1000 }
}));
app.use(express.static(path.join(__dirname, 'public')));

function requireAuth(req, res, next) {
  if (!req.session.user) {
    return res.status(401).json({ ok: false, error: 'Not authenticated' });
  }
  next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.session.user) {
      return res.status(401).json({ ok: false, error: 'Not authenticated' });
    }
    if (!roles.includes(req.session.user.role)) {
      return res.status(403).json({ ok: false, error: 'Insufficient role' });
    }
    next();
  };
}

// --- Auth (no session required) ---

app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ ok: false, error: 'Username and password required' });
  }

  const user = db.prepare(
    'SELECT * FROM users WHERE username = ? AND active = 1'
  ).get(username);

  if (!user) {
    return res.status(401).json({ ok: false, error: 'Invalid credentials' });
  }

  const valid = user.password_hash.startsWith('$2b$')
    ? require('bcryptjs').compareSync(password, user.password_hash)
    : password === user.password_hash;

  if (!valid) {
    return res.status(401).json({ ok: false, error: 'Invalid credentials' });
  }

  req.session.user = { id: user.id, username: user.username, fullName: user.full_name, role: user.role };
  res.json({ ok: true, user: req.session.user });
});

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/auth/me', (req, res) => {
  if (!req.session.user) return res.status(401).json({ ok: false, error: 'Not authenticated' });
  res.json({ ok: true, user: req.session.user });
});

app.use('/api', requireAuth);

// --- Medicines ---

app.get('/api/medicines', (req, res) => {
  const meds = medicineRepo.findAll();
  const today = new Date().toISOString().split('T')[0];

  const enriched = meds.map(m => {
    const batches = batchRepo.findByMedicine(m.id);
    const available = batches
      .filter(b => b.expiryDate >= today)
      .reduce((sum, b) => sum + b.quantityAvailable, 0);
    const expiringSoon = batches.some(b => {
      const days = (new Date(b.expiryDate) - new Date()) / (1000 * 60 * 60 * 24);
      return days >= 0 && days <= 30;
    });
    return {
      ...m,
      totalAvailable: available,
      lowStock: available <= m.low_stock_threshold,
      expiringSoon
    };
  });
  res.json(enriched);
});

app.get('/api/medicines/:id/batches', (req, res) => {
  const batches = batchRepo.findByMedicine(req.params.id);
  res.json(batches);
});

// --- Sales ---

app.post('/api/sales', requireRole('CASHIER', 'PHARMACIST'), (req, res) => {
  try {
    const { lines } = req.body;
    const cashierId = req.session.user.id;
    const result = saleService.completeSale(lines, cashierId);
    res.json({ ok: true, sale: result.sale, lines: result.lines });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

app.get('/api/sales', (req, res) => {
  const sales = saleRepo.findRecent(20);
  const enriched = sales.map(s => ({
    ...s,
    lines: saleRepo.findLinesBySale(s.id)
  }));
  res.json(enriched);
});


app.get('/api/sales/:id', (req, res) => {
  const sale = db.prepare(`
    SELECT s.*, u.full_name AS cashier_name
    FROM sales s JOIN users u ON s.cashier_id = u.id
    WHERE s.id = ?
  `).get(req.params.id);
  if (!sale) return res.status(404).json({ ok: false, error: 'Sale not found' });

  const lines = saleRepo.findLinesBySale(sale.id);
  const getReturned = db.prepare(`
    SELECT COALESCE(SUM(rl.quantity), 0) AS n
    FROM return_lines rl
    JOIN returns r ON rl.return_id = r.id
    WHERE rl.sale_line_id = ? AND r.status != 'REJECTED'
  `);
  const enriched = lines.map(l => {
    const already = getReturned.get(l.id).n;
    return { ...l, alreadyReturned: already, returnable: l.quantity - already };
  });
  res.json({ ok: true, sale, lines: enriched });
});

// --- Returns ---

app.get('/api/returns', (req, res) => {
  const rows = db.prepare(`
    SELECT r.*,
           u1.full_name AS cashier_name,
           u2.full_name AS pharmacist_name,
           s.total_amount AS sale_total
    FROM returns r
    JOIN users u1 ON r.cashier_id = u1.id
    LEFT JOIN users u2 ON r.pharmacist_id = u2.id
    JOIN sales s ON r.sale_id = s.id
    ORDER BY r.initiated_at DESC
    LIMIT 40
  `).all();

  const getLines = db.prepare(`
    SELECT rl.*, m.name AS medicine_name, b.batch_number
    FROM return_lines rl
    JOIN medicines m ON rl.medicine_id = m.id
    JOIN batches b ON rl.batch_id = b.id
    WHERE rl.return_id = ?
  `);
  res.json(rows.map(r => ({ ...r, lines: getLines.all(r.id) })));
});

app.post('/api/returns', requireRole('CASHIER', 'PHARMACIST'), (req, res) => {
  const { saleId, lines, reasonCode, notes } = req.body || {};

  if (!saleId || !Array.isArray(lines) || lines.length === 0 || !reasonCode) {
    return res.status(400).json({ ok: false, error: 'saleId, lines, and reasonCode are required' });
  }

  const sale = db.prepare('SELECT * FROM sales WHERE id = ?').get(saleId);
  if (!sale) return res.status(404).json({ ok: false, error: 'Sale not found' });

  // Returns must be initiated within 24 hours of the sale
  const ageHours = (Date.now() - new Date(sale.timestamp).getTime()) / 36e5;
  if (ageHours > 24) {
    return res.status(400).json({ ok: false, error: 'Returns must be initiated within 24 hours of the sale' });
  }

  const validCodes = ['DISPENSING_ERROR', 'PATIENT_DECLINED', 'NEAR_EXPIRY', 'OTHER'];
  if (!validCodes.includes(reasonCode)) {
    return res.status(400).json({ ok: false, error: 'Invalid reason code' });
  }

  const saleLines = saleRepo.findLinesBySale(saleId);
  const getReturned = db.prepare(`
    SELECT COALESCE(SUM(rl.quantity), 0) AS n
    FROM return_lines rl
    JOIN returns r ON rl.return_id = r.id
    WHERE rl.sale_line_id = ? AND r.status != 'REJECTED'
  `);

  const resolved = [];
  for (const l of lines) {
    if (!l.saleLineId || !(l.quantity > 0)) {
      return res.status(400).json({ ok: false, error: 'Each line needs saleLineId and positive quantity' });
    }
    const sl = saleLines.find(x => x.id === l.saleLineId);
    if (!sl) return res.status(400).json({ ok: false, error: `Sale line ${l.saleLineId} not found in this sale` });

    const already    = getReturned.get(l.saleLineId).n;
    const returnable = sl.quantity - already;
    if (l.quantity > returnable) {
      return res.status(400).json({
        ok: false,
        error: `Cannot return ${l.quantity} of "${sl.medicine_name}": only ${returnable} returnable`
      });
    }
    resolved.push({
      id: generateId('RL'), saleLineId: l.saleLineId,
      medicineId: sl.medicine_id, batchId: sl.batch_id,
      quantity: l.quantity, unitPrice: sl.unit_price_at_sale
    });
  }

  try {
    const returnId = generateId('RET');
    const now      = new Date().toISOString();
    db.transaction(() => {
      db.prepare(`
        INSERT INTO returns (id, sale_id, cashier_id, initiated_at, reason_code, status, notes)
        VALUES (?, ?, ?, ?, ?, 'PENDING_AUTH', ?)
      `).run(returnId, saleId, req.session.user.id, now, reasonCode, notes || null);

      const insertLine = db.prepare(`
        INSERT INTO return_lines
          (id, return_id, sale_line_id, medicine_id, batch_id, quantity, unit_price)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      for (const l of resolved) {
        insertLine.run(l.id, returnId, l.saleLineId, l.medicineId, l.batchId, l.quantity, l.unitPrice);
      }
    })();

    const ret = db.prepare('SELECT * FROM returns WHERE id = ?').get(returnId);
    res.json({ ok: true, return: ret });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

app.post('/api/returns/:id/authorize', requireRole('PHARMACIST', 'ADMINISTRATOR'), (req, res) => {
  const { decision, dispositions } = req.body || {};

  if (!['AUTHORIZED', 'REJECTED'].includes(decision)) {
    return res.status(400).json({ ok: false, error: 'decision must be AUTHORIZED or REJECTED' });
  }

  const ret = db.prepare('SELECT * FROM returns WHERE id = ?').get(req.params.id);
  if (!ret) return res.status(404).json({ ok: false, error: 'Return not found' });
  if (ret.status !== 'PENDING_AUTH') {
    return res.status(400).json({ ok: false, error: `Return is already ${ret.status}` });
  }

  const now          = new Date().toISOString();
  const pharmacistId = req.session.user.id;

  if (decision === 'REJECTED') {
    db.prepare(`
      UPDATE returns SET status = 'REJECTED', pharmacist_id = ?, authorized_at = ? WHERE id = ?
    `).run(pharmacistId, now, ret.id);
    return res.json({ ok: true, status: 'REJECTED' });
  }

  const returnLines = db.prepare('SELECT * FROM return_lines WHERE return_id = ?').all(ret.id);
  if (!Array.isArray(dispositions) || dispositions.length !== returnLines.length) {
    return res.status(400).json({ ok: false, error: 'A disposition is required for every return line' });
  }
  const validDisp = ['RESTOCK', 'QUARANTINE', 'DISPOSE'];
  for (const d of dispositions) {
    if (!validDisp.includes(d.disposition)) {
      return res.status(400).json({ ok: false, error: `Invalid disposition: ${d.disposition}` });
    }
  }

  try {
    db.transaction(() => {
      for (const d of dispositions) {
        const line = returnLines.find(l => l.id === d.returnLineId);
        if (!line) throw new Error(`Return line ${d.returnLineId} not found`);

        db.prepare('UPDATE return_lines SET disposition = ? WHERE id = ?').run(d.disposition, line.id);

        if (d.disposition === 'RESTOCK') {
          db.prepare(
            'UPDATE batches SET quantity_available = quantity_available + ? WHERE id = ?'
          ).run(line.quantity, line.batch_id);
          db.prepare(`
            INSERT INTO stock_movements
              (id, batch_id, user_id, timestamp, type, quantity_delta, reason_code, return_id)
            VALUES (?, ?, ?, ?, 'RETURN', ?, ?, ?)
          `).run(generateId('MV'), line.batch_id, pharmacistId, now, line.quantity, ret.reason_code, ret.id);

        } else if (d.disposition === 'QUARANTINE') {
          db.prepare(
            'UPDATE batches SET quantity_quarantine = quantity_quarantine + ? WHERE id = ?'
          ).run(line.quantity, line.batch_id);
          db.prepare(`
            INSERT INTO stock_movements
              (id, batch_id, user_id, timestamp, type, quantity_delta, reason_code, return_id)
            VALUES (?, ?, ?, ?, 'QUARANTINE_IN', ?, ?, ?)
          `).run(generateId('MV'), line.batch_id, pharmacistId, now, line.quantity, ret.reason_code, ret.id);
        }
        // DISPOSE: no stock movement needed
      }

      db.prepare(`
        UPDATE returns SET status = 'AUTHORIZED', pharmacist_id = ?, authorized_at = ? WHERE id = ?
      `).run(pharmacistId, now, ret.id);
    })();

    res.json({ ok: true, status: 'AUTHORIZED' });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

// --- Quarantine ---

app.get('/api/quarantine', requireRole('PHARMACIST', 'ADMINISTRATOR'), (req, res) => {
  const rows = db.prepare(`
    SELECT rl.id AS return_line_id, rl.return_id, rl.batch_id, rl.medicine_id,
           rl.quantity, rl.unit_price,
           r.reason_code, r.authorized_at, r.sale_id,
           m.name AS medicine_name,
           b.batch_number, b.expiry_date, b.quantity_quarantine
    FROM return_lines rl
    JOIN returns r  ON rl.return_id   = r.id
    JOIN medicines m ON rl.medicine_id = m.id
    JOIN batches b   ON rl.batch_id    = b.id
    WHERE rl.disposition            = 'QUARANTINE'
      AND rl.quarantine_resolution  IS NULL
      AND r.status                  = 'AUTHORIZED'
    ORDER BY r.authorized_at DESC
  `).all();
  res.json(rows);
});

app.post('/api/quarantine/:returnLineId/resolve', requireRole('PHARMACIST', 'ADMINISTRATOR'), (req, res) => {
  const { resolution } = req.body || {};
  if (!['RELEASE', 'DISPOSE'].includes(resolution)) {
    return res.status(400).json({ ok: false, error: 'resolution must be RELEASE or DISPOSE' });
  }

  const line = db.prepare(`
    SELECT rl.*, r.reason_code
    FROM return_lines rl
    JOIN returns r ON rl.return_id = r.id
    WHERE rl.id = ? AND rl.disposition = 'QUARANTINE' AND rl.quarantine_resolution IS NULL
  `).get(req.params.returnLineId);

  if (!line) {
    return res.status(404).json({ ok: false, error: 'Quarantined item not found or already resolved' });
  }

  // Release back to stock is only allowed when the original return reason was a dispensing error
  if (resolution === 'RELEASE' && line.reason_code !== 'DISPENSING_ERROR') {
    return res.status(400).json({
      ok: false,
      error: `Release is only allowed for dispensing errors. This return reason is "${line.reason_code}" — use DISPOSE.`
    });
  }

  try {
    const now    = new Date().toISOString();
    const userId = req.session.user.id;
    db.transaction(() => {
      db.prepare(
        'UPDATE batches SET quantity_quarantine = quantity_quarantine - ? WHERE id = ?'
      ).run(line.quantity, line.batch_id);

      if (resolution === 'RELEASE') {
        db.prepare(
          'UPDATE batches SET quantity_available = quantity_available + ? WHERE id = ?'
        ).run(line.quantity, line.batch_id);
        db.prepare(`
          INSERT INTO stock_movements
            (id, batch_id, user_id, timestamp, type, quantity_delta, reason_code, return_id)
          VALUES (?, ?, ?, ?, 'QUARANTINE_OUT', ?, 'RELEASE', ?)
        `).run(generateId('MV'), line.batch_id, userId, now, line.quantity, line.return_id);
      } else {
        // DISPOSE: quarantine decreases, available stays the same
        db.prepare(`
          INSERT INTO stock_movements
            (id, batch_id, user_id, timestamp, type, quantity_delta, reason_code, return_id)
          VALUES (?, ?, ?, ?, 'QUARANTINE_OUT', ?, 'DISPOSE', ?)
        `).run(generateId('MV'), line.batch_id, userId, now, -line.quantity, line.return_id);
      }

      db.prepare('UPDATE return_lines SET quarantine_resolution = ? WHERE id = ?')
        .run(resolution, line.id);
    })();
    res.json({ ok: true, resolution });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

// --- Stock adjustments ---

app.get('/api/adjustments', requireRole('PHARMACIST', 'ADMINISTRATOR'), (req, res) => {
  const rows = db.prepare(`
    SELECT sm.*, m.name AS medicine_name, b.batch_number, u.full_name AS user_name
    FROM stock_movements sm
    JOIN batches b   ON sm.batch_id = b.id
    JOIN medicines m ON b.medicine_id = m.id
    JOIN users u     ON sm.user_id = u.id
    WHERE sm.type = 'ADJUSTMENT'
    ORDER BY sm.timestamp DESC
    LIMIT 40
  `).all();
  res.json(rows);
});

app.post('/api/adjustments', requireRole('PHARMACIST', 'ADMINISTRATOR'), (req, res) => {
  const { batchId, delta, reasonCode, notes } = req.body || {};

  if (!batchId || delta === undefined || delta === null || !reasonCode) {
    return res.status(400).json({ ok: false, error: 'batchId, delta, and reasonCode are required' });
  }
  const d = parseInt(delta, 10);
  if (!Number.isInteger(d) || d === 0) {
    return res.status(400).json({ ok: false, error: 'delta must be a non-zero integer' });
  }
  const validReasons = ['PHYSICAL_COUNT', 'DAMAGED', 'SPILLAGE', 'ADMINISTRATIVE', 'OTHER'];
  if (!validReasons.includes(reasonCode)) {
    return res.status(400).json({ ok: false, error: 'Invalid reason code' });
  }

  const batch = batchRepo.findById(batchId);
  if (!batch) return res.status(404).json({ ok: false, error: 'Batch not found' });

  if (batch.quantityAvailable + d < 0) {
    return res.status(400).json({
      ok: false,
      error: `Adjustment would make stock negative (current ${batch.quantityAvailable}, delta ${d > 0 ? '+' : ''}${d})`
    });
  }

  try {
    const now    = new Date().toISOString();
    const userId = req.session.user.id;
    db.transaction(() => {
      db.prepare(
        'UPDATE batches SET quantity_available = quantity_available + ? WHERE id = ?'
      ).run(d, batchId);
      db.prepare(`
        INSERT INTO stock_movements
          (id, batch_id, user_id, timestamp, type, quantity_delta, reason_code)
        VALUES (?, ?, ?, ?, 'ADJUSTMENT', ?, ?)
      `).run(generateId('MV'), batchId, userId, now, d, reasonCode);
    })();

    const updated = batchRepo.findById(batchId);
    res.json({ ok: true, batch: updated });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

// --- Batches ---

app.get('/api/batches', requireRole('PHARMACIST', 'ADMINISTRATOR'), (req, res) => {
  const rows = db.prepare(`
    SELECT b.*, m.name AS medicine_name, m.unit_of_measure
    FROM batches b
    JOIN medicines m ON b.medicine_id = m.id
    ORDER BY m.name ASC, b.expiry_date ASC
  `).all();
  res.json(rows);
});

app.post('/api/batches', requireRole('PHARMACIST', 'ADMINISTRATOR'), (req, res) => {
  const { medicineId, batchNumber, supplierName, intakeDate, expiryDate, quantityReceived } = req.body || {};

  if (!medicineId || !batchNumber || !supplierName || !intakeDate || !expiryDate || !quantityReceived) {
    return res.status(400).json({ ok: false, error: 'All fields are required' });
  }
  const qty = parseInt(quantityReceived, 10);
  if (!Number.isInteger(qty) || qty <= 0) {
    return res.status(400).json({ ok: false, error: 'Quantity must be a positive integer' });
  }
  const today = new Date().toISOString().split('T')[0];
  if (expiryDate <= intakeDate) {
    return res.status(400).json({ ok: false, error: 'Expiry date must be after intake date' });
  }
  if (expiryDate <= today) {
    return res.status(400).json({ ok: false, error: 'Expiry date must be in the future' });
  }

  const medicine = medicineRepo.findById(medicineId);
  if (!medicine || !medicine.active) {
    return res.status(400).json({ ok: false, error: 'Medicine not found or discontinued' });
  }
  const duplicate = db.prepare(
    'SELECT id FROM batches WHERE medicine_id = ? AND batch_number = ?'
  ).get(medicineId, batchNumber.trim());
  if (duplicate) {
    return res.status(400).json({ ok: false, error: `Batch "${batchNumber}" already registered for this medicine` });
  }

  try {
    const batchId = generateId('BAT');
    const now     = new Date().toISOString();
    db.transaction(() => {
      db.prepare(`
        INSERT INTO batches
          (id, medicine_id, batch_number, supplier_name, intake_date, expiry_date,
           quantity_received, quantity_available)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(batchId, medicineId, batchNumber.trim(), supplierName.trim(),
             intakeDate, expiryDate, qty, qty);

      db.prepare(`
        INSERT INTO stock_movements
          (id, batch_id, user_id, timestamp, type, quantity_delta, reason_code)
        VALUES (?, ?, ?, ?, 'INTAKE', ?, 'BATCH_REGISTRATION')
      `).run(generateId('MV'), batchId, req.session.user.id, now, qty);
    })();

    const batch = batchRepo.findById(batchId);
    res.json({ ok: true, batch });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

// --- Users ---

app.get('/api/users', requireRole('ADMINISTRATOR'), (req, res) => {
  const users = db.prepare(`
    SELECT id, username, full_name, role, active, created_at
    FROM users
    ORDER BY role, full_name
  `).all();
  res.json(users);
});

app.post('/api/users', requireRole('ADMINISTRATOR'), (req, res) => {
  const { username, fullName, password, role } = req.body || {};
  if (!username || !fullName || !password || !role) {
    return res.status(400).json({ ok: false, error: 'username, fullName, password, and role are required' });
  }
  const validRoles = ['ADMINISTRATOR', 'PHARMACIST', 'CASHIER'];
  if (!validRoles.includes(role)) {
    return res.status(400).json({ ok: false, error: 'Invalid role' });
  }
  const taken = db.prepare('SELECT id FROM users WHERE username = ?').get(username.trim().toLowerCase());
  if (taken) {
    return res.status(400).json({ ok: false, error: `Username "${username}" is already taken` });
  }
  try {
    const id  = generateId('USR');
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO users (id, username, full_name, password_hash, role, active, created_at)
      VALUES (?, ?, ?, ?, ?, 1, ?)
    `).run(id, username.trim().toLowerCase(), fullName.trim(), password, role, now);
    const user = db.prepare(
      'SELECT id, username, full_name, role, active, created_at FROM users WHERE id = ?'
    ).get(id);
    res.json({ ok: true, user });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

app.patch('/api/users/:id', requireRole('ADMINISTRATOR'), (req, res) => {
  const { active, newPassword } = req.body || {};
  const target = db.prepare('SELECT id FROM users WHERE id = ?').get(req.params.id);
  if (!target) return res.status(404).json({ ok: false, error: 'User not found' });

  if ((active === 0 || active === false) && req.params.id === req.session.user.id) {
    return res.status(400).json({ ok: false, error: 'You cannot deactivate your own account' });
  }
  if (active !== undefined && active !== null) {
    db.prepare('UPDATE users SET active = ? WHERE id = ?').run(active ? 1 : 0, req.params.id);
  }
  if (newPassword) {
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(newPassword, req.params.id);
  }
  const updated = db.prepare(
    'SELECT id, username, full_name, role, active, created_at FROM users WHERE id = ?'
  ).get(req.params.id);
  res.json({ ok: true, user: updated });
});

// --- Alerts ---

app.get('/api/alerts', (req, res) => {
  const today = new Date().toISOString().split('T')[0];
  const soon  = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

  const lowStock = db.prepare(`
    SELECT m.id, m.name, m.category, m.low_stock_threshold,
           COALESCE(SUM(b.quantity_available), 0) AS total_available
    FROM medicines m
    LEFT JOIN batches b ON b.medicine_id = m.id AND b.expiry_date >= ?
    WHERE m.active = 1
    GROUP BY m.id
    HAVING total_available <= m.low_stock_threshold
    ORDER BY total_available ASC
  `).all(today);

  const expiringSoon = db.prepare(`
    SELECT b.id, b.batch_number, b.expiry_date, b.quantity_available,
           m.name AS medicine_name, m.id AS medicine_id
    FROM batches b
    JOIN medicines m ON m.id = b.medicine_id
    WHERE b.expiry_date >= ? AND b.expiry_date <= ? AND b.quantity_available > 0
    ORDER BY b.expiry_date ASC
  `).all(today, soon);

  res.json({ lowStock, expiringSoon });
});

// --- Reports ---

app.get('/api/reports/sales', requireRole('PHARMACIST', 'ADMINISTRATOR'), (req, res) => {
  try {
    const { from, to } = req.query;
    const fromTs = from ? `${from}T00:00:00.000Z` : '1970-01-01T00:00:00.000Z';
    const toTs   = to   ? `${to}T23:59:59.999Z`   : new Date().toISOString();

    const summary = db.prepare(`
      SELECT COUNT(DISTINCT s.id)              AS sale_count,
             COALESCE(SUM(s.total_amount), 0)  AS total_revenue
      FROM sales s
      WHERE s.timestamp >= ? AND s.timestamp <= ?
    `).get(fromTs, toTs);

    const byMedicine = db.prepare(`
      SELECT m.name AS medicine_name, m.category,
             SUM(sl.quantity)                         AS units_sold,
             SUM(sl.quantity * sl.unit_price_at_sale) AS revenue
      FROM sale_lines sl
      JOIN medicines m ON sl.medicine_id = m.id
      JOIN sales s     ON sl.sale_id     = s.id
      WHERE s.timestamp >= ? AND s.timestamp <= ?
      GROUP BY m.id
      ORDER BY revenue DESC
    `).all(fromTs, toTs);

    res.json({ summary, byMedicine, from, to });
  } catch (err) {
    console.error('Report error (sales):', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/reports/stock-valuation', requireRole('PHARMACIST', 'ADMINISTRATOR'), (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];

    const rows = db.prepare(`
      SELECT m.id, m.name, m.category, m.unit_price,
             COALESCE(SUM(CASE WHEN b.expiry_date >= ? THEN b.quantity_available ELSE 0 END), 0) AS available,
             COALESCE(SUM(b.quantity_quarantine), 0) AS quarantine,
             COALESCE(SUM(CASE WHEN b.expiry_date >= ? THEN b.quantity_available ELSE 0 END), 0) AS sellable_units
      FROM medicines m
      LEFT JOIN batches b ON b.medicine_id = m.id
      WHERE m.active = 1
      GROUP BY m.id
      ORDER BY m.name ASC
    `).all(today, today);

    const withValue = rows.map(r => ({ ...r, sellable_value: r.sellable_units * r.unit_price }));
    const totalSellable = withValue.reduce((s, r) => s + r.sellable_value, 0);
    res.json({ rows: withValue, totalSellable, asOf: today });
  } catch (err) {
    console.error('Report error (stock-valuation):', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/reports/expiry', requireRole('PHARMACIST', 'ADMINISTRATOR'), (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    const soon  = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

    const rows = db.prepare(`
      SELECT b.id, b.batch_number, b.expiry_date,
             b.quantity_available, b.quantity_quarantine,
             m.name AS medicine_name, m.category,
             CASE
               WHEN b.expiry_date <  ? THEN 'EXPIRED'
               WHEN b.expiry_date <= ? THEN 'EXPIRING_SOON'
               ELSE 'OK'
             END AS status
      FROM batches b
      JOIN medicines m ON b.medicine_id = m.id
      WHERE m.active = 1
      ORDER BY b.expiry_date ASC
    `).all(today, soon);

    res.json({ rows, asOf: today });
  } catch (err) {
    console.error('Report error (expiry):', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/reports/movements', requireRole('PHARMACIST', 'ADMINISTRATOR'), (req, res) => {
  try {
    const { from, to, type } = req.query;
    const fromTs = from ? `${from}T00:00:00.000Z` : '1970-01-01T00:00:00.000Z';
    const toTs   = to   ? `${to}T23:59:59.999Z`   : new Date().toISOString();

    const validTypes = ['INTAKE','SALE','RETURN','ADJUSTMENT','QUARANTINE_IN','QUARANTINE_OUT'];
    const useType    = type && validTypes.includes(type);

    const rows = db.prepare(`
      SELECT sm.timestamp, sm.type, sm.quantity_delta, sm.reason_code,
             m.name AS medicine_name, b.batch_number, u.full_name AS user_name
      FROM stock_movements sm
      JOIN batches b   ON sm.batch_id   = b.id
      JOIN medicines m ON b.medicine_id = m.id
      JOIN users u     ON sm.user_id    = u.id
      WHERE sm.timestamp >= ? AND sm.timestamp <= ?
      ${useType ? 'AND sm.type = ?' : ''}
      ORDER BY sm.timestamp DESC
      LIMIT 200
    `).all(...(useType ? [fromTs, toTs, type] : [fromTs, toTs]));

    res.json({ rows, from, to, type: type || 'ALL' });
  } catch (err) {
    console.error('Report error (movements):', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// --- Audit ledger ---

app.get('/api/movements', (req, res) => {
  const movements = movementRepo.findRecent(50);
  res.json(movements);
});


const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Pharmacy prototype running on http://localhost:${PORT}`);
  console.log('Demo accounts: admin/admin123  fatou/fatou123  amadou/amadou123');
});
