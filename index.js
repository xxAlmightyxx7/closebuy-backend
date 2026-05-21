const http = require('http');
const https = require('https');
const { URL } = require('url');

// ── CREDENTIALS (from environment variables) ──
const CONFIG = {
  supabase: {
    url:  process.env.SUPABASE_URL  || 'https://elfwiiwbusoghgzcukve.supabase.co',
    key:  process.env.SUPABASE_KEY,
  },
  claude: {
    key:  process.env.CLAUDE_KEY,
  },
  twilio: {
    sid:  process.env.TWILIO_SID,
    token:process.env.TWILIO_TOKEN,
    from: process.env.TWILIO_FROM   || '+18474720466',
  }
};

// ── SUPABASE ──
async function supabase(method, path, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(CONFIG.supabase.url + '/rest/v1/' + path);
    const bodyStr = body ? JSON.stringify(body) : '';
    const opts = {
      hostname: url.hostname,
      path: url.pathname + url.search,
      method,
      headers: {
        'apikey': CONFIG.supabase.key,
        'Authorization': 'Bearer ' + CONFIG.supabase.key,
        'Content-Type': 'application/json',
        'Prefer': method === 'POST' ? 'return=representation' : '',
      }
    };
    const req = https.request(opts, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve(data); } });
    });
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// ── TWILIO SMS ──
async function sendSMS(to, body) {
  return new Promise((resolve, reject) => {
    const params = new URLSearchParams({ To: to, From: CONFIG.twilio.from, Body: body });
    const paramStr = params.toString();
    const auth = Buffer.from(CONFIG.twilio.sid + ':' + CONFIG.twilio.token).toString('base64');
    const opts = {
      hostname: 'api.twilio.com',
      path: `/2010-04-01/Accounts/${CONFIG.twilio.sid}/Messages.json`,
      method: 'POST',
      headers: {
        'Authorization': 'Basic ' + auth,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(paramStr),
      }
    };
    const req = https.request(opts, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => resolve(JSON.parse(data)));
    });
    req.on('error', reject);
    req.write(paramStr);
    req.end();
  });
}

