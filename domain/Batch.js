class Batch {
  constructor(row) {
    this.id = row.id;
    this.medicineId = row.medicine_id;
    this.batchNumber = row.batch_number;
    this.supplierName = row.supplier_name;
    this.intakeDate = row.intake_date;
    this.expiryDate = row.expiry_date;
    this.quantityReceived = row.quantity_received;
    this.quantityAvailable = row.quantity_available;
    this.quantityQuarantine = row.quantity_quarantine;
  }

  isExpired(asOf = new Date()) {
    return new Date(this.expiryDate) < new Date(asOf.toISOString().split('T')[0]);
  }

  hasSufficientAvailable(qty) {
    return this.quantityAvailable >= qty;
  }

  decrementAvailable(qty) {
    if (qty <= 0) throw new Error('Quantity must be positive');
    if (this.quantityAvailable < qty) {
      throw new Error(`Insufficient stock: batch ${this.id} has ${this.quantityAvailable}, needs ${qty}`);
    }
    this.quantityAvailable -= qty;
  }
}

module.exports = Batch;
