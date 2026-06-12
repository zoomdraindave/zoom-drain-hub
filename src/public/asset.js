/**
 * Zoom Drain — Asset QR Page
 * Client-side logic for /asset/:id
 *
 * Views: loading → unregistered → otp-phone → otp-code → register → registered
 * All API calls go to /asset/:id/* endpoints.
 * Session management is handled via an httpOnly cookie set by the server.
 */

(function () {
  const appEl   = document.getElementById('app');
  const assetId = appEl.dataset.assetId;
  const schedulingEnabled = appEl.dataset.schedulingConfigured === 'true';

  // ── State ────────────────────────────────────────────────────────────────────

  const state = {
    view:     'loading',  // loading | unregistered | otp-phone | otp-code | register | registered
    phone:    '',
    asset:    null,
    history:  [],
  };

  // ── Bootstrap ────────────────────────────────────────────────────────────────

  async function init() {
    try {
      const res  = await fetch(`/asset/${assetId}/data`);
      const data = await res.json();

      if (data.registered) {
        state.view    = 'registered';
        state.asset   = data.asset;
        state.history = data.history || [];
      } else if (data.canRegister) {
        state.view = 'register';
      } else {
        state.view = 'unregistered';
      }
    } catch {
      state.view = 'error';
    }
    render();
  }

  // ── Render dispatcher ────────────────────────────────────────────────────────

  function render() {
    switch (state.view) {
      case 'loading':     renderLoading();     break;
      case 'unregistered':renderUnregistered();break;
      case 'otp-phone':   renderOtpPhone();    break;
      case 'otp-code':    renderOtpCode();     break;
      case 'register':    renderRegisterForm();break;
      case 'registered':  renderRegistered();  break;
      default:
        setHtml(`
          ${header()}
          <main class="page-content">
            <div class="card">
              <div class="alert alert-error">Something went wrong loading this page.</div>
            </div>
          </main>`);
    }
  }

  // ── Shared header ────────────────────────────────────────────────────────────

  function header() {
    return `
      <header class="page-header">
        <img src="/zoom-drain-logo.png" alt="Zoom Drain" class="logo">
      </header>`;
  }

  function assetBadge(showPill = false) {
    return `
      <div class="asset-badge">
        <span class="asset-label">Equipment</span>
        <span class="asset-number">#${esc(assetId)}</span>
        ${showPill ? '<span class="registered-pill">✓ Registered</span>' : ''}
      </div>`;
  }

  // ── Views ────────────────────────────────────────────────────────────────────

  function renderLoading() {
    setHtml(`<div class="page-loading"><div class="spinner"></div></div>`);
  }

  function renderUnregistered() {
    setHtml(`
      ${header()}
      <main class="page-content">
        ${assetBadge()}
        <div class="status-card">
          <div class="status-icon">🔧</div>
          <h1 class="status-title">Not Registered</h1>
          <p class="status-desc">This equipment has not been linked to a service record yet.</p>
        </div>
        <div class="card">
          <p class="card-hint">Are you a Zoom Drain technician? Register this equipment to start tracking service history.</p>
          <button class="btn btn-primary btn-full" id="start-register-btn">
            Register This Equipment
          </button>
        </div>
      </main>`);

    on('start-register-btn', 'click', () => {
      state.view = 'otp-phone';
      render();
    });
  }

  function renderOtpPhone() {
    setHtml(`
      ${header()}
      <main class="page-content">
        ${assetBadge()}
        <div class="card">
          <h2 class="card-title">Verify Your Identity</h2>
          <p class="card-hint">Enter your Zoom Drain phone number. We'll send a 6-digit verification code.</p>
          <div id="msg"></div>
          <form id="otp-phone-form">
            <div class="form-group">
              <label for="phone-input">Phone Number</label>
              <input type="tel" id="phone-input" placeholder="(602) 555-0100"
                     autocomplete="tel" inputmode="tel" required>
            </div>
            <button type="submit" class="btn btn-primary btn-full" id="send-btn">
              Send Code
            </button>
          </form>
          <button class="btn btn-ghost btn-full" id="cancel-btn">Cancel</button>
        </div>
      </main>`);

    on('cancel-btn', 'click', () => { state.view = 'unregistered'; render(); });

    document.getElementById('otp-phone-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const phone = document.getElementById('phone-input').value.trim();
      const btn   = document.getElementById('send-btn');
      clearMsg();
      setLoading(btn, 'Sending…');

      const res = await post(`/asset/${assetId}/request-otp`, { phone });
      if (res.ok) {
        state.phone = phone;
        state.view  = 'otp-code';
        render();
      } else {
        showMsg(res.data?.error || 'Failed to send code. Try again.', 'error');
        resetBtn(btn, 'Send Code');
      }
    });
  }

  function renderOtpCode() {
    setHtml(`
      ${header()}
      <main class="page-content">
        ${assetBadge()}
        <div class="card">
          <h2 class="card-title">Enter Verification Code</h2>
          <p class="card-hint">A 6-digit code was sent to <strong>${esc(state.phone)}</strong>. It expires in 10 minutes.</p>
          <div id="msg"></div>
          <form id="otp-code-form">
            <div class="form-group">
              <label for="otp-input">Verification Code</label>
              <input type="text" id="otp-input" placeholder="000000"
                     maxlength="6" inputmode="numeric" pattern="[0-9]{6}"
                     autocomplete="one-time-code" required>
            </div>
            <button type="submit" class="btn btn-primary btn-full" id="verify-btn">
              Verify
            </button>
          </form>
          <button class="btn btn-ghost btn-full" id="back-btn">← Use a different number</button>
        </div>
      </main>`);

    // Auto-focus the OTP field for fast entry
    setTimeout(() => document.getElementById('otp-input')?.focus(), 50);

    on('back-btn', 'click', () => { state.view = 'otp-phone'; render(); });

    document.getElementById('otp-code-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const otp = document.getElementById('otp-input').value.trim();
      const btn = document.getElementById('verify-btn');
      clearMsg();
      setLoading(btn, 'Verifying…');

      const res = await post(`/asset/${assetId}/verify-otp`, { phone: state.phone, otp });
      if (res.ok) {
        state.view = 'register';
        render();
      } else {
        showMsg(res.data?.error || 'Invalid or expired code.', 'error');
        resetBtn(btn, 'Verify');
      }
    });
  }

  const ASSET_TYPES = [
    'HGI',
    'GGI',
    'RO Filtration System',
    'Garbage Disposal',
    'Water Softener',
    'Water Heater',
    'Other',
  ];

  function renderRegisterForm() {
    setHtml(`
      ${header()}
      <main class="page-content">
        ${assetBadge()}
        <div class="card">
          <h2 class="card-title">Register Equipment</h2>
          <p class="card-hint">Link this QR code to a customer's equipment record in Service Titan.</p>
          <div id="msg"></div>
          <form id="register-form" autocomplete="off">

            <div class="form-group">
              <label for="asset-type-select">Equipment Type <span class="required">*</span></label>
              <select id="asset-type-select" required>
                <option value="">Select type…</option>
                ${ASSET_TYPES.map(t => `<option value="${esc(t)}">${esc(t)}</option>`).join('')}
              </select>
            </div>

            <div class="form-group">
              <label for="customer-input">Customer <span class="required">*</span></label>
              <div class="autocomplete-wrapper">
                <input type="text" id="customer-input"
                       placeholder="Start typing customer name…"
                       autocomplete="off" spellcheck="false">
                <div id="customer-dropdown" class="autocomplete-dropdown hidden"></div>
              </div>
              <input type="hidden" id="customer-id">
              <input type="hidden" id="customer-name-h">
              <input type="hidden" id="customer-phone-h">
              <input type="hidden" id="customer-email-h">
            </div>

            <div class="form-group hidden" id="location-group">
              <label for="location-select">Service Location</label>
              <select id="location-select">
                <option value="">Select location…</option>
              </select>
              <input type="hidden" id="location-id">
              <input type="hidden" id="location-address-h">
              <input type="hidden" id="location-name-h">
            </div>

            <div class="form-group">
              <label for="notes-input">Notes <span class="optional">(optional)</span></label>
              <textarea id="notes-input"
                        placeholder="e.g., Main kitchen grease trap, rear of building"
                        rows="3"></textarea>
            </div>

            <button type="submit" class="btn btn-primary btn-full" id="register-btn">
              Register Equipment
            </button>
          </form>
        </div>
      </main>`);

    initAutocomplete();
    initLocationSelect();

    document.getElementById('register-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      await submitRegistration();
    });
  }

  // ── Autocomplete ─────────────────────────────────────────────────────────────

  let acTimer = null;

  function initAutocomplete() {
    const input    = document.getElementById('customer-input');
    const dropdown = document.getElementById('customer-dropdown');

    input.addEventListener('input', () => {
      clearTimeout(acTimer);
      const q = input.value.trim();
      if (q.length < 2) { dropdown.classList.add('hidden'); return; }
      acTimer = setTimeout(() => fetchCustomers(q), 300);
    });

    // Hide dropdown on blur (delay so click on item fires first)
    input.addEventListener('blur', () => {
      setTimeout(() => dropdown.classList.add('hidden'), 200);
    });
  }

  async function fetchCustomers(q) {
    const dropdown = document.getElementById('customer-dropdown');
    try {
      const res  = await fetch(`/asset/${assetId}/customers?q=${encodeURIComponent(q)}`);
      const data = await res.json();
      const list = data.customers || [];

      if (!list.length) {
        dropdown.innerHTML = `<div class="dropdown-empty">No matches found</div>`;
      } else {
        dropdown.innerHTML = list.map(c => `
          <div class="dropdown-item"
               tabindex="0"
               data-id="${esc(c.id)}"
               data-name="${esc(c.name)}"
               data-phone="${esc(c.phone || '')}"
               data-email="${esc(c.email || '')}">
            <div class="dropdown-name">${esc(c.name)}</div>
            ${c.phone ? `<div class="dropdown-sub">${esc(c.phone)}</div>` : ''}
          </div>`).join('');

        dropdown.querySelectorAll('.dropdown-item[data-id]').forEach(item => {
          item.addEventListener('mousedown', () => selectCustomer(item));
        });
      }
      dropdown.classList.remove('hidden');
    } catch {
      dropdown.classList.add('hidden');
    }
  }

  function selectCustomer(item) {
    document.getElementById('customer-input').value   = item.dataset.name;
    document.getElementById('customer-id').value      = item.dataset.id;
    document.getElementById('customer-name-h').value  = item.dataset.name;
    document.getElementById('customer-phone-h').value = item.dataset.phone || '';
    document.getElementById('customer-email-h').value = item.dataset.email || '';
    document.getElementById('customer-dropdown').classList.add('hidden');
    loadLocations(item.dataset.id);
  }

  async function loadLocations(customerId) {
    const group  = document.getElementById('location-group');
    const select = document.getElementById('location-select');
    try {
      const res   = await fetch(`/asset/${assetId}/locations/${encodeURIComponent(customerId)}`);
      const data  = await res.json();
      const locs  = data.locations || [];

      if (!locs.length) { group.classList.add('hidden'); return; }

      select.innerHTML = `<option value="">Select location…</option>` +
        locs.map(l => `
          <option value="${esc(l.id)}"
                  data-address="${esc(l.address)}"
                  data-lname="${esc(l.name)}">
            ${esc(l.name || l.address)}
          </option>`).join('');

      // Auto-select if only one location
      if (locs.length === 1) {
        select.selectedIndex = 1;
        select.dispatchEvent(new Event('change'));
      }

      group.classList.remove('hidden');
    } catch {
      group.classList.add('hidden');
    }
  }

  function initLocationSelect() {
    document.getElementById('location-select')?.addEventListener('change', function () {
      const opt = this.options[this.selectedIndex];
      document.getElementById('location-id').value       = this.value;
      document.getElementById('location-address-h').value = opt.dataset.address || '';
      document.getElementById('location-name-h').value   = opt.dataset.lname    || '';
    });
  }

  async function submitRegistration() {
    const customerId = document.getElementById('customer-id').value;
    if (!customerId) {
      showMsg('Please select a customer from the list.', 'error');
      return;
    }

    const btn = document.getElementById('register-btn');
    clearMsg();
    setLoading(btn, 'Registering…');

    const payload = {
      asset_type:       document.getElementById('asset-type-select').value,
      notes:            document.getElementById('notes-input').value,
      customer_id:      customerId,
      customer_name:    document.getElementById('customer-name-h').value,
      customer_phone:   document.getElementById('customer-phone-h').value,
      customer_email:   document.getElementById('customer-email-h').value,
      location_id:      document.getElementById('location-id').value,
      location_address: document.getElementById('location-address-h').value,
      location_name:    document.getElementById('location-name-h').value,
    };

    const res = await post(`/asset/${assetId}/register`, payload);
    if (res.ok) {
      // Reload so the server re-evaluates state and shows the registered view
      window.location.reload();
    } else {
      showMsg(res.data?.error || 'Registration failed. Please try again.', 'error');
      resetBtn(btn, 'Register Equipment');
    }
  }

  // ── Registered view ──────────────────────────────────────────────────────────

  function renderRegistered() {
    const a = state.asset;

    const historyRows = state.history.length
      ? state.history.map(h => `
          <tr>
            <td>${esc(h.date)}</td>
            <td>${esc(h.type)}</td>
            <td>${esc(h.technician)}</td>
            <td>${esc(h.notes)}</td>
            <td>${h.invoice ? `<span class="invoice-badge">${esc(h.invoice)}</span>` : '—'}</td>
          </tr>`).join('')
      : `<tr><td colspan="5" class="table-empty">No service records on file yet.</td></tr>`;

    const bookBtn = schedulingEnabled
      ? `<button class="btn btn-primary btn-full st-booking-show" id="book-btn">Schedule Service</button>`
      : `<a href="tel:${esc(appEl.dataset.phone || '')}" class="btn btn-primary btn-full" id="book-btn">Call to Schedule</a>`;

    setHtml(`
      ${header()}
      <main class="page-content">
        ${assetBadge(true)}

        <div class="card asset-info-card">
          <div class="info-row">
            <span class="info-label">Type</span>
            <span class="info-value"><span class="type-badge">${esc(a.asset_type || '—')}</span></span>
          </div>
          <div class="info-row">
            <span class="info-label">Customer</span>
            <span class="info-value">${esc(a.customer_name || '—')}</span>
          </div>
          ${a.location_name || a.location_address ? `
          <div class="info-row">
            <span class="info-label">Location</span>
            <span class="info-value">${esc(a.location_name || a.location_address)}</span>
          </div>` : ''}
          ${a.location_address ? `
          <div class="info-row">
            <span class="info-label">Address</span>
            <span class="info-value">${esc(a.location_address)}</span>
          </div>` : ''}
          ${a.notes ? `
          <div class="info-row">
            <span class="info-label">Notes</span>
            <span class="info-value">${esc(a.notes)}</span>
          </div>` : ''}
          <div class="info-row">
            <span class="info-label">Since</span>
            <span class="info-value">${fmtDate(a.registered_at)}</span>
          </div>
        </div>

        <section class="section">
          <div class="section-header">
            <h2 class="section-title">Service History</h2>
            <button class="refresh-btn" id="refresh-history-btn" title="Refresh">↻ Refresh</button>
          </div>
          <div class="table-wrapper" id="history-wrapper">
            <table class="service-table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Service</th>
                  <th>Tech</th>
                  <th>Notes</th>
                  <th>Invoice</th>
                </tr>
              </thead>
              <tbody id="history-tbody">${historyRows}</tbody>
            </table>
          </div>
        </section>

        <div class="book-card">
          <h2 class="section-title">Request Service</h2>
          <p class="section-desc">Need service on this equipment? Schedule online — we'll bring the right tools.</p>
          ${bookBtn}
        </div>
      </main>`);

    on('refresh-history-btn', 'click', refreshHistory);
  }

  async function refreshHistory() {
    const btn  = document.getElementById('refresh-history-btn');
    const body = document.getElementById('history-tbody');
    if (!btn || !body) return;
    btn.disabled    = true;
    btn.textContent = '…';
    try {
      const res  = await fetch(`/asset/${assetId}/data`);
      const data = await res.json();
      state.history = data.history || [];

      const rows = state.history.length
        ? state.history.map(h => `
            <tr>
              <td>${esc(h.date)}</td>
              <td>${esc(h.type)}</td>
              <td>${esc(h.technician)}</td>
              <td>${esc(h.notes)}</td>
              <td>${h.invoice ? `<span class="invoice-badge">${esc(h.invoice)}</span>` : '—'}</td>
            </tr>`).join('')
        : `<tr><td colspan="5" class="table-empty">No service records on file yet.</td></tr>`;

      body.innerHTML = rows;
    } catch { /* silent */ }
    btn.disabled    = false;
    btn.textContent = '↻ Refresh';
  }

  // ── Helpers ──────────────────────────────────────────────────────────────────

  function setHtml(html) { appEl.innerHTML = html; }

  function on(id, event, handler) {
    document.getElementById(id)?.addEventListener(event, handler);
  }

  function showMsg(text, type = 'error') {
    const el = document.getElementById('msg');
    if (el) el.innerHTML = `<div class="alert alert-${type}">${esc(text)}</div>`;
  }

  function clearMsg() {
    const el = document.getElementById('msg');
    if (el) el.innerHTML = '';
  }

  function setLoading(btn, label) {
    btn.disabled     = true;
    btn.textContent  = label;
  }

  function resetBtn(btn, label) {
    btn.disabled     = false;
    btn.textContent  = label;
  }

  async function post(url, body) {
    try {
      const res  = await fetch(url, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      return { ok: res.ok, status: res.status, data };
    } catch {
      return { ok: false, status: 0, data: { error: 'Network error. Please try again.' } };
    }
  }

  // Safe HTML escaping — always use this before inserting user-supplied strings
  function esc(str) {
    if (str == null) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function fmtDate(iso) {
    if (!iso) return '—';
    try {
      return new Date(iso).toLocaleDateString('en-US', {
        year: 'numeric', month: 'short', day: 'numeric',
      });
    } catch { return iso; }
  }

  // ── Start ────────────────────────────────────────────────────────────────────
  init();
})();
