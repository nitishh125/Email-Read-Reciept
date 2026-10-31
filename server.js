const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

const app = express();
const PORT = process.env.PORT || 3000;

// Initialize SQLite database
const dbPath = path.join(__dirname, 'emails.db');
const db = new DatabaseSync(dbPath);

// Enable WAL mode and foreign keys
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

// Create tables
db.exec(`
  CREATE TABLE IF NOT EXISTS tracked_emails (
    id TEXT PRIMARY KEY,
    recipient TEXT NOT NULL,
    subject TEXT DEFAULT '',
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS email_opens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email_id TEXT NOT NULL,
    timestamp TEXT NOT NULL,
    user_agent TEXT DEFAULT '',
    ip_address TEXT DEFAULT '',
    FOREIGN KEY(email_id) REFERENCES tracked_emails(id) ON DELETE CASCADE
  );
`);

// Prepared statements for high performance
const stmtGetAllEmails = db.prepare('SELECT * FROM tracked_emails ORDER BY datetime(created_at) DESC');
const stmtGetAllOpens = db.prepare('SELECT * FROM email_opens ORDER BY datetime(timestamp) ASC');
const stmtGetEmailById = db.prepare('SELECT * FROM tracked_emails WHERE id = ?');
const stmtInsertEmail = db.prepare(`
  INSERT INTO tracked_emails (id, recipient, subject, created_at)
  VALUES (?, ?, ?, ?)
`);
const stmtInsertOpen = db.prepare(`
  INSERT INTO email_opens (email_id, timestamp, user_agent, ip_address)
  VALUES (?, ?, ?, ?)
`);
const stmtDeleteOpens = db.prepare('DELETE FROM email_opens');
const stmtDeleteEmails = db.prepare('DELETE FROM tracked_emails');

// 1x1 transparent PNG
const PIXEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64'
);

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

/**
 * Detect if the incoming pixel request is coming from an email client's
 * compose window (e.g. pasting into Gmail's 'Insert photo -> Web Address (URL)'),
 * a link previewer, or a HEAD request.
 */
function isComposeOrPreviewRequest(req, email) {
  // 1. HEAD requests are metadata checks (e.g. checking image dimensions), not actual views
  if (req.method === 'HEAD') {
    return true;
  }

  // 2. Check Referer header for mail client compose web applications
  const referer = (req.get('referer') || req.get('referrer') || '').toLowerCase();
  const composeDomains = [
    'mail.google.com',
    'mail.yahoo.com',
    'outlook.live.com',
    'outlook.office.com',
    'outlook.office365.com',
    'mail.aol.com',
    'mail.com',
    'zoho.com',
    'proton.me',
    'protonmail.com',
    'icloud.com',
    'web.whatsapp.com',
    'slack.com',
    'teams.microsoft.com',
    'discord.com',
  ];
  if (composeDomains.some((domain) => referer.includes(domain))) {
    return true;
  }

  // 3. Check prefetch/preview headers sent by browsers or mail clients
  const purpose = (req.get('purpose') || '').toLowerCase();
  const xPurpose = (req.get('x-purpose') || '').toLowerCase();
  const secPurpose = (req.get('sec-purpose') || '').toLowerCase();
  if (['prefetch', 'preview'].some((p) => purpose.includes(p) || xPurpose.includes(p) || secPurpose.includes(p))) {
    return true;
  }

  // 4. Check Google Image Proxy or webmail proxies during the compose/creation window
  const userAgent = (req.get('user-agent') || '').toLowerCase();
  const proxyKeywords = ['via ggpht.com', 'googleimageproxy', 'google-proxy', 'yahoomailproxy'];
  const isProxy = proxyKeywords.some((k) => userAgent.includes(k));

  if (email && isProxy) {
    const createdAt = new Date(email.created_at).getTime();
    const timeSinceCreation = (Date.now() - createdAt) / 1000;
    // If proxy request occurs within 60 seconds of pixel creation,
    // it is Gmail's compose window previewing/rendering the inserted image URL.
    if (timeSinceCreation < 60) {
      return true;
    }
  }

  return false;
}

// API Routes
app.get('/api/emails', (req, res) => {
  try {
    const emails = stmtGetAllEmails.all();
    const opens = stmtGetAllOpens.all();

    const opensByEmail = {};
    for (const open of opens) {
      if (!opensByEmail[open.email_id]) {
        opensByEmail[open.email_id] = [];
      }
      opensByEmail[open.email_id].push({
        timestamp: open.timestamp,
        userAgent: open.user_agent,
        ip: open.ip_address,
      });
    }

    const payload = emails.map((e) => ({
      id: e.id,
      recipient: e.recipient,
      subject: e.subject || '',
      createdAt: e.created_at,
      opens: opensByEmail[e.id] || [],
    }));

    res.json(payload);
  } catch (err) {
    console.error('Error fetching emails:', err);
    res.status(500).json({ error: 'Failed to fetch emails.' });
  }
});

app.post('/api/emails', (req, res) => {
  try {
    const recipient = (req.body?.recipient || '').trim();
    const subject = (req.body?.subject || '').trim();

    // Basic email validation regex
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!recipient || !emailRegex.test(recipient)) {
      return res.status(400).json({ error: 'Enter a valid recipient email.' });
    }

    const id = crypto.randomUUID();
    const createdAt = new Date().toISOString();

    stmtInsertEmail.run(id, recipient, subject, createdAt);

    res.status(201).json({
      id,
      recipient,
      subject,
      createdAt,
      opens: [],
    });
  } catch (err) {
    console.error('Error creating email:', err);
    res.status(500).json({ error: 'Failed to create email tracking pixel.' });
  }
});

app.delete('/api/emails', (req, res) => {
  try {
    stmtDeleteOpens.run();
    stmtDeleteEmails.run();
    res.status(204).end();
  } catch (err) {
    console.error('Error clearing emails:', err);
    res.status(500).json({ error: 'Failed to clear emails.' });
  }
});

// Tracking Pixel Route (supports both /track/:email_id and /track/:email_id.png)
function handleTrackingPixel(req, res) {
  let emailId = req.params.email_id || '';
  if (emailId.endsWith('.png')) {
    emailId = emailId.slice(0, -4);
  }

  let email = null;
  try {
    email = stmtGetEmailById.get(emailId);
  } catch (err) {
    // Invalid query or UUID
  }

  if (email && !isComposeOrPreviewRequest(req, email)) {
    const userAgent = (req.get('user-agent') || 'unknown').slice(0, 500);
    const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress || '';
    const timestamp = new Date().toISOString();

    try {
      stmtInsertOpen.run(email.id, timestamp, userAgent, ip);
    } catch (err) {
      console.error('Error logging open event:', err);
    }
  }

  // Never cache the pixel — a cached image never triggers a fresh request,
  // which would silently break tracking for repeat opens.
  res.setHeader('Content-Type', 'image/png');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');

  if (req.method === 'HEAD') {
    return res.end();
  }
  return res.end(PIXEL);
}

app.get('/track/:email_id', handleTrackingPixel);
app.head('/track/:email_id', handleTrackingPixel);

// Root route
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start the server
const server = app.listen(PORT, () => {
  console.log(`Email Read Receipt server is running on http://localhost:${PORT}`);
});

module.exports = { app, server };
