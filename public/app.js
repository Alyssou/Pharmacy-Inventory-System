const state = {
  user: null,          // { id, username, fullName, role }
  medicines: [],
  saleLines: [],       // { medicineId, name, quantity, unitPrice }
};


const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

function fmtFCFA(n) {
  return new Intl.NumberFormat('fr-FR').format(n) + ' FCFA';
}

function toast(msg, kind = 'info') {
  const div = document.createElement('div');
  div.className = `toast ${kind}`;
  div.textContent = msg;
  $('#toast-container').appendChild(div);
  setTimeout(() => div.remove(), 3500);
}

// Auth

async function checkSession() {
  const res = await fetch('/api/auth/me');
  if (res.ok) {
    const data = await res.json();
    enterApp(data.user);
  } else {
    showLogin();
  }
}

function showLogin() {
  $('#login-screen').classList.remove('hidden');
  $('#app').classList.add('hidden');
  $('#login-username').value = '';
  $('#login-password').value = '';
  $('#login-error').classList.add('hidden');
  $('#login-username').focus();
}

function enterApp(user) {
  state.user = user;
  $('#login-screen').classList.add('hidden');
  $('#app').classList.remove('hidden');
  $('#user-role-label').textContent = user.role;
  $('#user-name-label').textContent = user.fullName;
  applyRoleUI(user.role);
  if (user.role === 'ADMINISTRATOR') {
    const catalogTab = $('[data-view="catalog"]');
    if (catalogTab) catalogTab.click();
  }
  if (user.role === 'PHARMACIST') {
    populateBatchMedicineSelect();
    initBatchForm();
    populateAdjMedicineSelect();
  }
  loadCatalog();
  loadAlerts();
}

function applyRoleUI(role) {
  // Show elements whose data-roles includes the current role (tabs, panels, etc.).
  $$('[data-roles]').forEach(el => {
    const allowed = el.dataset.roles.split(',');
    el.classList.toggle('hidden', !allowed.includes(role));
  });

  // If the active tab is hidden (e.g. Admin cannot use New Sale), switch to first visible tab.
  const activeTab = $('.tab.active');
  if (activeTab?.classList.contains('hidden')) {
    const firstVisible = $$('.tab').find(t => !t.classList.contains('hidden'));
    if (firstVisible) firstVisible.click();
  }
}

function canInitiateReturn() {
  return ['CASHIER', 'PHARMACIST'].includes(state.user?.role);
}

function canCompleteSale() {
  return ['CASHIER', 'PHARMACIST'].includes(state.user?.role);
}

function canRegisterBatch() {
  return state.user?.role === 'PHARMACIST';
}

function canApplyAdjustment() {
  return state.user?.role === 'PHARMACIST';
}

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const username = $('#login-username').value.trim();
  const password = $('#login-password').value;
  const errEl = $('#login-error');
  errEl.classList.add('hidden');

  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    const data = await res.json();
    if (!data.ok) {
      errEl.textContent = data.error || 'Login failed';
      errEl.classList.remove('hidden');
      return;
    }
    enterApp(data.user);
  } catch (err) {
    errEl.textContent = 'Server unreachable';
    errEl.classList.remove('hidden');
  }
});

$('#logout-btn').addEventListener('click', async () => {
  await fetch('/api/auth/logout', { method: 'POST' });
  state.user = null;
  state.saleLines = [];
  showLogin();
});

// Tab navigation

$$('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    $$('.tab').forEach(t => t.classList.remove('active'));
    $$('.view').forEach(v => v.classList.remove('active'));
    tab.classList.add('active');
    const view = tab.dataset.view;
    $(`#view-${view}`).classList.add('active');
    if (view === 'catalog')     loadCatalog();
    if (view === 'history')     loadHistory();
    if (view === 'ledger')      loadLedger();
    if (view === 'batches')     loadBatches();
    if (view === 'returns')     loadReturns();
    if (view === 'quarantine')  loadQuarantine();
    if (view === 'adjustments') loadAdjustments();
    if (view === 'reports')     loadReports();
    if (view === 'admin')       loadUsers();
  });
});

// Catalog

async function loadCatalog() {
  const res = await fetch('/api/medicines');
  if (res.status === 401) { showLogin(); return; }
  state.medicines = await res.json();
  renderCatalog();
}

function catalogElements() {
  const readOnly = state.user?.role === 'ADMINISTRATOR';
  return {
    search: readOnly ? $('#catalog-search') : $('#sale-catalog-search'),
    list:   readOnly ? $('#catalog-list')   : $('#sale-catalog-list'),
    readOnly
  };
}

function renderCatalog() {
  const { search, list, readOnly } = catalogElements();
  if (!search || !list) return;

  const query = search.value.toLowerCase();
  const filtered = state.medicines.filter(m =>
    m.name.toLowerCase().includes(query) ||
    m.category.toLowerCase().includes(query)
  );
  list.innerHTML = '';
  for (const m of filtered) {
    const row = document.createElement('div');
    row.className = 'med-row' + (readOnly ? ' med-row-readonly' : '');
    if (m.totalAvailable === 0) row.classList.add('out-of-stock');

    const flags = [];
    if (m.prescription_required) flags.push('<span class="flag flag-rx">℞ RX</span>');
    if (m.lowStock)               flags.push('<span class="flag flag-low">LOW</span>');
    if (m.expiringSoon)           flags.push('<span class="flag flag-exp">EXP&lt;30d</span>');

    row.innerHTML = `
      <div>
        <div class="med-name">${m.name}${flags.join('')}</div>
        <div class="med-meta">${m.category} &middot; ${m.manufacturer || '—'} &middot; per ${m.unit_of_measure}</div>
      </div>
      <div class="med-price">${fmtFCFA(m.unit_price)}</div>
      <div class="med-stock">stock: ${m.totalAvailable}</div>
    `;
    if (!readOnly) row.addEventListener('click', () => addToSale(m));
    list.appendChild(row);
  }
  if (filtered.length === 0) {
    list.innerHTML = '<div style="padding:40px 20px;color:var(--ink-muted);text-align:center;">No medicines match your search.</div>';
  }
}

$('#catalog-search').addEventListener('input', renderCatalog);
$('#sale-catalog-search').addEventListener('input', renderCatalog);

// Sale builder

function addToSale(medicine) {
  if (!canCompleteSale()) return;
  if (medicine.totalAvailable === 0) {
    toast(`${medicine.name} is out of stock`, 'error');
    return;
  }
  if (medicine.prescription_required) {
    if (!confirm(`${medicine.name} requires a prescription. Continue?`)) return;
  }

  const existing = state.saleLines.find(l => l.medicineId === medicine.id);
  if (existing) {
    if (existing.quantity + 1 > medicine.totalAvailable) {
      toast(`Only ${medicine.totalAvailable} units of ${medicine.name} available`, 'error');
      return;
    }
    existing.quantity++;
  } else {
    state.saleLines.push({
      medicineId: medicine.id,
      name: medicine.name,
      unitPrice: medicine.unit_price,
      quantity: 1
    });
  }
  renderSaleLines();
}

