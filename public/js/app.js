const state = { emails: [] };
const previousOpenCounts = {};

const els = {
  statSent: document.getElementById('statSent'),
  statOpened: document.getElementById('statOpened'),
  statRate: document.getElementById('statRate'),
  form: document.getElementById('createForm'),
  recipientInput: document.getElementById('recipient'),
  subjectInput: document.getElementById('subject'),
  formError: document.getElementById('formError'),
  snippetCard: document.getElementById('snippetCard'),
  snippetCode: document.getElementById('snippetCode'),
  copySnippet: document.getElementById('copySnippet'),
  simulateOpen: document.getElementById('simulateOpen'),
  simulateHint: document.getElementById('simulateHint'),
  emptyState: document.getElementById('emptyState'),
  table: document.getElementById('emailTable'),
  tableBody: document.getElementById('emailTableBody'),
  clearAll: document.getElementById('clearAll'),
};

let currentSnippetEmail = null;

function fmtDate(iso) {
  return new Date(iso).toLocaleString(undefined, {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

function timeAgo(iso) {
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.round(diffMs / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  return `${days}d ago`;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function renderStats() {
  const total = state.emails.length;
  const opened = state.emails.filter((e) => e.opens.length > 0).length;
  const rate = total ? Math.round((opened / total) * 100) : 0;
  els.statSent.textContent = total;
  els.statOpened.textContent = opened;
  els.statRate.textContent = `${rate}%`;
}

function rowHtml(email) {
  const opened = email.opens.length > 0;
  const last = opened ? email.opens[email.opens.length - 1] : null;
  const statusHtml = opened
    ? '<span class="pill pill-opened">Opened</span>'
    : '<span class="pill pill-pending">Not opened yet</span>';
  const opensText = opened
    ? `${email.opens.length} &middot; last ${timeAgo(last.timestamp)}`
    : '—';

  return `
    <tr data-id="${email.id}">
      <td data-label="Recipient">${escapeHtml(email.recipient)}</td>
      <td data-label="Note">${escapeHtml(email.subject || '—')}</td>
      <td data-label="Sent">${fmtDate(email.createdAt)}</td>
      <td data-label="Status">${statusHtml}</td>
      <td data-label="Opens">${opensText}</td>
    </tr>
  `;
}

function renderTable(flashIds = new Set()) {
  if (state.emails.length === 0) {
    els.emptyState.hidden = false;
    els.table.hidden = true;
    return;
  }
  els.emptyState.hidden = true;
  els.table.hidden = false;
  els.tableBody.innerHTML = state.emails.map(rowHtml).join('');

  flashIds.forEach((id) => {
    const row = els.tableBody.querySelector(`tr[data-id="${id}"]`);
    if (row) {
      row.classList.remove('just-updated');
      void row.offsetWidth; // restart the animation
      row.classList.add('just-updated');
    }
  });
}

async function loadEmails() {
  try {
    const res = await fetch('/api/emails');
    if (!res.ok) return;
    const emails = await res.json();

    const flashIds = new Set();
    emails.forEach((e) => {
      const prevCount = previousOpenCounts[e.id] ?? 0;
      if (e.opens.length > prevCount) flashIds.add(e.id);
      previousOpenCounts[e.id] = e.opens.length;
    });

    state.emails = emails;
    renderTable(flashIds);
    renderStats();
  } catch (err) {
    console.error('Failed to load emails:', err);
  }
}

els.form.addEventListener('submit', async (e) => {
  e.preventDefault();
  els.formError.hidden = true;

  const recipient = els.recipientInput.value.trim();
  const subject = els.subjectInput.value.trim();

  try {
    const res = await fetch('/api/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ recipient, subject }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Something went wrong.');

    currentSnippetEmail = data;
    await loadEmails();

    const pixelUrl = `${window.location.origin}/track/${data.id}.png`;
    els.snippetCode.textContent = pixelUrl;
    els.snippetCard.hidden = false;
    els.simulateHint.hidden = true;
    els.form.reset();
    els.snippetCard.scrollIntoView({ behavior: 'smooth', block: 'center' });
  } catch (err) {
    els.formError.textContent = err.message;
    els.formError.hidden = false;
  }
});

els.copySnippet.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(els.snippetCode.textContent);
    const original = els.copySnippet.textContent;
    els.copySnippet.textContent = 'Copied!';
    setTimeout(() => { els.copySnippet.textContent = original; }, 1500);
  } catch {
    els.formError.textContent = 'Could not copy automatically — select the snippet text manually.';
    els.formError.hidden = false;
  }
});

els.simulateOpen.addEventListener('click', () => {
  if (!currentSnippetEmail) return;
  // Loading the pixel URL is exactly what a real email client does when
  // it renders the embedded <img> — this just triggers it on demand.
  const pixelUrl = `${window.location.origin}/track/${currentSnippetEmail.id}.png?cb=${Date.now()}`;
  const img = new Image();
  img.src = pixelUrl;
  els.simulateHint.hidden = false;
  setTimeout(loadEmails, 400); // don't make them wait for the next poll tick
});

els.clearAll.addEventListener('click', async () => {
  if (!confirm('Clear all tracked emails? This cannot be undone.')) return;
  await fetch('/api/emails', {
    method: 'DELETE',
  });
  state.emails = [];
  Object.keys(previousOpenCounts).forEach((k) => delete previousOpenCounts[k]);
  renderTable();
  renderStats();
  els.snippetCard.hidden = true;
  currentSnippetEmail = null;
});

loadEmails();
setInterval(loadEmails, 3000);