// ── CLAUDE AGENT ──
async function claudeAgent(systemPrompt, messages) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1000,
      system: systemPrompt,
      messages
    });
    const opts = {
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'x-api-key': CONFIG.claude.key,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      }
    };
    const req = https.request(opts, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try { resolve(JSON.parse(data).content?.[0]?.text || ''); }
        catch { reject(data); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── AGENT SYSTEM PROMPT ──
const AGENT_PROMPT = `You are the CloseBuy assistant — a friendly, bilingual (English/Spanish) helper that connects shoppers to nearby independent stores on the Algonquin Rd corridor in Rolling Meadows, IL.

Your job:
- Understand what product the customer is looking for
- Tell them which nearby stores carry it
- Help them send an availability request
- Be warm, concise — max 2-3 sentences per reply

Rules:
- If customer writes in Spanish → respond in Spanish
- If customer writes in English → respond in English
- Never make up store information
- If a store hasn't responded in 8 minutes, suggest the next nearest
- Always mention store distance and hours

Stores:
- Primos Dollar + (0.3 mi) — Convenience, Spanish, 8am-10pm — tortillas, rice, beans, Goya, snacks, household
- El Barrio Fresh Market (0.4 mi) — Grocery, Spanish, 7am-9pm — fresh produce, Latino groceries, plantains, Maseca, meats
- Zam Zam Fresh Market (0.5 mi) — Grocery, Arabic/English, 9am-9pm — halal meats, Middle Eastern, rice, spices
- Rx Pharmacy (0.6 mi) — Pharmacy, Spanish/English, 9am-7pm — medicine, vitamins, personal care`;

// ── CHAT HANDLER ──
async function handleChat(sessionId, userMessage) {
  const history = await supabase('GET', `conversations?session_id=eq.${encodeURIComponent(sessionId)}&order=created_at.asc&limit=20`);
  const messages = Array.isArray(history) ? history.map(h => ({ role: h.role, content: h.content })) : [];
  messages.push({ role: 'user', content: userMessage });
  const reply = await claudeAgent(AGENT_PROMPT, messages);
  await supabase('POST', 'conversations', { session_id: sessionId, role: 'user', content: userMessage });
  await supabase('POST', 'conversations', { session_id: sessionId, role: 'assistant', content: reply });
  return reply;
}

// ── REQUEST HANDLER ──
async function handleRequest(requestId, productName, storeId, storeName, storePhone, customerSession) {
  await supabase('POST', 'requests', {
    id: requestId, product: productName,
    store_id: storeId, store_name: storeName,
    store_phone: storePhone, customer_session: customerSession,
    status: 'pending', created_at: new Date().toISOString()
  });

  if (storePhone) {
    try {
      await sendSMS(storePhone, `CloseBuy: Someone nearby is looking for "${productName}". Do you have it? Reply YES or NO.`);
      console.log(`SMS sent to ${storeName}`);
    } catch (e) { console.log('SMS error:', e.message); }
  }

  // Auto-escalate after 8 minutes
  setTimeout(async () => {
    const reqs = await supabase('GET', `requests?id=eq.${requestId}`);
    if (Array.isArray(reqs) && reqs[0]?.status === 'pending') {
      await supabase('PATCH', `requests?id=eq.${requestId}`, { status: 'escalated' });
      console.log(`Escalated request ${requestId} — no reply from ${storeName}`);
    }
  }, 8 * 60 * 1000);

  return { success: true, message: `Request sent to ${storeName}` };
}

// ── HTTP SERVER ──
const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Content-Type', 'application/json');
  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  let body = '';
  req.on('data', d => body += d);
  req.on('end', async () => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const path = url.pathname;
      const data = body ? JSON.parse(body) : {};

      // Health check
      if (path === '/' && req.method === 'GET') {
        res.writeHead(200);
        res.end(JSON.stringify({ status: 'CloseBuy backend running ✓', version: '1.0' }));
        return;
      }

      // Chat
      if (path === '/chat' && req.method === 'POST') {
        const { sessionId, message } = data;
        if (!sessionId || !message) { res.writeHead(400); res.end(JSON.stringify({ error: 'sessionId and message required' })); return; }
        const reply = await handleChat(sessionId, message);
        res.writeHead(200);
        res.end(JSON.stringify({ reply }));
        return;
      }

      // Availability request
      if (path === '/request' && req.method === 'POST') {
        const { requestId, productName, storeId, storeName, storePhone, customerSession } = data;
        const result = await handleRequest(requestId, productName, storeId, storeName, storePhone, customerSession);
        res.writeHead(200);
        res.end(JSON.stringify(result));
        return;
      }

      // Get stores
      if (path === '/stores' && req.method === 'GET') {
        const stores = await supabase('GET', 'stores?order=priority_rank.asc&active=eq.true');
        res.writeHead(200);
        res.end(JSON.stringify(stores));
        return;
      }

      // Get products
      if (path === '/products' && req.method === 'GET') {
        const cat = url.searchParams.get('cat');
        const q = url.searchParams.get('q');
        let endpoint = 'products?order=name.asc';
        if (cat && cat !== 'all') endpoint += `&category=eq.${cat}`;
        if (q) endpoint += `&name=ilike.*${encodeURIComponent(q)}*`;
        const products = await supabase('GET', endpoint);
        res.writeHead(200);
        res.end(JSON.stringify(products));
        return;
      }

      // SMS reply from store owner (Twilio webhook)
      if (path === '/sms-reply' && req.method === 'POST') {
        const reply = (data.Body || '').trim().toUpperCase();
        const from = data.From;
        if (['YES','SI','SÍ','Y'].includes(reply)) {
          const reqs = await supabase('GET', `requests?store_phone=eq.${encodeURIComponent(from)}&status=eq.pending&order=created_at.desc&limit=1`);
          if (Array.isArray(reqs) && reqs[0]) {
            await supabase('PATCH', `requests?id=eq.${reqs[0].id}`, { status: 'confirmed', store_reply: 'yes', replied_at: new Date().toISOString() });
            console.log(`Store ${from} confirmed: ${reqs[0].product}`);
          }
        } else if (['NO','N'].includes(reply)) {
          const reqs = await supabase('GET', `requests?store_phone=eq.${encodeURIComponent(from)}&status=eq.pending&order=created_at.desc&limit=1`);
          if (Array.isArray(reqs) && reqs[0]) {
            await supabase('PATCH', `requests?id=eq.${reqs[0].id}`, { status: 'declined', store_reply: 'no', replied_at: new Date().toISOString() });
          }
        }
        res.writeHead(200);
        res.end(JSON.stringify({ received: true }));
        return;
      }

      res.writeHead(404);
      res.end(JSON.stringify({ error: 'Not found' }));

    } catch (err) {
      console.error('Server error:', err);
      res.writeHead(500);
      res.end(JSON.stringify({ error: err.message }));
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n🚀 CloseBuy backend running on port ${PORT}`);
  console.log(`📍 Routes: GET / | POST /chat | POST /request | GET /stores | GET /products | POST /sms-reply\n`);
});