function renderSaleLines() {
  const container = $('#sale-lines');
  container.innerHTML = '';
  if (state.saleLines.length === 0) {
    container.classList.add('empty');
    container.innerHTML = '<p class="empty-msg">Click a medicine to add it to the sale.</p>';
    $('#confirm-sale').disabled = true;
    $('#sale-total').textContent = '0 FCFA';
    $('#sale-line-count').textContent = '0 lines';
    return;
  }
  container.classList.remove('empty');

  let total = 0;
  state.saleLines.forEach((line, idx) => {
    const lineTotal = line.unitPrice * line.quantity;
    total += lineTotal;
    const div = document.createElement('div');
    div.className = 'sale-line';
    div.innerHTML = `
      <div class="sale-line-info">
        <div class="sale-line-name">${line.name}</div>
        <div class="sale-line-batch">${fmtFCFA(line.unitPrice)} per unit</div>
      </div>
      <div class="sale-line-controls">
        <button class="qty-btn" data-action="dec" data-idx="${idx}">−</button>
        <span class="qty-display">${line.quantity}</span>
        <button class="qty-btn" data-action="inc" data-idx="${idx}">+</button>
        <span class="line-total">${fmtFCFA(lineTotal)}</span>
        <button class="remove-line" data-action="del" data-idx="${idx}">×</button>
      </div>
    `;
    container.appendChild(div);
  });

  $('#sale-total').textContent = fmtFCFA(total);
  $('#sale-line-count').textContent = `${state.saleLines.length} line${state.saleLines.length > 1 ? 's' : ''}`;
  $('#confirm-sale').disabled = false;
}

$('#sale-lines').addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  const idx    = parseInt(btn.dataset.idx, 10);
  const action = btn.dataset.action;
  if (action === 'inc') {
    const line     = state.saleLines[idx];
    const medicine = state.medicines.find(m => m.id === line.medicineId);
    if (line.quantity + 1 > medicine.totalAvailable) {
      toast(`Only ${medicine.totalAvailable} units available`, 'error');
      return;
    }
    line.quantity++;
  } else if (action === 'dec') {
    state.saleLines[idx].quantity--;
    if (state.saleLines[idx].quantity <= 0) state.saleLines.splice(idx, 1);
  } else if (action === 'del') {
    state.saleLines.splice(idx, 1);
  }
  renderSaleLines();
});

// Complete sale

$('#confirm-sale').addEventListener('click', async () => {
  if (!canCompleteSale()) {
    toast('Administrators cannot complete sales', 'error');
    return;
  }
  const payload = {
    lines: state.saleLines.map(l => ({ medicineId: l.medicineId, quantity: l.quantity }))
  };
  try {
    const res  = await fetch('/api/sales', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (res.status === 401) { showLogin(); return; }
    const data = await res.json();
    if (!data.ok) { toast(data.error, 'error'); return; }
    showReceipt(data.sale, data.lines);
    state.saleLines = [];
    renderSaleLines();
    await loadCatalog();
    toast(`Sale ${data.sale.id} completed`, 'success');
  } catch (err) {
    toast(`Sale failed: ${err.message}`, 'error');
  }
});

function showReceipt(sale, lines) {
  const html = `
    <div class="receipt-id">${sale.id} &middot; ${new Date(sale.timestamp).toLocaleString()}</div>
    ${lines.map(l => `
      <div class="receipt-line">
        <div>
          <div class="receipt-line-name">${l.medicineName}</div>
          <div class="receipt-line-batch">from batch ${l.batchNumber} (FEFO)</div>
        </div>
        <div class="receipt-line-qty">${l.quantity} × ${fmtFCFA(l.unitPriceAtSale)}</div>
        <div class="receipt-line-total">${fmtFCFA(l.lineTotal)}</div>
      </div>
    `).join('')}
    <div class="receipt-total">
      <span>Total</span>
      <span>${fmtFCFA(sale.totalAmount)}</span>
    </div>
  `;
  $('#receipt-content').innerHTML = html;
  $('#receipt-modal').classList.remove('hidden');
}

$('#close-receipt').addEventListener('click', () => {
  $('#receipt-modal').classList.add('hidden');
});


// History view

async function loadHistory() {
  const res = await fetch('/api/sales');
  if (res.status === 401) { showLogin(); return; }
  const sales = await res.json();
  const list  = $('#history-list');
  if (sales.length === 0) {
    list.innerHTML = '<div style="padding:40px 20px;color:var(--ink-muted);text-align:center;">No sales recorded yet.</div>';
    return;
  }

  const canReturn = canInitiateReturn();
  const now = Date.now();

  list.innerHTML = sales.map(s => {
    const ageHours  = (now - new Date(s.timestamp).getTime()) / 36e5;
    const withinWindow = ageHours <= 24;
    const returnBtn = canReturn && withinWindow
      ? `<button class="btn-return" data-sale-id="${s.id}">↩ Return</button>`
      : '';
    return `
      <div class="history-row">
        <div class="history-head">
          <div style="display:flex;align-items:center;gap:10px">
            <span class="history-id">${s.id}</span>
            ${returnBtn}
          </div>
          <span class="history-total">${fmtFCFA(s.total_amount)}</span>
        </div>
        <div class="history-meta">${new Date(s.timestamp).toLocaleString()} &middot; ${s.cashier_name}</div>
        <div class="history-lines">
          ${s.lines.map(l => `
            <div class="history-line">
              <span>${l.medicine_name} × ${l.quantity}</span>
              <span class="history-line-batch">batch ${l.batch_number} · expires ${l.expiry_date}</span>
            </div>
          `).join('')}
        </div>
      </div>`;
  }).join('');
}

$('#history-list').addEventListener('click', (e) => {
  const btn = e.target.closest('.btn-return');
  if (!btn) return;
  navigateToReturn(btn.dataset.saleId);
});

$('#refresh-history').addEventListener('click', loadHistory);

// Ledger view

async function loadLedger() {
  const res = await fetch('/api/movements');
  if (res.status === 401) { showLogin(); return; }
  const movements = await res.json();
  const list = $('#ledger-list');
  const header = `
    <div class="ledger-row header">
      <div>Timestamp</div>
      <div>Type</div>
      <div>Medicine / Batch</div>
      <div class="delta">Delta</div>
      <div>User</div>
    </div>
  `;
  if (movements.length === 0) {
    list.innerHTML = header + '<div style="padding:40px 20px;color:var(--ink-muted);text-align:center;">No movements recorded.</div>';
    return;
  }
  list.innerHTML = header + movements.map(m => `
    <div class="ledger-row">
      <div>${new Date(m.timestamp).toLocaleString()}</div>
      <div><span class="ledger-type ${m.type}">${m.type}</span></div>
      <div>${m.medicine_name} &middot; <span style="color:var(--ink-muted)">${m.batch_number}</span></div>
      <div class="delta ${m.quantity_delta < 0 ? 'negative' : 'positive'}">${m.quantity_delta > 0 ? '+' : ''}${m.quantity_delta}</div>
      <div>${m.user_name}</div>
    </div>
  `).join('');
}

$('#refresh-ledger').addEventListener('click', loadLedger);

// Returns — initiation 

function navigateToReturn(saleId) {
  if (!canInitiateReturn()) return;
  $$('.tab').forEach(t => t.classList.remove('active'));
  $$('.view').forEach(v => v.classList.remove('active'));
  const tab = $('[data-view="returns"]');
  if (tab) tab.classList.add('active');
  $('#view-returns').classList.add('active');
  $('#return-sale-id').value = saleId;
  loadSaleForReturn(saleId);
  loadReturns();
}

async function loadSaleForReturn(saleId) {
  const errEl = $('#return-load-error');
  errEl.classList.add('hidden');
  $('#return-sale-summary').classList.add('hidden');

  if (!saleId) return;
  const res = await fetch(`/api/sales/${encodeURIComponent(saleId)}`);
  if (res.status === 401) { showLogin(); return; }
  const data = await res.json();

  if (!data.ok) {
    errEl.textContent = data.error;
    errEl.classList.remove('hidden');
    return;
  }

  const { sale, lines } = data;
  const ageHours = (Date.now() - new Date(sale.timestamp).getTime()) / 36e5;

  let ageNote = '';
  if (ageHours > 24) {
    ageNote = '<span class="chip chip-danger">OUTSIDE 24h WINDOW — return will be rejected</span>';
  } else if (ageHours > 20) {
    ageNote = `<span class="chip chip-warn">Window closes in ~${Math.round((24 - ageHours) * 60)} min</span>`;
  }

  $('#return-sale-info').innerHTML = `
    <div class="return-sale-meta">
      <span class="mono">${sale.id}</span>
      <span>${new Date(sale.timestamp).toLocaleString()}</span>
      <span>${sale.cashier_name}</span>
      <span class="mono">${fmtFCFA(sale.total_amount)}</span>
    </div>
    ${ageNote}
  `;

  const checksHtml = lines.map(l => {
    const disabled = l.returnable <= 0 ? 'disabled' : '';
    return `
      <div class="return-line-row ${disabled ? 'row-disabled' : ''}">
        <input type="checkbox" class="return-line-check" data-line-id="${l.id}"
               data-max="${l.returnable}" ${disabled}>
        <div class="return-line-info">
          <span class="return-line-name">${l.medicine_name}</span>
          <span class="return-line-detail">
            sold ${l.quantity} · returned ${l.alreadyReturned} · returnable ${l.returnable}
          </span>
        </div>
        <input type="number" class="form-input return-line-qty" data-line-id="${l.id}"
               min="1" max="${l.returnable}" value="${l.returnable}"
               style="width:64px" ${disabled}>
      </div>`;
  }).join('');

  $('#return-line-checks').innerHTML = checksHtml;
  $('#return-error').classList.add('hidden');
  $('#return-notes').value = '';
  $('#return-sale-summary').classList.remove('hidden');
}

$('#return-load-sale').addEventListener('click', () => {
  loadSaleForReturn($('#return-sale-id').value.trim().toUpperCase());
});

$('#return-sale-id').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') loadSaleForReturn($('#return-sale-id').value.trim().toUpperCase());
});

