const { DatabaseSync } = require('node:sqlite');
const path = require('path');

const dbPath = path.join(__dirname, 'pharmacy.db');
const db = new DatabaseSync(dbPath);

db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id              TEXT PRIMARY KEY,
    username        TEXT NOT NULL UNIQUE,
    full_name       TEXT NOT NULL,
    password_hash   TEXT NOT NULL,
    role            TEXT NOT NULL CHECK (role IN ('ADMINISTRATOR','PHARMACIST','CASHIER')),
    active          INTEGER NOT NULL DEFAULT 1,
    created_at      TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS medicines (
    id                     TEXT PRIMARY KEY,
    name                   TEXT NOT NULL,
    category               TEXT NOT NULL,
    manufacturer           TEXT,
    unit_of_measure        TEXT NOT NULL,
    unit_price             REAL NOT NULL CHECK (unit_price >= 0),
    prescription_required  INTEGER NOT NULL DEFAULT 0,
    low_stock_threshold    INTEGER NOT NULL CHECK (low_stock_threshold >= 0),
    active                 INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS batches (
    id                  TEXT PRIMARY KEY,
    medicine_id         TEXT NOT NULL REFERENCES medicines(id),
    batch_number        TEXT NOT NULL,
    supplier_name       TEXT NOT NULL,
    intake_date         TEXT NOT NULL,
    expiry_date         TEXT NOT NULL,
    quantity_received   INTEGER NOT NULL CHECK (quantity_received > 0),
    quantity_available  INTEGER NOT NULL CHECK (quantity_available >= 0),
    quantity_quarantine INTEGER NOT NULL DEFAULT 0 CHECK (quantity_quarantine >= 0),
    UNIQUE (medicine_id, batch_number),
    CHECK (expiry_date > intake_date)
  );

  CREATE TABLE IF NOT EXISTS sales (
    id                     TEXT PRIMARY KEY,
    cashier_id             TEXT NOT NULL REFERENCES users(id),
    timestamp              TEXT NOT NULL,
    total_amount           REAL NOT NULL CHECK (total_amount >= 0),
    status                 TEXT NOT NULL CHECK (status IN ('COMPLETED')),
    originating_return_id  TEXT
  );

  CREATE TABLE IF NOT EXISTS sale_lines (
    id                  TEXT PRIMARY KEY,
    sale_id             TEXT NOT NULL REFERENCES sales(id),
    medicine_id         TEXT NOT NULL REFERENCES medicines(id),
    batch_id            TEXT NOT NULL REFERENCES batches(id),
    quantity            INTEGER NOT NULL CHECK (quantity > 0),
    unit_price_at_sale  REAL NOT NULL CHECK (unit_price_at_sale >= 0)
  );

  CREATE TABLE IF NOT EXISTS returns (
    id            TEXT PRIMARY KEY,
    sale_id       TEXT NOT NULL REFERENCES sales(id),
    cashier_id    TEXT NOT NULL REFERENCES users(id),
    pharmacist_id TEXT REFERENCES users(id),
    initiated_at  TEXT NOT NULL,
    authorized_at TEXT,
    reason_code   TEXT NOT NULL CHECK (reason_code IN (
                    'DISPENSING_ERROR','PATIENT_DECLINED','NEAR_EXPIRY','OTHER'
                  )),
    status        TEXT NOT NULL CHECK (status IN (
                    'PENDING_AUTH','AUTHORIZED','REJECTED'
                  )),
    notes         TEXT
  );

  CREATE TABLE IF NOT EXISTS return_lines (
    id           TEXT PRIMARY KEY,
    return_id    TEXT NOT NULL REFERENCES returns(id),
    sale_line_id TEXT NOT NULL REFERENCES sale_lines(id),
    medicine_id  TEXT NOT NULL REFERENCES medicines(id),
    batch_id     TEXT NOT NULL REFERENCES batches(id),
    quantity     INTEGER NOT NULL CHECK (quantity > 0),
    unit_price   REAL NOT NULL CHECK (unit_price >= 0),
    disposition  TEXT CHECK (disposition IN ('RESTOCK','QUARANTINE','DISPOSE'))
  );

  CREATE TABLE IF NOT EXISTS stock_movements (
    id             TEXT PRIMARY KEY,
    batch_id       TEXT NOT NULL REFERENCES batches(id),
    user_id        TEXT NOT NULL REFERENCES users(id),
    timestamp      TEXT NOT NULL,
    type           TEXT NOT NULL CHECK (type IN (
                     'INTAKE','SALE','RETURN','ADJUSTMENT','QUARANTINE_IN','QUARANTINE_OUT'
                   )),
    quantity_delta INTEGER NOT NULL,
    reason_code    TEXT,
    sale_id        TEXT REFERENCES sales(id),
    return_id      TEXT REFERENCES returns(id)
  );
`);

// Add quarantine resolution column if it doesn't exist yet
try { db.exec('ALTER TABLE return_lines ADD COLUMN quarantine_resolution TEXT'); } catch (_) {}


db.transaction = (fn) => {
  return (...args) => {
    db.exec('BEGIN');
    try {
      const result = fn(...args);
      db.exec('COMMIT');
      return result;
    } catch (err) {
      try { db.exec('ROLLBACK'); } catch (_) { /* already rolled back */ }
      throw err;
    }
  };
};

// Seed demo data on first run
const userCount = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;

if (userCount === 0) {
  const now = new Date().toISOString();

  const insertUser = db.prepare(`
    INSERT INTO users (id, username, full_name, password_hash, role, active, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  insertUser.run('USR-001', 'admin',  'System Administrator', 'admin123',  'ADMINISTRATOR', 1, now);
  insertUser.run('USR-002', 'fatou',  'Fatou Diop',           'fatou123',  'PHARMACIST',    1, now);
  insertUser.run('USR-003', 'amadou', 'Amadou Sow',           'amadou123', 'CASHIER',       1, now);

  const insertMed = db.prepare(`
    INSERT INTO medicines (id, name, category, manufacturer, unit_of_measure,
                           unit_price, prescription_required, low_stock_threshold, active)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insertMed.run('MED-001', 'Paracetamol 500mg',  'Analgesic',     'Laborex',   'tablet',  50.00,  0, 100, 1);
  insertMed.run('MED-002', 'Amoxicillin 250mg',  'Antibiotic',    'Laborex',   'capsule', 200.00, 1,  50, 1);
  insertMed.run('MED-003', 'Ibuprofen 400mg',    'Analgesic',     'Sanofi',    'tablet',  75.00,  0,  80, 1);
  insertMed.run('MED-004', 'Cetirizine 10mg',    'Antihistamine', 'Pharmamed', 'tablet',  120.00, 0,  40, 1);
  insertMed.run('MED-005', 'Omeprazole 20mg',    'Antacid',       'Pfizer',    'capsule', 250.00, 1,  30, 1);

  const today = new Date();
  const dateStr = (offsetDays) => {
    const d = new Date(today);
    d.setDate(d.getDate() + offsetDays);
    return d.toISOString().split('T')[0];
  };

  const batches = [
    // Paracetamol: two batches, one expiring sooner
    ['BAT-001', 'MED-001', 'PAR-2026-A', 'Laborex Senegal',      dateStr(-30), dateStr(60),  200, 200],
    ['BAT-002', 'MED-001', 'PAR-2026-B', 'Laborex Senegal',      dateStr(-5),  dateStr(365), 500, 500],
    // Amoxicillin: one batch expiring soon
    ['BAT-003', 'MED-002', 'AMX-2026-A', 'Laborex Senegal',      dateStr(-60), dateStr(15),  100, 100],
    ['BAT-004', 'MED-002', 'AMX-2026-B', 'Laborex Senegal',      dateStr(-10), dateStr(200), 150, 150],
    // Ibuprofen: single batch
    ['BAT-005', 'MED-003', 'IBU-2026-A', 'Sanofi Distribution',  dateStr(-15), dateStr(300), 250, 250],
    // Cetirizine: low stock
    ['BAT-006', 'MED-004', 'CET-2026-A', 'Pharmamed',            dateStr(-20), dateStr(180),  30,  30],
    // Omeprazole: regular batch
    ['BAT-007', 'MED-005', 'OMP-2026-A', 'Pfizer Senegal',       dateStr(-10), dateStr(400),  80,  80],
  ];

  const insertBatch = db.prepare(`
    INSERT INTO batches (id, medicine_id, batch_number, supplier_name,
                         intake_date, expiry_date, quantity_received, quantity_available)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertMovement = db.prepare(`
    INSERT INTO stock_movements (id, batch_id, user_id, timestamp, type, quantity_delta, reason_code)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  let mvCounter = 1;
  for (const b of batches) {
    insertBatch.run(...b);
    const mvId = `MV-${String(mvCounter).padStart(4, '0')}`;
    insertMovement.run(mvId, b[0], 'USR-002', now, 'INTAKE', b[6], 'INITIAL_INTAKE');
    mvCounter++;
  }

  console.log('Database seeded with demo data.');
}

module.exports = db;
