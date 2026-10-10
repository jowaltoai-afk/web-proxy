/**
 * Web Proxy MVP — har session me user apna custom proxy UI se deta hai.
 * Flow:  POST /api/session {protocol,host,port,username,password} -> cookie wp_sid
 *        /go/<encodeURIComponent(targetUrl)>  -> target proxy ke through fetch, rewrite, serve
 *
 * Proxy credentials sirf memory me rehte hain (Map), kabhi log/disk par nahi.
 */
const express = require('express');
const { ProxyAgent } = require('proxy-agent'); // http.Agent style: http+https+socks5 upstream, auth support
const cheerio = require('cheerio');
const { CookieJar } = require('tough-cookie');
const crypto = require('crypto');
const dns = require('dns').promises;
const path = require('path');
const http = require('http');
const https = require('https');
const zlib = require('zlib');

const app = express();
const PORT = process.env.PORT || 8080;
const SESSION_TTL = 45 * 60 * 1000;

app.use(express.json({ limit: '256kb' }));
app.use(express.static(path.join(__dirname, 'public')));

/* ---------------- sessions ---------------- */
const sessions = new Map(); // sid -> { proxyUrl|null, proxyLabel, jar, lastUsed }
setInterval(() => {
  const now = Date.now();
  for (const [sid, s] of sessions) if (now - s.lastUsed > SESSION_TTL) sessions.delete(sid);
}, 5 * 60 * 1000).unref();

