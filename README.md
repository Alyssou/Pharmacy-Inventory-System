# Pharmacy Inventory & Sales System — Prototype

**Course:** CS 2712 Software Design & Architecture
**Author:** Alyssa M. F. Youm

This is the full prototype implementation of the Pharmacy Inventory and Sales System,
covering all 10 build steps and demonstrating the complete domain logic described
in the project's design documentation.

## What's Implemented

All functional requirements from the SRS are implemented:

- **UC1 — User management** — Administrator can create, activate, and deactivate users
- **UC11 — Complete a Sale** with First-Expired-First-Out (FEFO) batch selection
- **Batch registration** — record new stock intake with supplier, batch number, and expiry date
- **Authentication & session management** (NFR5–NFR8) — login, role-based access control
- **Returns workflow** (UC7, UC8, UC13) — cashier initiates return; pharmacist authorizes or rejects; quarantine resolution with restock/dispose disposition
- **Stock adjustments** (UC9) — pharmacist-authorized quantity corrections with reason codes
- **Inventory alerts** — low-stock and expiry-soon flags on the medicine catalog
- **Reports** (UC10) — four report types: sales summary, stock levels, expiry report, audit ledger
- **Medicine catalog** with prescription flags and per-batch traceability
- **Append-only audit ledger** — every quantity change produces an immutable `StockMovement` record per business rule BR18

Business rules demonstrated end-to-end: **BR1** (no negative stock),
**BR4** (no expired sales), **BR5** (FEFO), **BR6** (atomic completion),
**BR7** (price frozen at sale time), **BR18** (immutable StockMovement),
**BR19** (append-only ledger).

## Architecture

The code follows the layered architecture from Chapter 8 of the SRS:

```
public/          → Presentation Layer  (HTML + JS frontend)
server.js        → API Layer           (Express controllers)
services/        → Application Layer   (SaleService — business logic)
domain/          → Domain Layer        (Batch — owns its invariants)
repositories/    → Persistence Layer   (SQLite-backed repositories)
db.js            → Database setup     (schema + seed data)
```

Services depend on repositories; repositories abstract SQLite (Repository
Pattern + Dependency Inversion Principle, as discussed in Chapter 10).

## Running

Requirements: Node.js ≥ 18.

```bash
npm install
npm start
```

Then open <http://localhost:3000> in a browser.

The database file (`pharmacy.db`) is created on first run and seeded with
3 demo users, 5 medicines, and 7 batches across different expiry dates to
demonstrate FEFO. To reset:

```bash
npm run reset
```

## Demo Walkthrough

Demo credentials:
- **admin / admin123** — Administrator (user management, reports, view batches; no sales, returns, or batch registration)
- **fatou / fatou123** — Pharmacist (authorize returns, stock adjustments)
- **amadou / amadou123** — Cashier (sales, return initiation)

1. **Login** — sign in with any demo account above.
2. **New Sale tab** — the catalog shows 5 medicines. Click any one to add it
   to the right-hand sale builder. Increase the quantity with `+`.
3. Click **Complete Sale**. A receipt modal appears showing which batch each
   line was drawn from. Notice that Paracetamol is drawn from `PAR-2026-A`
   first (earlier expiry) before `PAR-2026-B`, demonstrating FEFO.
4. **Sales History tab** — see all completed sales with batch attribution. From
   here a cashier can initiate a return on any completed sale.
5. **Returns tab** — pharmacist logs in to authorize or reject pending returns,
   then sets quarantine disposition (restock, quarantine, or dispose).
6. **Batches tab** — pharmacist registers new batch intake; admin can view batch inventory only.
   Medicines flagged low-stock or expiry-soon are highlighted in the catalog alerts.
7. **Stock Adjustments tab** — pharmacist can apply quantity corrections with a
   reason code; each adjustment writes an immutable StockMovement record.
8. **Reports tab** — four reports: sales summary, current stock levels, upcoming
   expiry, and the full audit ledger (BR18/BR19).
9. **Users tab** (admin only) — create, activate, and deactivate user accounts.

## File Map

| File | Purpose |
|---|---|
| `db.js` | SQLite schema (Chapter 9) + seed data |
| `domain/Batch.js` | Batch entity with invariants (BR1, BR2, BR3, BR4) |
| `repositories/*.js` | Persistence layer (Repository Pattern, Chapter 10) |
| `services/SaleService.js` | UC11 implementation with FEFO + atomicity |
| `server.js` | Express controllers + dependency wiring (auth, sales, batches, returns, adjustments, reports, users) |
| `public/index.html` | Single-page UI shell |
| `public/style.css` | Refined-utilitarian POS theme |
| `public/app.js` | Frontend logic (login, catalog, sale, returns, inventory, adjustments, reports, users) |