$('#return-submit').addEventListener('click', async () => {
  if (!canInitiateReturn()) {
    toast('Administrators cannot initiate returns', 'error');
    return;
  }
  const errEl = $('#return-error');
  errEl.classList.add('hidden');

  const checks = $$('.return-line-check:checked');
  if (checks.length === 0) {
    errEl.textContent = 'Select at least one item to return.';
    errEl.classList.remove('hidden');
    return;
  }

  const lines = checks.map(cb => {
    const qty = parseInt($(`input.return-line-qty[data-line-id="${cb.dataset.lineId}"]`).value, 10);
    return { saleLineId: cb.dataset.lineId, quantity: qty };
  });

  const invalidQty = lines.find(l => !(l.quantity > 0));
  if (invalidQty) {
    errEl.textContent = 'All return quantities must be positive.';
    errEl.classList.remove('hidden');
    return;
  }

  const payload = {
    saleId:     $('#return-sale-id').value.trim().toUpperCase(),
    lines,
    reasonCode: $('#return-reason').value,
    notes:      $('#return-notes').value.trim() || null
  };

  try {
    const res  = await fetch('/api/returns', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload)
    });
    if (res.status === 401) { showLogin(); return; }
    const data = await res.json();
    if (!data.ok) {
      errEl.textContent = data.error;
      errEl.classList.remove('hidden');
      return;
    }
    toast(`Return ${data.return.id} submitted — awaiting pharmacist authorisation`, 'success');
    $('#return-sale-summary').classList.add('hidden');
    $('#return-sale-id').value = '';
    $('#return-load-error').classList.add('hidden');
    loadReturns();
  } catch (err) {
    errEl.textContent = err.message;
    errEl.classList.remove('hidden');
  }
});

const STATUS_CHIP = {
  PENDING_AUTH: '<span class="chip chip-warn">PENDING AUTH</span>',
  AUTHORIZED:   '<span class="chip chip-ok">AUTHORIZED</span>',
  REJECTED:     '<span class="chip chip-danger">REJECTED</span>'
};

const REASON_LABEL = {
  DISPENSING_ERROR: 'Dispensing error',
  PATIENT_DECLINED: 'Patient declined',
  NEAR_EXPIRY:      'Near expiry',
  OTHER:            'Other'
};

// Default disposition per reason code (pharmacist guidance)
const DEFAULT_DISP = {
  DISPENSING_ERROR: 'RESTOCK',
  PATIENT_DECLINED: 'DISPOSE',
  NEAR_EXPIRY:      'QUARANTINE',
  OTHER:            'DISPOSE'
};

// In-memory cache of loaded returns for the auth modal
state.returns = [];

async function loadReturns() {
  const res = await fetch('/api/returns');
  if (res.status === 401) { showLogin(); return; }
  const returns   = await res.json();
  state.returns   = returns;
  const list      = $('#returns-list');
  const canAuth   = ['PHARMACIST', 'ADMINISTRATOR'].includes(state.user?.role);

  if (returns.length === 0) {
    list.innerHTML = '<div style="padding:40px 20px;color:var(--ink-muted);text-align:center;">No return requests yet.</div>';
    return;
  }

  list.innerHTML = returns.map(r => {
    const authBtn = canAuth && r.status === 'PENDING_AUTH'
      ? `<button class="btn-auth-open" data-return-id="${r.id}">Review &amp; Authorise</button>`
      : '';
    const pharmaLine = r.pharmacist_name
      ? `<span>&middot; ${r.status === 'AUTHORIZED' ? 'authorised' : 'rejected'} by ${r.pharmacist_name}</span>`
      : '';
    return `
      <div class="return-row">
        <div class="return-head">
          <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
            <span class="mono" style="font-size:12px">${r.id}</span>
            ${STATUS_CHIP[r.status] || ''}
            ${authBtn}
          </div>
          <span class="mono" style="font-size:12px">${fmtFCFA(r.lines.reduce((s,l) => s + l.quantity * l.unit_price, 0))}</span>
        </div>
        <div class="return-meta">
          Sale <span class="mono">${r.sale_id}</span>
          &middot; ${new Date(r.initiated_at).toLocaleString()}
          &middot; ${r.cashier_name}
          &middot; ${REASON_LABEL[r.reason_code] || r.reason_code}
          ${pharmaLine}
        </div>
        <div class="return-lines-detail">
          ${r.lines.map(l => {
            const dispChip = l.disposition
              ? `<span class="chip chip-muted" style="font-size:9px">${l.disposition}</span>`
              : '';
            return `<span class="return-detail-line">${l.medicine_name} × ${l.quantity} ${dispChip}</span>`;
          }).join('')}
        </div>
        ${r.notes ? `<div class="return-notes-text">"${r.notes}"</div>` : ''}
      </div>`;
  }).join('');
}