function parseCookies(req) {
  const out = {};
  const h = req.headers.cookie || '';
  h.split(';').forEach((p) => {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}
function getSession(req) {
  const sid = parseCookies(req).wp_sid;
  const s = sid && sessions.get(sid);
  if (s) s.lastUsed = Date.now();
  return s || null;
}
function setSidCookie(res, sid) {
  res.setHeader('Set-Cookie', `wp_sid=${sid}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${SESSION_TTL / 1000}`);
}
function clearSidCookie(res) {
  res.setHeader('Set-Cookie', 'wp_sid=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0');
}

/* ---------------- helpers ---------------- */
const relayUrl = (target) => '/go/' + encodeURIComponent(target);

function absolutize(val, base) {
  try {
    const abs = new URL(val, base).href;
    return /^https?:\/\//i.test(abs) ? abs : null;
  } catch { return null; }
}
function rewriteUrlAttr(val, base) {
  if (!val) return val;
  const t = val.trim();
  if (/^(#|javascript:|data:|mailto:|tel:|sms:|blob:|about:)/i.test(t)) return val;
  const abs = absolutize(t, base);
  return abs ? relayUrl(abs) : val;
}
function rewriteSrcset(val, base) {
  return val.split(',').map((part) => {
    const m = part.trim().match(/^(\S+)(\s+.*)?$/);
    if (!m) return part;
    return rewriteUrlAttr(m[1], base) + (m[2] || '');
  }).join(', ');
}
function rewriteCss(css, base) {
  return css
    .replace(/url\(\s*(['"]?)(.*?)\1\s*\)/gi, (m, q, u) => {
      const r = rewriteUrlAttr(u, base);
      return r === u ? m : `url(${q}${r}${q})`;
    })
    .replace(/@import\s+(['"])((?:(?!\1).)+)\1/gi, (m, q, u) => {
      const r = rewriteUrlAttr(u, base);
      return r === u ? m : `@import ${q}${r}${q}`;
    });
}

const HOOK_SCRIPT = `<script>(function(){
function R(u){try{if(!u||typeof u!=='string')return u;var t=u.trim();
if(/^(#|javascript:|data:|mailto:|tel:|sms:|blob:|about:)/i.test(t))return u;
var a=new URL(t,document.baseURI);if(!/^https?:/.test(a.protocol))return u;
if(a.origin===location.origin)return u;return '/go/'+encodeURIComponent(a.href);}catch(e){return u;}}
var _f=window.fetch;window.fetch=function(u,i){if(typeof u==='string'){u=R(u);}else if(u&&u.url){try{u=new Request(R(u.url),u);}catch(e){}}return _f.call(this,u,i);};
var _o=XMLHttpRequest.prototype.open;XMLHttpRequest.prototype.open=function(m,u){arguments[1]=R(u);return _o.apply(this,arguments);};
var _s=EventSource;if(_s){window.EventSource=function(u,c){return new _s(R(u),c);};}
})();</script>`;

const TOOLBAR = `<div id="__wpbar" style="position:fixed;right:12px;bottom:12px;z-index:2147483647;background:#111827ee;border:1px solid #374151;border-radius:12px;padding:8px 10px;display:flex;gap:6px;align-items:center;box-shadow:0 4px 18px #000a;font-family:system-ui,sans-serif;">
<span style="font-size:11px;color:#9ca3af;">proxy</span>
<input id="__wpurl" placeholder="nayi site ka URL" style="width:170px;font-size:12px;padding:5px 8px;border-radius:8px;border:1px solid #374151;background:#1f2937;color:#e5e7eb;outline:none;">
<button onclick="(function(){var v=document.getElementById('__wpurl').value.trim();if(!v)return;if(!/^https?:\\/\\//i.test(v))v='https://'+v;location.href='/go/'+encodeURIComponent(v);})()" style="font-size:12px;padding:5px 10px;border-radius:8px;border:0;background:#2563eb;color:#fff;cursor:pointer;">Kholo</button>
<button onclick="document.getElementById('__wpbar').style.display='none'" title="band karo" style="font-size:12px;padding:5px 8px;border-radius:8px;border:0;background:#374151;color:#d1d5db;cursor:pointer;">×</button>
</div>`;

function rewriteHtml(html, base) {
  const $ = cheerio.load(html, { decodeEntities: false });
  $('base').remove();
  const attrs = [
    ['a', 'href'], ['link', 'href'], ['img', 'src'], ['script', 'src'],
    ['iframe', 'src'], ['embed', 'src'], ['video', 'src'], ['audio', 'src'],
    ['track', 'src'], ['input', 'src'], ['source', 'src'], ['form', 'action'],
    ['button', 'formaction'],
  ];
  for (const [tag, attr] of attrs) {
    $(`${tag}[${attr}]`).each((_, el) => {
      const v = $(el).attr(attr);
      if (v) $(el).attr(attr, rewriteUrlAttr(v, base));
    });
  }
  $('img[srcset], source[srcset]').each((_, el) => {
    const v = $(el).attr('srcset');
    if (v) $(el).attr('srcset', rewriteSrcset(v, base));
  });
  $('[data-src]').each((_, el) => {
    const v = $(el).attr('data-src');
    if (v) $(el).attr('data-src', rewriteUrlAttr(v, base));
  });
  $('[style]').each((_, el) => {
    const v = $(el).attr('style');
    if (v && /url\(/i.test(v)) $(el).attr('style', rewriteCss(v, base));
  });
  $('style').each((_, el) => {
    const v = $(el).html();
    if (v) $(el).html(rewriteCss(v, base));
  });
  $('meta[http-equiv]').each((_, el) => {
    const equiv = ($(el).attr('http-equiv') || '').toLowerCase();
    if (equiv === 'refresh') {
      const c = $(el).attr('content') || '';
      $(el).attr('content', c.replace(/url\s*=\s*(.+)/i, (m, u) => 'url=' + rewriteUrlAttr(u.trim().replace(/^['"]|['"]$/g, ''), base)));
    }
  });
  let out = $.html();
  out = out.replace(/<\/body\s*>/i, HOOK_SCRIPT + TOOLBAR + '</body>');
  if (!/<\/body\s*>/i.test($.html())) out += HOOK_SCRIPT + TOOLBAR;
  return out;
}

/* ---- SSRF guard: sirf direct mode me (proxy mode me proxy resolve karta hai) ---- */
function isPrivateIp(ip) {
  const v4 = ip.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (v4) {
    const n = v4.slice(1).map(Number);
    const x = (((n[0] << 24) >>> 0) | (n[1] << 16) | (n[2] << 8) | n[3]) >>> 0;
    const R = (a, b, c, d, e, f, g, h) => [(((a << 24) >>> 0) | (b << 16) | (c << 8) | d) >>> 0, (((e << 24) >>> 0) | (f << 16) | (g << 8) | h) >>> 0];
    for (const [lo, hi] of [R(10,0,0,0, 10,255,255,255), R(172,16,0,0, 172,31,255,255), R(192,168,0,0, 192,168,255,255), R(127,0,0,0, 127,255,255,255), R(0,0,0,0, 0,255,255,255), R(169,254,0,0, 169,254,255,255), R(224,0,0,0, 239,255,255,255)]) {
      if (x >= lo && x <= hi) return true;
    }
    return false;
  }
  const l = ip.toLowerCase();
  return l === '::1' || l === '::' || l.startsWith('fe80:') || l.startsWith('fc') || l.startsWith('fd') || l.startsWith('::ffff:');
}
async function assertSafeTarget(urlObj) {
  let list;
  try { list = await dns.lookup(urlObj.hostname, { all: true }); }
  catch { throw new Error('Host resolve nahi ho saka.'); }
  for (const { address } of list) if (isPrivateIp(address)) throw new Error('Private/local address block hai.');
}

/* ---- upstream request (proxy chaining via http.Agent) ---- */
function rawRequest(urlStr, { method = 'GET', headers = {}, body = null, agent = null, timeoutMs = 30000 }) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const lib = u.protocol === 'https:' ? https : http;
    let settled = false;
    const req = lib.request(u, { method, headers, agent: agent || undefined }, (res) => {
      settled = true;
      resolve(res); // IncomingMessage (readable)
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')));
    req.on('error', (e) => { if (!settled) reject(e); });
    if (body) req.write(body);
    req.end();
  });
}
function decodedStream(res) {
  const enc = String(res.headers['content-encoding'] || '').toLowerCase();
  if (enc.includes('gzip')) return res.pipe(zlib.createGunzip());
  if (enc.includes('deflate')) return res.pipe(zlib.createInflate());
  if (enc.includes('br')) return res.pipe(zlib.createBrotliDecompress());
  return res;
}
function streamToBuffer(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', (c) => chunks.push(c));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}
async function relayFetch(session, targetUrl, method, inHeaders, body) {
  let url = targetUrl, m = method, b = body;
  for (let i = 0; i < 6; i++) {
    const h = {};
    for (const [k, v] of Object.entries(inHeaders || {})) {
      const lk = k.toLowerCase();
      if (['host', 'connection', 'cookie', 'content-length', 'transfer-encoding', 'upgrade', 'proxy-authorization'].includes(lk)) continue;
      h[k] = v;
    }
    try {
      const cs = await session.jar.getCookieString(url);
      if (cs) h['cookie'] = cs;
    } catch {}
    const res = await rawRequest(url, { method: m, headers: h, body: b, agent: session.agent, timeoutMs: 30000 });
    const setCookies = res.headers['set-cookie'] || [];
    for (const sc of (Array.isArray(setCookies) ? setCookies : [setCookies])) {
      try { await session.jar.setCookie(sc, url); } catch {}
    }
    if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
      const loc = res.headers['location'];
      res.resume(); // discard body
      if (!loc) return { res, finalUrl: url };
      url = new URL(loc, url).href;
      if (!/^https?:\/\//i.test(url)) throw new Error('Ghalat redirect.');
      if ([301, 302, 303].includes(res.statusCode) && m !== 'HEAD') { m = 'GET'; b = null; }
      continue;
    }
    return { res, finalUrl: url };
  }
  throw new Error('Bohat zyada redirects.');
}

/* ---------------- API ---------------- */
const rl = new Map(); // ip -> {count, reset}
function rateOk(ip) {
  const now = Date.now();
  const e = rl.get(ip) || { count: 0, reset: now + 5 * 60 * 1000 };
  if (now > e.reset) { e.count = 0; e.reset = now + 5 * 60 * 1000; }
  e.count++;
  rl.set(ip, e);
  return e.count <= 20;
}

app.get('/api/status', (req, res) => res.json({ ok: true, sessions: sessions.size }));

app.post('/api/session', async (req, res) => {
  try {
    if (!rateOk(req.ip)) return res.status(429).json({ ok: false, error: 'Thora ruk kar dobara try karo.' });
    const { protocol, host, port, username, password, direct } = req.body || {};
    let proxyUrl = null, label = 'direct';
    if (!direct) {
      const p = String(protocol || 'http').toLowerCase();
      if (!['http', 'https', 'socks5'].includes(p)) return res.json({ ok: false, error: 'Protocol HTTP, HTTPS ya SOCKS5 ho.' });
      const h = String(host || '').trim();
      const pt = parseInt(port, 10);
      if (!h) return res.json({ ok: false, error: 'Proxy host likho.' });
      if (!pt || pt < 1 || pt > 65535) return res.json({ ok: false, error: 'Port 1-65535 ke darmiyan ho.' });
      const auth = username ? `${encodeURIComponent(username)}:${encodeURIComponent(password || '')}@` : '';
      // NOTE: SOCKS5 ke liye "socks5h" scheme use karo (proxy-side DNS). socks-proxy-agent me
      // "socks5" ka matlab hai client khud DNS resolve karke IP-literal CONNECT bhejta hai —
      // proxy6 jaise IPv6 proxies IP-literal CONNECT reject/tor dete hain (EPROTO/ConnectionRefused).
      // "socks5h" me domain name proxy ko jata hai aur wo khud resolve karta hai. (verified 2026-10-11)
      const scheme = p === 'socks5' ? 'socks5h' : p;
      proxyUrl = `${scheme}://${auth}${h}:${pt}`;
      label = `${p}://${h}:${pt}`;
    }
    // validate: test request through the chain
    const jar = new CookieJar();
    // NOTE: proxy-agent v6 me string arg ignore ho jata hai (env vars jeet jati hain),
    // is liye getProxyForUrl explicitly dena lazmi hai taake USER ka proxy use ho.
    const agent = proxyUrl ? new ProxyAgent({ getProxyForUrl: () => proxyUrl }) : null;
    try {
      const t = await rawRequest('https://example.com/', { method: 'GET', headers: {}, agent, timeoutMs: 15000 });
      t.resume();
      await new Promise((r) => t.on('end', r));
      if (t.statusCode === 407) throw new Error('Proxy ne auth reject kar di (407) — username/password ghalat hai.');
      if (t.statusCode >= 500) throw new Error('status ' + t.statusCode);
    } catch (e) {
      return res.json({ ok: false, error: 'Proxy se connect nahi ho saka. Host/port/auth check karo. (' + (e.code || e.message || 'timeout') + ')' });
    }
    const sid = crypto.randomUUID();
    sessions.set(sid, { proxyUrl, agent, label, jar, lastUsed: Date.now() });
    setSidCookie(res, sid);
    res.json({ ok: true, via: label });
  } catch (e) {
    res.json({ ok: false, error: 'Server error: ' + e.message });
  }
});

app.post('/api/logout', (req, res) => {
  const sid = parseCookies(req).wp_sid;
  if (sid) sessions.delete(sid);
  clearSidCookie(res);
  res.json({ ok: true });
});

/* ---------------- relay ---------------- */
app.use('/go', express.raw({ type: '*/*', limit: '25mb' }));
app.use('/go', async (req, res) => {
  try {
    const session = getSession(req);
    if (!session) {
      return res.status(401).send(`<body style="background:#111827;color:#e5e7eb;font-family:system-ui;text-align:center;padding:60px;">
        <h2>Session khatam ho gaya hai</h2><p>Wapas ja kar proxy dobara lagao.</p>
        <a href="/" style="color:#60a5fa;">Wapas jao</a></body>`);
    }
    // req.path = remainder after /go (still percent-encoded in req.url)
    const rawPath = (req.url.split('?')[0] || '').replace(/^\//, '');
    const formQs = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
    if (!rawPath) return res.redirect('/');
    let target = decodeURIComponent(rawPath);
    if (!/^https?:\/\//i.test(target)) target = 'https://' + target;
    const u = new URL(target);
    if (!/^https?:$/.test(u.protocol)) throw new Error('Sirf http/https URLs.');
    if (!session.proxyUrl) await assertSafeTarget(u); // SSRF guard (direct mode)
    target = u.href + (formQs && !u.search ? formQs : '');

    const body = req.body && req.body.length ? Buffer.from(req.body) : null;
    const { res: upRes, finalUrl } = await relayFetch(session, target, req.method, req.headers, body);

    const ctype = String(upRes.headers['content-type'] || '');
    res.status(upRes.statusCode);
    for (const [k, v] of Object.entries(upRes.headers)) {
      const lk = k.toLowerCase();
      if (['content-length', 'transfer-encoding', 'content-encoding', 'connection', 'keep-alive', 'set-cookie'].includes(lk)) continue;
      try { res.setHeader(k, v); } catch {}
    }
    if (ctype.includes('text/html')) {
      res.removeHeader('content-security-policy'); // taake injected hook/toolbar chal sake
      res.setHeader('content-type', 'text/html; charset=utf-8');
      const html = (await streamToBuffer(decodedStream(upRes))).toString('utf8');
      return res.send(rewriteHtml(html, finalUrl));
    }
    if (ctype.includes('text/css')) {
      res.setHeader('content-type', 'text/css; charset=utf-8');
      const css = (await streamToBuffer(decodedStream(upRes))).toString('utf8');
      return res.send(rewriteCss(css, finalUrl));
    }
    decodedStream(upRes).pipe(res);
  } catch (e) {
    res.status(502).send(`<body style="background:#111827;color:#e5e7eb;font-family:system-ui;text-align:center;padding:60px;">
      <h2>Khul nahi saki</h2><p>${String(e.message || e).replace(/</g, '&lt;')}</p>
      <a href="/" style="color:#60a5fa;">Wapas jao</a></body>`);
  }
});

app.listen(PORT, () => console.log(`web-proxy listening on :${PORT}`));
