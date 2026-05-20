const Batch = require('../domain/Batch');

class BatchRepository {
  constructor(db) { this.db = db; }

  findById(id) {
    const row = this.db.prepare(`SELECT * FROM batches WHERE id = ?`).get(id);
    return row ? new Batch(row) : null;
  }

  findByMedicine(medicineId) {
    const rows = this.db.prepare(`
      SELECT * FROM batches WHERE medicine_id = ? ORDER BY expiry_date ASC
    `).all(medicineId);
    return rows.map(r => new Batch(r));
  }

  // Picks the batch expiring soonest that has enough stock 
  findFEFOCandidate(medicineId, qty) {
    const today = new Date().toISOString().split('T')[0];
    const row = this.db.prepare(`
      SELECT * FROM batches
      WHERE medicine_id = ?
        AND quantity_available >= ?
        AND expiry_date >= ?
      ORDER BY expiry_date ASC, id ASC
      LIMIT 1
    `).get(medicineId, qty, today);
    return row ? new Batch(row) : null;
  }

  decrementAvailable(batchId, qty) {
    const result = this.db.prepare(`
      UPDATE batches
      SET quantity_available = quantity_available - ?
      WHERE id = ? AND quantity_available >= ?
    `).run(qty, batchId, qty);
    if (result.changes === 0) {
      throw new Error(`Failed to decrement batch ${batchId} (insufficient stock or not found)`);
    }
  }
}

module.exports = BatchRepository;