$('#refresh-returns').addEventListener('click', loadReturns);

// Return authorisation modal 

$('#returns-list').addEventListener('click', (e) => {
  const btn = e.target.closest('.btn-auth-open');
  if (!btn) return;
  openAuthModal(btn.dataset.returnId);
});

function openAuthModal(returnId) {
  const ret = state.returns.find(r => r.id === returnId);
  if (!ret) return;

  $('#auth-modal-id').textContent = returnId;
  $('#auth-error').classList.add('hidden');

  const defaultDisp = DEFAULT_DISP[ret.reason_code] || 'DISPOSE';

  const linesHtml = ret.lines.map(l => `
    <div class="auth-line-row">
      <div class="auth-line-info">
        <span class="auth-line-name">${l.medicine_name}</span>
        <span class="auth-line-detail">qty ${l.quantity} &middot; batch ${l.batch_number} &middot; ${fmtFCFA(l.unit_price)} /unit</span>
      </div>
      <div class="auth-disp-group" data-line-id="${l.id}">
        ${['RESTOCK','QUARANTINE','DISPOSE'].map(d => `
          <label class="auth-disp-opt ${d === defaultDisp ? 'selected' : ''}">
            <input type="radio" name="disp-${l.id}" value="${d}" ${d === defaultDisp ? 'checked' : ''}>
            ${d}
          </label>`).join('')}
      </div>
    </div>`).join('');

  $('#auth-modal-body').innerHTML = `
    <div class="auth-summary">
      <div><span class="auth-label">Sale</span><span class="mono">${ret.sale_id}</span></div>
      <div><span class="auth-label">Reason</span>${REASON_LABEL[ret.reason_code]}</div>
      <div><span class="auth-label">Initiated</span>${new Date(ret.initiated_at).toLocaleString()} by ${ret.cashier_name}</div>
      ${ret.notes ? `<div><span class="auth-label">Notes</span><em>${ret.notes}</em></div>` : ''}
    </div>
    <div class="auth-lines-header">
      <span>Item</span><span>Disposition</span>
    </div>
    ${linesHtml}`;

  $('#auth-modal-body').querySelectorAll('input[type=radio]').forEach(radio => {
    radio.addEventListener('change', () => {
      radio.closest('.auth-disp-group').querySelectorAll('.auth-disp-opt').forEach(l => l.classList.remove('selected'));
      radio.closest('.auth-disp-opt').classList.add('selected');
    });
  });

  $('#auth-modal').dataset.returnId = returnId;
  $('#auth-modal').classList.remove('hidden');
}

$('#close-auth-modal').addEventListener('click', () => $('#auth-modal').classList.add('hidden'));

async function submitAuthorization(decision) {
  const returnId  = $('#auth-modal').dataset.returnId;
  const ret       = state.returns.find(r => r.id === returnId);
  const errEl     = $('#auth-error');
  errEl.classList.add('hidden');

  let dispositions = [];
  if (decision === 'AUTHORIZED') {
    dispositions = ret.lines.map(l => {
      const checked = $('#auth-modal-body').querySelector(`input[name="disp-${l.id}"]:checked`);
      return { returnLineId: l.id, disposition: checked ? checked.value : 'DISPOSE' };
    });
  }

  try {
    const res = await fetch(`/api/returns/${encodeURIComponent(returnId)}/authorize`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ decision, dispositions })
    });
    if (res.status === 401) { showLogin(); return; }
    const data = await res.json();
    if (!data.ok) {
      errEl.textContent = data.error;
      errEl.classList.remove('hidden');
      return;
    }
    $('#auth-modal').classList.add('hidden');
    const verb = decision === 'AUTHORIZED' ? 'authorised' : 'rejected';
    toast(`Return ${returnId} ${verb}`, decision === 'AUTHORIZED' ? 'success' : 'info');
    loadReturns();
    loadCatalog(); // stock may have changed
  } catch (err) {
    errEl.textContent = err.message;
    errEl.classList.remove('hidden');
  }
}

$('#auth-authorize-btn').addEventListener('click', () => submitAuthorization('AUTHORIZED'));
$('#auth-reject-btn').addEventListener('click',    () => submitAuthorization('REJECTED'));

// Quarantine resolution 

async function loadQuarantine() {
  const res = await fetch('/api/quarantine');
  if (res.status === 401) { showLogin(); return; }
  if (res.status === 403) return;
  const items = await res.json();
  renderQuarantineList(items);
}

function renderQuarantineList(items) {
  const list = $('#quarantine-list');

  if (items.length === 0) {
    list.innerHTML = '<div style="padding:40px 20px;color:var(--ink-muted);text-align:center;">No items currently in quarantine.</div>';
    return;
  }

  const header = `
    <div class="quar-row header">
      <div>Medicine / Batch</div>
      <div>Return</div>
      <div>Reason</div>
      <div>Quarantined</div>
      <div class="num">Qty</div>
      <div>Actions</div>
    </div>`;

  const rows = items.map(item => {
    const canRelease = item.reason_code === 'DISPENSING_ERROR';
    const releaseBtn = canRelease
      ? `<button class="btn-quar-release" data-id="${item.return_line_id}">Release to Stock</button>`
      : `<button class="btn-quar-release" disabled title="BR13: only DISPENSING_ERROR returns may be released">Release</button>`;

    return `
      <div class="quar-row">
        <div>
          <div class="quar-medicine">${item.medicine_name}</div>
          <div class="quar-batch mono">batch ${item.batch_number} · exp ${item.expiry_date}</div>
        </div>
        <div class="mono" style="font-size:11px">${item.return_id}</div>
        <div>
          <span class="chip ${item.reason_code === 'DISPENSING_ERROR' ? 'chip-info' : 'chip-warn'}"
                style="font-size:9px">${REASON_LABEL[item.reason_code] || item.reason_code}</span>
        </div>
        <div class="mono" style="font-size:11px">${new Date(item.authorized_at).toLocaleString()}</div>
        <div class="num mono">${item.quantity}</div>
        <div class="quar-actions">
          ${releaseBtn}
          <button class="btn-quar-dispose" data-id="${item.return_line_id}">Dispose</button>
        </div>
      </div>`;
  }).join('');

  list.innerHTML = header + rows;
}

