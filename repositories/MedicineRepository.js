class MedicineRepository {
  constructor(db) { this.db = db; }

  findAll() {
    return this.db.prepare(`
      SELECT * FROM medicines WHERE active = 1 ORDER BY name
    `).all();
  }

  findById(id) {
    return this.db.prepare(`SELECT * FROM medicines WHERE id = ?`).get(id);
  }
}

module.exports = MedicineRepository;
