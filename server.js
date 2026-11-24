// Neigh-Barks Franchise — static pages + same-page inquiry form.
// The form email path is copied from the neighbarks.com retail server (index.js) so both
// sites send website forms the same way: the shared Gmail account + App Password over
// implicit TLS (smtp.gmail.com:465), From "Neigh-Barks Website <GMAIL_SMTP_USER>",
// Reply-To the visitor, plain-text + HTML body, delivered to franchise@neighbarks.com.
// No third-party packages and no credentials in the browser or committed files.
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const tls = require('node:tls');

// Optional local .env support (same idea as the retail site's dotenv). Render uses dashboard env vars.
try {
  const envPath = path.join(__dirname, '.env');
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
    }
  }
} catch { /* ignore */ }

const ROOT = __dirname;
const PORT = Number(process.env.PORT || 10000);
const MAX_BODY = 24 * 1024; // retail: express.json({ limit: '24kb' })
const BEHIND_RENDER_PROXY = String(process.env.RENDER || '').trim().toLowerCase() === 'true';
const types = {'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.webp':'image/webp','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.svg':'image/svg+xml','.ico':'image/x-icon','.xml':'application/xml; charset=utf-8','.txt':'text/plain; charset=utf-8'};
const PRIVATE_FILES = new Set(['server.js','READ_ME_FIRST.txt','DEVELOPER_SETUP_FORM.txt']); // never serve server code or setup notes
const sendJson = (res, code, obj) => { res.writeHead(code, {'Content-Type':'application/json; charset=utf-8', 'Cache-Control':'no-store'}); res.end(JSON.stringify(obj)); };

// ---------------------------------------------------------------------------
// Gmail SMTP sender — identical to the retail site (index.js).
// ---------------------------------------------------------------------------
function cleanEmailHeaderValue(value, maxLen = 320) {
  return String(value || '').replace(/[\r\n]/g, ' ').trim().slice(0, maxLen);
}

function extractEmailAddress(value) {
  const clean = cleanEmailHeaderValue(value, 320);
  const angle = clean.match(/<([^<>\s]+@[^<>\s]+)>/);
  const candidate = angle ? angle[1] : clean.replace(/^\"|\"$/g, '').trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(candidate) ? candidate : '';
}

function gmailSmtpSettings() {
  return {
    host: cleanEmailHeaderValue(process.env.GMAIL_SMTP_HOST || 'smtp.gmail.com', 200) || 'smtp.gmail.com',
    port: Math.max(1, Math.min(65535, Number.parseInt(process.env.GMAIL_SMTP_PORT || '465', 10) || 465)),
    user: cleanEmailHeaderValue(process.env.GMAIL_SMTP_USER, 320),
    appPassword: String(process.env.GMAIL_SMTP_APP_PASSWORD || '').replace(/\s+/g, '').trim()
  };
}

function escapeEmailHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function smtpBase64Lines(value) {
  const raw = Buffer.from(String(value || ''), 'utf8').toString('base64');
  return raw.match(/.{1,76}/g)?.join('\r\n') || '';
}

function smtpHeader(value) {
  return cleanEmailHeaderValue(value, 500);
}

class SmtpReplyReader {
  constructor(socket) {
    this.socket = socket;
    this.buffer = '';
    this.waiters = [];
    socket.on('data', chunk => {
      this.buffer += chunk.toString('utf8');
      this.pump();
    });
    socket.on('error', error => this.fail(error));
    socket.on('close', () => this.fail(new Error('Gmail SMTP connection closed unexpectedly.')));
  }
  fail(error) {
    while (this.waiters.length) this.waiters.shift().reject(error);
  }
  pump() {
    if (!this.waiters.length) return;
    const lines = this.buffer.split(/\r?\n/);
    if (lines.length < 2) return;
    let endIndex = -1;
    for (let i = 0; i < lines.length - 1; i += 1) {
      if (/^\d{3} /.test(lines[i])) { endIndex = i; break; }
    }
    if (endIndex < 0) return;
    const replyLines = lines.slice(0, endIndex + 1);
    this.buffer = lines.slice(endIndex + 1).join('\r\n');
    const waiter = this.waiters.shift();
    waiter.resolve({ code: Number(replyLines[replyLines.length - 1].slice(0, 3)), text: replyLines.join('\n') });
    this.pump();
  }
  next(timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Gmail SMTP timed out waiting for a response.')), timeoutMs);
      this.waiters.push({
        resolve: value => { clearTimeout(timer); resolve(value); },
        reject: error => { clearTimeout(timer); reject(error); }
      });
      this.pump();
    });
  }
}