async function resolveQuarantine(returnLineId, resolution) {
  try {
    const res = await fetch(`/api/quarantine/${encodeURIComponent(returnLineId)}/resolve`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ resolution })
    });
    if (res.status === 401) { showLogin(); return; }
    const data = await res.json();
    if (!data.ok) { toast(data.error, 'error'); return; }
    const verb = resolution === 'RELEASE' ? 'released to stock' : 'disposed';
    toast(`Item ${verb}`, 'success');
    loadQuarantine();
    loadCatalog();       // stock may have changed
  } catch (err) {
    toast(err.message, 'error');
  }
}

$('#quarantine-list').addEventListener('click', (e) => {
  const releaseBtn = e.target.closest('.btn-quar-release');
  const disposeBtn = e.target.closest('.btn-quar-dispose');
  if (releaseBtn && !releaseBtn.disabled) {
    if (confirm('Release these items back to available stock?')) {
      resolveQuarantine(releaseBtn.dataset.id, 'RELEASE');
    }
  } else if (disposeBtn) {
    if (confirm('Permanently dispose of these quarantined items? This cannot be undone.')) {
      resolveQuarantine(disposeBtn.dataset.id, 'DISPOSE');
    }
  }
});

$('#refresh-quarantine').addEventListener('click', loadQuarantine);

// Batch registration 

async function loadBatches() {
  const res = await fetch('/api/batches');
  if (res.status === 401) { showLogin(); return; }
  if (res.status === 403) return;
  const batches = await res.json();
  renderBatchList(batches);
}

function renderBatchList(batches) {
  const list  = $('#batch-list');
  const today = new Date().toISOString().split('T')[0];

  if (batches.length === 0) {
    list.innerHTML = '<div style="padding:40px 20px;color:var(--ink-muted);text-align:center;">No batches registered yet.</div>';
    return;
  }

  const header = `
    <div class="batch-row header">
      <div>Medicine</div>
      <div>Batch #</div>
      <div>Supplier</div>
      <div>Expiry</div>
      <div class="num">Rcvd</div>
      <div class="num">Avail</div>
      <div class="num">Quar</div>
      <div>Status</div>
    </div>`;

  const rows = batches.map(b => {
    const daysLeft = (new Date(b.expiry_date) - new Date()) / (1000 * 60 * 60 * 24);
    const expired     = b.expiry_date < today;
    const expireSoon  = !expired && daysLeft <= 30;
    const statusChips = [];
    if (expired)    statusChips.push('<span class="chip chip-danger">EXPIRED</span>');
    if (expireSoon) statusChips.push('<span class="chip chip-warn">EXP&lt;30d</span>');
    if (b.quantity_available === 0 && !expired) statusChips.push('<span class="chip chip-muted">DEPLETED</span>');
    if (b.quantity_quarantine > 0)              statusChips.push('<span class="chip chip-info">QUAR</span>');
    if (statusChips.length === 0)               statusChips.push('<span class="chip chip-ok">OK</span>');

    return `
      <div class="batch-row ${expired ? 'row-expired' : ''}">
        <div class="batch-medicine">${b.medicine_name}</div>
        <div class="mono">${b.batch_number}</div>
        <div class="batch-supplier">${b.supplier_name}</div>
        <div class="mono">${b.expiry_date}</div>
        <div class="num mono">${b.quantity_received}</div>
        <div class="num mono">${b.quantity_available}</div>
        <div class="num mono">${b.quantity_quarantine}</div>
        <div>${statusChips.join('')}</div>
      </div>`;
  }).join('');

  list.innerHTML = header + rows;
}

// Populate medicine dropdown when entering app
async function populateBatchMedicineSelect() {
  const res = await fetch('/api/medicines');
  if (!res.ok) return;
  const meds = await res.json();
  const sel  = $('#batch-medicine');
  sel.innerHTML = '<option value="">— select medicine —</option>' +
    meds.map(m => `<option value="${m.id}">${m.name}</option>`).join('');
}

// Default intake date to today when form is first shown
function initBatchForm() {
  $('#batch-intake').value = new Date().toISOString().split('T')[0];
  $('#batch-number').value = '';
  $('#batch-supplier').value = '';
  $('#batch-expiry').value = '';
  $('#batch-qty').value = '';
  $('#batch-error').classList.add('hidden');
}

$('#batch-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!canRegisterBatch()) {
    toast('Administrators cannot register batches', 'error');
    return;
  }
  const errEl = $('#batch-error');
  errEl.classList.add('hidden');

  const payload = {
    medicineId:       $('#batch-medicine').value,
    batchNumber:      $('#batch-number').value.trim(),
    supplierName:     $('#batch-supplier').value.trim(),
    intakeDate:       $('#batch-intake').value,
    expiryDate:       $('#batch-expiry').value,
    quantityReceived: $('#batch-qty').value
  };

  if (!payload.medicineId) {
    errEl.textContent = 'Please select a medicine.';
    errEl.classList.remove('hidden');
    return;
  }

  try {
    const res  = await fetch('/api/batches', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload)
    });
    if (res.status === 401) { showLogin(); return; }
    const data = await res.json();
    if (!data.ok) {
      errEl.textContent = data.error;
      errEl.classList.remove('hidden');
      return;
    }
    toast(`Batch ${data.batch.batchNumber} registered`, 'success');
    initBatchForm();
    loadBatches();
    loadCatalog(); // refresh stock counts in catalog
  } catch (err) {
    errEl.textContent = err.message;
    errEl.classList.remove('hidden');
  }
});

$('#refresh-batches').addEventListener('click', loadBatches);

// Admin panel — user management 

const ROLE_CHIP = {
  ADMINISTRATOR: 'chip chip-danger',
  PHARMACIST:    'chip chip-info',
  CASHIER:       'chip chip-ok',
};

async function loadUsers() {
  const res = await fetch('/api/users');
  if (res.status === 401) { showLogin(); return; }
  if (res.status === 403) return;
  renderUserList(await res.json());
}

function renderUserList(users) {
  const list = $('#user-list');
  if (users.length === 0) {
    list.innerHTML = '<div style="padding:40px;color:var(--ink-muted)">No users found.</div>';
    return;
  }

  const header = `
    <div class="user-row user-row-header">
      <div>Name</div><div>Username</div><div>Role</div><div>Status</div><div>Actions</div>
    </div>`;

  const rows = users.map(u => {
    const isSelf = u.id === state.user?.id;
    const toggleLabel = u.active ? 'Deactivate' : 'Activate';
    const toggleStyle = u.active ? '' : 'color:var(--accent)';
    const toggleDisabled = isSelf && u.active ? 'disabled title="Cannot deactivate your own account"' : '';
    return `
      <div class="user-row ${!u.active ? 'row-expired' : ''}">
        <div class="user-fullname">
          ${u.full_name}
          ${isSelf ? '<span class="chip chip-muted" style="font-size:9px;margin-left:4px">YOU</span>' : ''}
        </div>
        <div class="mono" style="font-size:12px">${u.username}</div>
        <div><span class="${ROLE_CHIP[u.role] || 'chip chip-muted'}">${u.role}</span></div>
        <div><span class="chip ${u.active ? 'chip-ok' : 'chip-muted'}">${u.active ? 'ACTIVE' : 'INACTIVE'}</span></div>
        <div class="user-actions">
          <button class="btn-secondary btn-user-toggle" data-id="${u.id}" data-active="${u.active ? 0 : 1}"
                  style="font-size:11px;${toggleStyle}" ${toggleDisabled}>${toggleLabel}</button>
          <button class="btn-secondary btn-user-pw" data-id="${u.id}" data-name="${u.full_name}"
                  style="font-size:11px">Reset PW</button>
        </div>
      </div>`;
  }).join('');

  list.innerHTML = header + rows;
}

