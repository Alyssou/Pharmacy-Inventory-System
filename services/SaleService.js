const crypto = require('crypto');

class SaleService {
  constructor(db, batchRepository, saleRepository, stockMovementRepository, medicineRepository) {
    this.db = db;
    this.batchRepo = batchRepository;
    this.saleRepo = saleRepository;
    this.movementRepo = stockMovementRepository;
    this.medicineRepo = medicineRepository;
  }

  completeSale(lineRequests, cashierId) {
    if (!Array.isArray(lineRequests) || lineRequests.length === 0) {
      throw new Error('Sale must contain at least one line');
    }

    const resolvedLines = [];
    for (const req of lineRequests) {
      if (!req.medicineId || !req.quantity || req.quantity <= 0) {
        throw new Error('Invalid sale line');
      }
      const medicine = this.medicineRepo.findById(req.medicineId);
      if (!medicine || !medicine.active) {
        throw new Error(`Medicine ${req.medicineId} not found or discontinued`);
      }
      const batch = this.batchRepo.findFEFOCandidate(req.medicineId, req.quantity);
      if (!batch) {
        throw new Error(`OUT_OF_STOCK: no batch of "${medicine.name}" has ${req.quantity} units available`);
      }
      resolvedLines.push({
        medicineId: medicine.id,
        medicineName: medicine.name,
        batchId: batch.id,
        batchNumber: batch.batchNumber,
        quantity: req.quantity,
        unitPriceAtSale: medicine.unit_price,
        lineTotal: medicine.unit_price * req.quantity
      });
    }

    // write sale, lines, batch decrements, and audit records in one transaction.
    const sale = {
      id: this._generateId('SALE'),
      cashierId,
      timestamp: new Date().toISOString(),
      totalAmount: resolvedLines.reduce((sum, l) => sum + l.lineTotal, 0),
      status: 'COMPLETED',
      originatingReturnId: null,
      lines: resolvedLines.map((l, i) => ({
        id: `${this._generateId('SL')}-${i}`,
        medicineId: l.medicineId,
        batchId: l.batchId,
        quantity: l.quantity,
        unitPriceAtSale: l.unitPriceAtSale
      }))
    };

    const txn = this.db.transaction(() => {
      this.saleRepo.save(sale);
      for (const line of sale.lines) {
        this.batchRepo.decrementAvailable(line.batchId, line.quantity);
        this.movementRepo.save({
          id: this._generateId('MV'),
          batchId: line.batchId,
          userId: cashierId,
          timestamp: sale.timestamp,
          type: 'SALE',
          quantityDelta: -line.quantity,
          reasonCode: null,
          saleId: sale.id,
          returnId: null
        });
      }
    });

    txn();

    return { sale, lines: resolvedLines };
  }

  _generateId(prefix) {
    return `${prefix}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
  }
}

module.exports = SaleService;
