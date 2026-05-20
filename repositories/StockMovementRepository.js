class StockMovementRepository {
  constructor(db) { this.db = db; }

  save(movement) {
    this.db.prepare(`
      INSERT INTO stock_movements
      (id, batch_id, user_id, timestamp, type, quantity_delta, reason_code, sale_id, return_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      movement.id,
      movement.batchId,
      movement.userId,
      movement.timestamp,
      movement.type,
      movement.quantityDelta,
      movement.reasonCode || null,
      movement.saleId || null,
      movement.returnId || null
    );
  }

  findRecent(limit = 50) {
    return this.db.prepare(`
      SELECT sm.*, m.name AS medicine_name, b.batch_number, u.full_name AS user_name
      FROM stock_movements sm
      JOIN batches b ON sm.batch_id = b.id
      JOIN medicines m ON b.medicine_id = m.id
      JOIN users u ON sm.user_id = u.id
      ORDER BY sm.timestamp DESC, sm.id DESC
      LIMIT ?
    `).all(limit);
  }

  findByBatch(batchId) {
    return this.db.prepare(`
      SELECT sm.*, u.full_name AS user_name
      FROM stock_movements sm
      JOIN users u ON sm.user_id = u.id
      WHERE sm.batch_id = ?
      ORDER BY sm.timestamp DESC
    `).all(batchId);
  }
}

module.exports = StockMovementRepository;