$('#user-list').addEventListener('click', async (e) => {
  const toggleBtn = e.target.closest('.btn-user-toggle');
  const pwBtn     = e.target.closest('.btn-user-pw');

  if (toggleBtn && !toggleBtn.disabled) {
    const active = parseInt(toggleBtn.dataset.active, 10);
    const verb   = active ? 'Activate' : 'Deactivate';
    if (!confirm(`${verb} this user?`)) return;
    const res  = await fetch(`/api/users/${encodeURIComponent(toggleBtn.dataset.id)}`, {
      method:  'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ active })
    });
    if (res.status === 401) { showLogin(); return; }
    const data = await res.json();
    if (!data.ok) { toast(data.error, 'error'); return; }
    toast(`User ${active ? 'activated' : 'deactivated'}`, 'success');
    loadUsers();
  }

  if (pwBtn) {
    const newPw = prompt(`New password for ${pwBtn.dataset.name}:`);
    if (!newPw || !newPw.trim()) return;
    const res  = await fetch(`/api/users/${encodeURIComponent(pwBtn.dataset.id)}`, {
      method:  'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ newPassword: newPw.trim() })
    });
    if (res.status === 401) { showLogin(); return; }
    const data = await res.json();
    if (!data.ok) { toast(data.error, 'error'); return; }
    toast('Password updated', 'success');
  }
});

$('#refresh-users').addEventListener('click', loadUsers);

$('#user-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const errEl = $('#user-error');
  errEl.classList.add('hidden');

  const payload = {
    username: $('#user-username').value.trim(),
    fullName: $('#user-fullname').value.trim(),
    password: $('#user-password').value,
    role:     $('#user-role').value,
  };

  if (!payload.username || !payload.fullName || !payload.password) {
    errEl.textContent = 'All fields are required.';
    errEl.classList.remove('hidden');
    return;
  }

  try {
    const res  = await fetch('/api/users', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload)
    });
    if (res.status === 401) { showLogin(); return; }
    const data = await res.json();
    if (!data.ok) {
      errEl.textContent = data.error;
      errEl.classList.remove('hidden');
      return;
    }
    toast(`User "${data.user.username}" created (${data.user.role})`, 'success');
    e.target.reset();
    loadUsers();
  } catch (err) {
    errEl.textContent = err.message;
    errEl.classList.remove('hidden');
  }
});


// Reports


function updateReportFilterVisibility() {
  const type = $('#report-type').value;
  $('#report-date-range').classList.toggle('hidden', type === 'STOCK_VALUATION' || type === 'EXPIRY');
  $('#report-type-filter').classList.toggle('hidden', type !== 'MOVEMENTS');
}

function initReportDates() {
  if ($('#report-to').value) return; // already set
  const to   = new Date().toISOString().split('T')[0];
  const from = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
  $('#report-from').value = from;
  $('#report-to').value   = to;
}

async function loadReports() {
  initReportDates();
  updateReportFilterVisibility();
  $('#report-output').innerHTML =
    '<div style="padding:48px 20px;color:var(--ink-muted);text-align:center;">Select a report type and click <strong>Run Report</strong>.</div>';
}

async function runReport() {
  const type    = $('#report-type').value;
  const from    = $('#report-from').value;
  const to      = $('#report-to').value;
  const movType = $('#report-mov-type').value;
  const output  = $('#report-output');
  output.innerHTML = '<div style="padding:32px 20px;color:var(--ink-muted)">Loading…</div>';

  const urls = {
    SALES:           `/api/reports/sales?from=${from}&to=${to}`,
    STOCK_VALUATION: `/api/reports/stock-valuation`,
    EXPIRY:          `/api/reports/expiry`,
    MOVEMENTS:       `/api/reports/movements?from=${from}&to=${to}&type=${movType}`,
  };

  try {
    const res = await fetch(urls[type]);
    if (res.status === 401) { showLogin(); return; }
    if (res.status === 403) {
      output.innerHTML = '<div style="padding:32px;color:var(--danger)">Access denied.</div>';
      return;
    }
    const data = await res.json();
    ({ SALES: renderSalesReport, STOCK_VALUATION: renderValuationReport,
       EXPIRY: renderExpiryReport, MOVEMENTS: renderMovementsReport })[type](data, output);
  } catch (err) {
    output.innerHTML = `<div style="padding:32px;color:var(--danger)">${err.message}</div>`;
  }
}

function renderSalesReport({ summary, byMedicine, from, to }, output) {
  if (summary.sale_count === 0) {
    output.innerHTML = `<div style="padding:40px 20px;color:var(--ink-muted);text-align:center;">No sales found for ${from} – ${to}.</div>`;
    return;
  }
  output.innerHTML = `
    <div class="report-summary-bar">
      <div class="report-kpi"><span class="report-kpi-val">${summary.sale_count}</span><span class="report-kpi-lbl">Sales</span></div>
      <div class="report-kpi"><span class="report-kpi-val">${fmtFCFA(summary.total_revenue)}</span><span class="report-kpi-lbl">Total Revenue</span></div>
      <div class="report-kpi"><span class="report-kpi-val">${fmtFCFA(summary.total_revenue / summary.sale_count)}</span><span class="report-kpi-lbl">Avg per Sale</span></div>
    </div>
    <div class="report-section-title">Breakdown by Medicine &middot; ${from} to ${to}</div>
    <div class="report-table report-table-sales">
      <div class="report-row report-header">
        <div>Medicine</div><div>Category</div>
        <div class="num">Units Sold</div><div class="num">Revenue</div>
      </div>
      ${byMedicine.map(r => `
        <div class="report-row">
          <div>${r.medicine_name}</div>
          <div class="report-cat">${r.category}</div>
          <div class="num mono">${r.units_sold}</div>
          <div class="num mono">${fmtFCFA(r.revenue)}</div>
        </div>`).join('')}
      <div class="report-row report-total">
        <div>Total</div><div></div>
        <div class="num mono">${byMedicine.reduce((s,r) => s + r.units_sold, 0)}</div>
        <div class="num mono">${fmtFCFA(summary.total_revenue)}</div>
      </div>
    </div>`;
}