async function smtpExpect(reader, expectedCodes, label, timeoutMs) {
  const reply = await reader.next(timeoutMs);
  const allowed = Array.isArray(expectedCodes) ? expectedCodes : [expectedCodes];
  if (!allowed.includes(reply.code)) {
    const detail = cleanEmailHeaderValue(reply.text, 500);
    throw new Error(`${label} failed${detail ? ': ' + detail : '.'}`);
  }
  return reply;
}

async function sendGmailSmtpMessage({ to, from, replyTo, bcc, subject, textBody, htmlBody }, timeoutMs = 20000) {
  const cfg = gmailSmtpSettings();
  const envelopeFrom = extractEmailAddress(from) || cfg.user;
  const bccRecipients = bcc ? bcc.split(',').map(v => extractEmailAddress(v)).filter(Boolean) : [];
  const recipients = [to, ...bccRecipients];
  for (const address of recipients) {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) throw new Error('Invalid email recipient address.');
  }
  const boundary = 'nb_' + crypto.randomBytes(12).toString('hex');
  const headers = [
    `From: ${smtpHeader(from)}`,
    `To: ${smtpHeader(to)}`,
    replyTo ? `Reply-To: ${smtpHeader(replyTo)}` : null,
    `Subject: ${smtpHeader(subject)}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${crypto.randomUUID()}@neighbarks.com>`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`
  ].filter(Boolean);
  const message = [
    ...headers,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    smtpBase64Lines(textBody),
    `--${boundary}`,
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    smtpBase64Lines(htmlBody),
    `--${boundary}--`,
    ''
  ].join('\r\n');

  const socket = tls.connect({ host: cfg.host, port: cfg.port, servername: cfg.host, rejectUnauthorized: true });
  socket.setTimeout(timeoutMs, () => socket.destroy(new Error('Gmail SMTP connection timed out.')));
  const reader = new SmtpReplyReader(socket);
  try {
    await new Promise((resolve, reject) => {
      if (socket.authorized || !socket.connecting) return resolve();
      socket.once('secureConnect', resolve);
      socket.once('error', reject);
    });
    await smtpExpect(reader, 220, 'Gmail SMTP greeting', timeoutMs);
    socket.write('EHLO neighbarks.com\r\n');
    await smtpExpect(reader, 250, 'Gmail SMTP EHLO', timeoutMs);
    socket.write('AUTH LOGIN\r\n');
    await smtpExpect(reader, 334, 'Gmail SMTP authentication', timeoutMs);
    socket.write(Buffer.from(cfg.user, 'utf8').toString('base64') + '\r\n');
    await smtpExpect(reader, 334, 'Gmail SMTP username', timeoutMs);
    socket.write(Buffer.from(cfg.appPassword, 'utf8').toString('base64') + '\r\n');
    await smtpExpect(reader, 235, 'Gmail SMTP App Password', timeoutMs);
    socket.write(`MAIL FROM:<${envelopeFrom}>\r\n`);
    await smtpExpect(reader, 250, 'Gmail SMTP sender', timeoutMs);
    for (const address of recipients) {
      socket.write(`RCPT TO:<${address}>\r\n`);
      await smtpExpect(reader, [250, 251], 'Gmail SMTP recipient', timeoutMs);
    }
    socket.write('DATA\r\n');
    await smtpExpect(reader, 354, 'Gmail SMTP message data', timeoutMs);
    socket.write(message.replace(/\r\n\.\r\n/g, '\r\n..\r\n') + '\r\n.\r\n');
    const accepted = await smtpExpect(reader, 250, 'Gmail SMTP send', timeoutMs);
    socket.write('QUIT\r\n');
    return { accepted: true, response: accepted.text };
  } finally {
    socket.end();
  }
}

// ---------------------------------------------------------------------------
// Public website forms — same helpers, limits and recipient as the retail site.
// ---------------------------------------------------------------------------
const WEBSITE_FORM_RECIPIENTS = Object.freeze({
  franchise: 'franchise@neighbarks.com'
});
const publicFormAttempts = new Map();
function publicFormClean(value, maxLen = 4000) {
  return String(value ?? '').replace(/\0/g, '').replace(/\r\n/g, '\n').trim().slice(0, maxLen);
}
function publicFormEmail(value) {
  const email = publicFormClean(value, 200).toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : '';
}
function clientIp(req) {
  // Retail sets Express "trust proxy" to 1 on Render, so req.ip is the visitor's IP.
  if (BEHIND_RENDER_PROXY) {
    const fwd = String(req.headers['x-forwarded-for'] || '').split(',').map(s => s.trim()).filter(Boolean);
    if (fwd.length) return fwd[fwd.length - 1];
  }
  return String(req.socket?.remoteAddress || 'unknown');
}
function publicFormRateLimited(req) {
  const key = clientIp(req);
  const now = Date.now(), windowMs = 15 * 60 * 1000, max = 8;
  const prior = (publicFormAttempts.get(key) || []).filter(ts => now - ts < windowMs);
  prior.push(now); publicFormAttempts.set(key, prior);
  return prior.length > max;
}
setInterval(() => {
  const cutoff = Date.now() - 15 * 60 * 1000;
  for (const [key, list] of publicFormAttempts) if (!list.some(ts => ts > cutoff)) publicFormAttempts.delete(key);
}, 10 * 60 * 1000).unref();

function websiteFormEmailConfigured() {
  const cfg = gmailSmtpSettings();
  return Boolean(
    cfg.user && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cfg.user) &&
    cfg.appPassword
  );
}

async function sendWebsiteFormEmail({to, replyTo, subject, textBody, htmlBody}) {
  const cfg = gmailSmtpSettings();
  if (!websiteFormEmailConfigured()) {
    throw new Error('Website form email is not configured: GMAIL_SMTP_USER or GMAIL_SMTP_APP_PASSWORD is missing.');
  }
  // Default is the same as retail: send from the authenticated Gmail account.
  // Optional FORM_FROM_EMAIL sends as an alias of that account (e.g. franchise@neighbarks.com).
  // The alias must be listed under Gmail Settings > Accounts > "Send mail as" for the
  // GMAIL_SMTP_USER mailbox, otherwise Gmail replaces it with GMAIL_SMTP_USER.
  const sendAs = extractEmailAddress(process.env.FORM_FROM_EMAIL);
  const fromName = cleanEmailHeaderValue(process.env.FORM_FROM_NAME, 80).replace(/[<>"]/g, '') || 'Neigh-Barks Franchise';
  const from = sendAs ? `${fromName} <${sendAs}>` : `Neigh-Barks Website <${cfg.user}>`;
  return sendGmailSmtpMessage({ to, from, replyTo, bcc: '', subject, textBody, htmlBody });
}

// Franchise inquiry. Field names match this site's contact.html (name, email, phone,
// community, message); the retail site's names (full_name, location, ...) are also accepted.
async function handleFranchiseInquiry(body, req, res) {
  if (publicFormRateLimited(req)) return sendJson(res, 429, {ok:false, error:'Too many messages were sent from this connection. Please try again later.'});
  if (publicFormClean(body?.website, 200)) return sendJson(res, 200, {ok:true}); // honeypot
  const name = publicFormClean(body?.name || body?.full_name, 120);
  const email = publicFormEmail(body?.email);
  const phone = publicFormClean(body?.phone, 80);
  const homeCity = publicFormClean(body?.home_city, 160);
  const location = publicFormClean(body?.community || body?.location, 200);
  const experience = publicFormClean(body?.experience, 3000);
  const why = publicFormClean(body?.why, 3000);
  const notes = publicFormClean(body?.message || body?.notes, 3000);
  if (!name || !email || !location) return sendJson(res, 400, {ok:false, error:'Enter your name, a valid email address and your community of interest.'});

  const to = WEBSITE_FORM_RECIPIENTS.franchise;
  const subject = `[Franchise inquiry] ${name} - ${location}`;
  const extraText = [
    homeCity ? `City/town: ${homeCity}` : null
  ].filter(Boolean);
  const textBody = `Neigh-Barks franchise inquiry\n\nName: ${name}\nEmail: ${email}\nPhone: ${phone || 'Not provided'}\n${extraText.length ? extraText.join('\n') + '\n' : ''}Proposed location: ${location}\n`
    + (experience ? `\nExperience with animals or retail:\n${experience}\n` : '')
    + (why ? `\nWhy Neigh-Barks:\n${why}\n` : '')
    + `\nAbout them / message:\n${notes || 'Not provided'}\n\nSent from the Neigh-Barks franchise website.`;
  const block = (title, value) => `<h3>${title}</h3><p>${escapeEmailHtml(value).replace(/\n/g,'<br>')}</p>`;
  const htmlBody = `<h2>Neigh-Barks franchise inquiry</h2><p><strong>Name:</strong> ${escapeEmailHtml(name)}<br><strong>Email:</strong> ${escapeEmailHtml(email)}<br><strong>Phone:</strong> ${escapeEmailHtml(phone || 'Not provided')}<br>${homeCity ? `<strong>City/town:</strong> ${escapeEmailHtml(homeCity)}<br>` : ''}<strong>Proposed location:</strong> ${escapeEmailHtml(location)}</p>`
    + (experience ? block('Experience with animals or retail', experience) : '')
    + (why ? block('Why Neigh-Barks', why) : '')
    + block('About them / message', notes || 'Not provided')
    + `<p style="color:#777;font-size:12px">Sent from the Neigh-Barks franchise website.</p>`;
  try {
    await sendWebsiteFormEmail({to, replyTo: email, subject, textBody, htmlBody});
    return sendJson(res, 200, {ok:true});
  } catch (error) {
    console.error('FRANCHISE FORM EMAIL FAILED: ' + (error.message || error));
    return sendJson(res, 503, {ok:false, error:'Your inquiry could not be sent right now. Please email franchise@neighbarks.com or call 780-668-3365.'});
  }
}

function post(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) return sendJson(res, 415, {ok:false, error:'Invalid form format.'});
  // Only accept browser submissions from this website. No wildcard CORS.
  if (req.headers.origin) {
    let origin;
    try { origin = new URL(req.headers.origin); } catch { return sendJson(res, 403, {ok:false, error:'Invalid request origin.'}); }
    if (origin.host !== (req.headers.host || '') || !['http:','https:'].includes(origin.protocol)) return sendJson(res, 403, {ok:false, error:'Invalid request origin.'});
  }
  let raw = ''; let exceeded = false;
  req.on('data', ch => { if (exceeded) return; raw += ch; if (Buffer.byteLength(raw) > MAX_BODY) { exceeded = true; sendJson(res, 413, {ok:false, error:'Your message is too long.'}); req.destroy(); } });
  req.on('end', () => {
    if (exceeded) return;
    let body;
    try { body = JSON.parse(raw || '{}'); } catch { return sendJson(res, 400, {ok:false, error:'Please check your form and try again.'}); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return sendJson(res, 400, {ok:false, error:'Please check your form and try again.'});
    handleFranchiseInquiry(body, req, res).catch(err => { console.error('FRANCHISE FORM ERROR: ' + (err.message || err)); if (!res.headersSent) sendJson(res, 500, {ok:false, error:'Your inquiry could not be sent right now.'}); });
  });
}

const server = http.createServer((req, res) => {
  res.setHeader('X-Content-Type-Options','nosniff'); res.setHeader('Referrer-Policy','strict-origin-when-cross-origin'); res.setHeader('X-Frame-Options','SAMEORIGIN');
  const uri = (req.url || '/').split('?')[0];
  if (uri === '/api/franchise-inquiry') { if (req.method === 'POST') return post(req, res); res.setHeader('Allow','POST'); return sendJson(res, 405, {ok:false, error:'Method not allowed.'}); }
  if (uri === '/api/health') return sendJson(res, 200, {ok:true, service:'neigh-barks-franchise', form_email_configured: websiteFormEmailConfigured()});
  if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, {ok:false, error:'Method not allowed.'});
  let parsed;
  try { parsed = decodeURIComponent(uri); } catch { return sendJson(res, 400, {ok:false, error:'Bad URL.'}); }
  if (parsed === '/') parsed = '/index.html';
  const abs = path.resolve(ROOT, '.' + parsed);
  if (!abs.startsWith(ROOT + path.sep) || path.basename(abs).startsWith('.') || PRIVATE_FILES.has(path.basename(abs)) || !types[path.extname(abs)]) { res.writeHead(404); return res.end('Not found'); }
  fs.stat(abs, (err, stat) => {
    if (err || !stat.isFile()) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, {'Content-Type': types[path.extname(abs)], 'Cache-Control': abs.endsWith('.html') ? 'no-cache' : 'public, max-age=86400'});
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(abs).pipe(res);
  });
});
server.listen(PORT, '0.0.0.0', () => console.log('Franchise website listening on port ' + PORT + (websiteFormEmailConfigured() ? ' (form email ready)' : ' (form email NOT configured: set GMAIL_SMTP_USER and GMAIL_SMTP_APP_PASSWORD)')));
