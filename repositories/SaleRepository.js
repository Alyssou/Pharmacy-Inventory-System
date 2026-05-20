class SaleRepository {
  constructor(db) { this.db = db; }

  save(sale) {
    this.db.prepare(`
      INSERT INTO sales (id, cashier_id, timestamp, total_amount, status, originating_return_id)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(sale.id, sale.cashierId, sale.timestamp, sale.totalAmount, sale.status, sale.originatingReturnId || null);

    const insertLine = this.db.prepare(`
      INSERT INTO sale_lines (id, sale_id, medicine_id, batch_id, quantity, unit_price_at_sale)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    for (const line of sale.lines) {
      insertLine.run(line.id, sale.id, line.medicineId, line.batchId, line.quantity, line.unitPriceAtSale);
    }
  }

  findRecent(limit = 20) {
    return this.db.prepare(`
      SELECT s.*, u.full_name AS cashier_name
      FROM sales s
      JOIN users u ON s.cashier_id = u.id
      ORDER BY s.timestamp DESC
      LIMIT ?
    `).all(limit);
  }

  findLinesBySale(saleId) {
    return this.db.prepare(`
      SELECT sl.*, m.name AS medicine_name, b.batch_number, b.expiry_date
      FROM sale_lines sl
      JOIN medicines m ON sl.medicine_id = m.id
      JOIN batches b ON sl.batch_id = b.id
      WHERE sl.sale_id = ?
    `).all(saleId);
  }
}

module.exports = SaleRepository;