function renderValuationReport({ rows, totalSellable, asOf }, output) {
  output.innerHTML = `
    <div class="report-summary-bar">
      <div class="report-kpi"><span class="report-kpi-val">${fmtFCFA(totalSellable)}</span><span class="report-kpi-lbl">Sellable Value</span></div>
      <div class="report-kpi"><span class="report-kpi-val">${rows.reduce((s,r) => s + r.available, 0)}</span><span class="report-kpi-lbl">Units Available</span></div>
      <div class="report-kpi"><span class="report-kpi-val">${rows.filter(r => r.available === 0).length}</span><span class="report-kpi-lbl">Out of Stock</span></div>
    </div>
    <div class="report-section-title">Stock Valuation as of ${asOf}</div>
    <div class="report-table report-table-valuation">
      <div class="report-row report-header">
        <div>Medicine</div><div>Category</div>
        <div class="num">Available</div><div class="num">Quarantine</div>
        <div class="num">Unit Price</div><div class="num">Sellable Value</div>
      </div>
      ${rows.map(r => `
        <div class="report-row ${r.available === 0 ? 'row-expired' : ''}">
          <div>${r.name}</div>
          <div class="report-cat">${r.category}</div>
          <div class="num mono">${r.available}</div>
          <div class="num mono">${r.quarantine > 0 ? r.quarantine : '—'}</div>
          <div class="num mono">${fmtFCFA(r.unit_price)}</div>
          <div class="num mono">${fmtFCFA(r.sellable_value)}</div>
        </div>`).join('')}
      <div class="report-row report-total">
        <div>Total</div><div></div>
        <div class="num mono">${rows.reduce((s,r) => s + r.available, 0)}</div>
        <div></div><div></div>
        <div class="num mono">${fmtFCFA(totalSellable)}</div>
      </div>
    </div>`;
}

function renderExpiryReport({ rows, asOf }, output) {
  const CHIP = { EXPIRED: 'chip chip-danger', EXPIRING_SOON: 'chip chip-warn', OK: 'chip chip-ok' };
  const LBL  = { EXPIRED: 'EXPIRED', EXPIRING_SOON: 'EXP <30d', OK: 'OK' };
  const today = new Date();
  const counts = { EXPIRED: 0, EXPIRING_SOON: 0, OK: 0 };
  rows.forEach(r => counts[r.status]++);

  output.innerHTML = `
    <div class="report-summary-bar">
      <div class="report-kpi"><span class="report-kpi-val" style="color:var(--danger)">${counts.EXPIRED}</span><span class="report-kpi-lbl">Expired</span></div>
      <div class="report-kpi"><span class="report-kpi-val" style="color:var(--warn)">${counts.EXPIRING_SOON}</span><span class="report-kpi-lbl">Expiring &lt;30d</span></div>
      <div class="report-kpi"><span class="report-kpi-val" style="color:var(--accent)">${counts.OK}</span><span class="report-kpi-lbl">OK</span></div>
    </div>
    <div class="report-section-title">Batch Expiry Status as of ${asOf}</div>
    <div class="report-table report-table-expiry">
      <div class="report-row report-header">
        <div>Medicine</div><div>Batch #</div><div>Expiry Date</div>
        <div class="num">Days Left</div>
        <div class="num">Available</div><div class="num">Quarantine</div>
        <div>Status</div>
      </div>
      ${rows.map(b => {
        const days = Math.ceil((new Date(b.expiry_date) - today) / (1000 * 60 * 60 * 24));
        return `
          <div class="report-row">
            <div>${b.medicine_name}</div>
            <div class="mono">${b.batch_number}</div>
            <div class="mono">${b.expiry_date}</div>
            <div class="num mono ${days < 0 ? 'negative' : ''}">${days}</div>
            <div class="num mono">${b.quantity_available}</div>
            <div class="num mono">${b.quantity_quarantine > 0 ? b.quantity_quarantine : '—'}</div>
            <div><span class="${CHIP[b.status]}">${LBL[b.status]}</span></div>
          </div>`;
      }).join('')}
    </div>`;
}

function renderMovementsReport({ rows, from, to, type }, output) {
  if (rows.length === 0) {
    output.innerHTML = '<div style="padding:40px 20px;color:var(--ink-muted);text-align:center;">No movements found for the selected filters.</div>';
    return;
  }
  const netDelta = rows.reduce((s, r) => s + r.quantity_delta, 0);
  const subtitle = `${from || 'all time'} to ${to || 'now'}${type !== 'ALL' ? ' · ' + type : ''}`;

  output.innerHTML = `
    <div class="report-summary-bar">
      <div class="report-kpi"><span class="report-kpi-val">${rows.length}</span><span class="report-kpi-lbl">Movements</span></div>
      <div class="report-kpi"><span class="report-kpi-val ${netDelta >= 0 ? '' : 'negative'}">${netDelta > 0 ? '+' : ''}${netDelta}</span><span class="report-kpi-lbl">Net Delta</span></div>
    </div>
    <div class="report-section-title">Stock Movements &middot; ${subtitle}</div>
    <div class="report-table report-table-movements">
      <div class="report-row report-header">
        <div>Timestamp</div><div>Type</div>
        <div>Medicine / Batch</div>
        <div class="num">Delta</div><div>User</div><div>Reason</div>
      </div>
      ${rows.map(m => `
        <div class="report-row">
          <div class="mono" style="font-size:11px">${new Date(m.timestamp).toLocaleString()}</div>
          <div><span class="ledger-type ${m.type}">${m.type}</span></div>
          <div>${m.medicine_name} <span style="color:var(--ink-muted);font-size:11px">&middot; ${m.batch_number}</span></div>
          <div class="num mono delta ${m.quantity_delta < 0 ? 'negative' : 'positive'}">${m.quantity_delta > 0 ? '+' : ''}${m.quantity_delta}</div>
          <div style="font-size:12px">${m.user_name}</div>
          <div style="font-size:11px;color:var(--ink-muted)">${m.reason_code || '—'}</div>
        </div>`).join('')}
    </div>`;
}

$('#report-type').addEventListener('change', updateReportFilterVisibility);
$('#run-report').addEventListener('click', runReport);

// Inventory alerts ( low-stock + expiring soon)

async function loadAlerts() {
  const res = await fetch('/api/alerts');
  if (!res.ok) return;
  const { lowStock, expiringSoon } = await res.json();
  const strip = $('#alert-strip');

  if (lowStock.length === 0 && expiringSoon.length === 0) {
    strip.classList.add('hidden');
    return;
  }

  const total = lowStock.length + expiringSoon.length;
  $('#alert-strip-count').innerHTML =
    `<strong>${total} inventory alert${total > 1 ? 's' : ''}</strong>` +
    (lowStock.length     ? ` &middot; ${lowStock.length} low-stock`    : '') +
    (expiringSoon.length ? ` &middot; ${expiringSoon.length} expiring soon` : '');

  const today = new Date();

  $('#alert-low-stock').innerHTML = lowStock.length === 0 ? '' : `
    <div class="alert-section-title">Low Stock</div>
    ${lowStock.map(m => `
      <div class="alert-item">
        <span class="alert-item-name">${m.name}</span>
        <span class="alert-item-meta">${m.total_available} available &middot; threshold ${m.low_stock_threshold}</span>
      </div>`).join('')}`;

  $('#alert-expiring').innerHTML = expiringSoon.length === 0 ? '' : `
    <div class="alert-section-title">Expiring &lt; 30 days</div>
    ${expiringSoon.map(b => {
      const days = Math.ceil((new Date(b.expiry_date) - today) / (1000 * 60 * 60 * 24));
      return `
      <div class="alert-item">
        <span class="alert-item-name">${b.medicine_name}</span>
        <span class="alert-item-meta">batch ${b.batch_number} &middot; exp ${b.expiry_date} (${days}d) &middot; ${b.quantity_available} units</span>
      </div>`;
    }).join('')}`;

  strip.classList.remove('hidden');
}

$('#alert-toggle').addEventListener('click', () => {
  const detail = $('#alert-detail');
  const isHidden = detail.classList.toggle('hidden');
  $('#alert-toggle').textContent = isHidden ? 'Show details ▾' : 'Hide details ▴';
});


// Stock adjustments (Pharmacist only)


let adjBatches = [];

async function populateAdjMedicineSelect() {
  const res = await fetch('/api/medicines');
  if (!res.ok) return;
  const meds = await res.json();
  const sel  = $('#adj-medicine');
  sel.innerHTML = '<option value="">— select medicine —</option>' +
    meds.map(m => `<option value="${m.id}">${m.name}</option>`).join('');
}

$('#adj-medicine').addEventListener('change', async () => {
  const medId   = $('#adj-medicine').value;
  const batchSel = $('#adj-batch');
  adjBatches = [];
  $('#adj-preview').classList.add('hidden');
  batchSel.disabled = true;

  if (!medId) {
    batchSel.innerHTML = '<option value="">— select medicine first —</option>';
    return;
  }

  batchSel.innerHTML = '<option value="">— loading… —</option>';
  const res = await fetch(`/api/medicines/${encodeURIComponent(medId)}/batches`);
  if (!res.ok) {
    batchSel.innerHTML = '<option value="">— error loading batches —</option>';
    return;
  }
  adjBatches = await res.json();

  const today      = new Date().toISOString().split('T')[0];
  const nonExpired = adjBatches.filter(b => b.expiry_date >= today);

  if (nonExpired.length === 0) {
    batchSel.innerHTML = '<option value="">— no active batches —</option>';
    return;
  }

  batchSel.innerHTML = '<option value="">— select batch —</option>' +
    nonExpired.map(b =>
      `<option value="${b.id}">${b.batch_number} · avail: ${b.quantity_available}</option>`
    ).join('');
  batchSel.disabled = false;
});

function updateAdjPreview() {
  const batchId = $('#adj-batch').value;
  if (!batchId) { $('#adj-preview').classList.add('hidden'); return; }

  const batch = adjBatches.find(b => b.id === batchId);
  if (!batch) return;

  const current = batch.quantity_available;
  const qty     = parseInt($('#adj-qty').value, 10) || 0;
  const dir     = document.querySelector('input[name="adj-dir"]:checked')?.value || 'INCREASE';
  const after   = dir === 'INCREASE' ? current + qty : current - qty;

  $('#adj-current-qty').textContent = current;
  $('#adj-new-qty').textContent     = after;
  $('#adj-new-qty').style.color     = after < 0
    ? 'var(--danger)'
    : after < current
    ? 'var(--warn)'
    : 'var(--accent)';
  $('#adj-preview').classList.remove('hidden');
}

$('#adj-batch').addEventListener('change', updateAdjPreview);
$('#adj-qty').addEventListener('input', updateAdjPreview);
$$('input[name="adj-dir"]').forEach(r => r.addEventListener('change', updateAdjPreview));

async function loadAdjustments() {
  const res = await fetch('/api/adjustments');
  if (res.status === 401) { showLogin(); return; }
  if (res.status === 403) return;
  const movements = await res.json();
  const list = $('#adj-history-list');

  const header = `
    <div class="ledger-row header">
      <div>Timestamp</div>
      <div>Type</div>
      <div>Medicine / Batch</div>
      <div class="delta">Delta</div>
      <div>User</div>
    </div>`;

  if (movements.length === 0) {
    list.innerHTML = header + '<div style="padding:40px 20px;color:var(--ink-muted);text-align:center;">No adjustments recorded yet.</div>';
    return;
  }

  list.innerHTML = header + movements.map(m => `
    <div class="ledger-row">
      <div>${new Date(m.timestamp).toLocaleString()}</div>
      <div><span class="ledger-type ADJUSTMENT">ADJUSTMENT</span></div>
      <div>${m.medicine_name} &middot; <span style="color:var(--ink-muted)">${m.batch_number}</span></div>
      <div class="delta ${m.quantity_delta < 0 ? 'negative' : 'positive'}">${m.quantity_delta > 0 ? '+' : ''}${m.quantity_delta}</div>
      <div>${m.user_name}</div>
    </div>
  `).join('');
}

$('#adj-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!canApplyAdjustment()) {
    toast('Administrators cannot apply stock adjustments', 'error');
    return;
  }
  const errEl = $('#adj-error');
  errEl.classList.add('hidden');

  const batchId    = $('#adj-batch').value;
  const qty        = parseInt($('#adj-qty').value, 10);
  const dir        = document.querySelector('input[name="adj-dir"]:checked')?.value || 'INCREASE';
  const reasonCode = $('#adj-reason').value;
  const notes      = $('#adj-notes').value.trim() || null;

  if (!batchId) {
    errEl.textContent = 'Please select a batch.';
    errEl.classList.remove('hidden');
    return;
  }
  if (!qty || qty < 1) {
    errEl.textContent = 'Quantity must be at least 1.';
    errEl.classList.remove('hidden');
    return;
  }

  const delta = dir === 'INCREASE' ? qty : -qty;

  try {
    const res = await fetch('/api/adjustments', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ batchId, delta, reasonCode, notes })
    });
    if (res.status === 401) { showLogin(); return; }
    const data = await res.json();
    if (!data.ok) {
      errEl.textContent = data.error;
      errEl.classList.remove('hidden');
      return;
    }
    toast(`Adjustment applied: ${delta > 0 ? '+' : ''}${delta} units`, 'success');
    $('#adj-medicine').value = '';
    $('#adj-batch').innerHTML = '<option value="">— select medicine first —</option>';
    $('#adj-batch').disabled  = true;
    $('#adj-qty').value       = '';
    $('#adj-notes').value     = '';
    $('#adj-preview').classList.add('hidden');
    adjBatches = [];
    loadAdjustments();
    loadCatalog();
  } catch (err) {
    errEl.textContent = err.message;
    errEl.classList.remove('hidden');
  }
});

$('#refresh-adjustments').addEventListener('click', loadAdjustments);

// Init — check session before rendering anything

checkSession();
