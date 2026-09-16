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
// NOTE: now logs the raw response and throws a real error instead of
// silently resolving to an empty string when something goes wrong.
async function claudeAgent(systemPrompt, messages) {
  return new Promise((resolve, reject) => {
    if (!CONFIG.claude.key) {
      console.error('claudeAgent: CLAUDE_KEY is missing/undefined in environment');
      reject(new Error('CLAUDE_KEY not set'));
      return;
    }

    const body = JSON.stringify({
      model: 'claude-sonnet-4-5',
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
        console.log('Claude API status:', res.statusCode);
        console.log('Claude API raw response:', data);

        let parsed;
        try { parsed = JSON.parse(data); }
        catch (e) {
          console.error('claudeAgent: failed to parse Claude response as JSON', e.message);
          reject(new Error('Claude API returned non-JSON response'));
          return;
        }

        if (res.statusCode !== 200) {
          console.error('claudeAgent: Claude API error', parsed.error || parsed);
          reject(new Error(parsed.error?.message || `Claude API returned status ${res.statusCode}`));
          return;
        }

        const text = parsed.content?.[0]?.text;
        if (!text) {
          console.error('claudeAgent: no text in Claude response', parsed);
          reject(new Error('Claude API response had no text content'));
          return;
        }

        resolve(text);
      });
    });
    req.on('error', e => {
      console.error('claudeAgent: request error', e.message);
      reject(e);
    });
    req.write(body);
    req.end();
  });
}

// ── AGENT SYSTEM PROMPT ──
// The store list used to be hardcoded to 4 fake stores with made-up distances
// and hours — that drifted from the real catalog the moment we seeded the
// real 65-store database. Now it's built fresh from Supabase on every chat
// request, so the assistant can never say something the site itself doesn't
// also show.
const BASE_AGENT_PROMPT = `You are the CloseBuy assistant — a friendly, bilingual (English/Spanish) helper that connects shoppers to nearby independent stores on the Algonquin Rd corridor in the Chicago suburbs (Rolling Meadows, Mount Prospect, Palatine, Wheeling, Des Plaines, and nearby towns).

Your job:
- Understand what product or category the customer is looking for
- Tell them which store(s) from the list below are likely to carry it, based on category
- Help them send an availability request
- Be warm, concise — max 2-3 sentences per reply

Rules:
- If customer writes in Spanish → respond in Spanish
- If customer writes in English → respond in English
- ONLY reference stores from the list below. Never invent a store, address, phone number, hours, or exact distance
- You do NOT have real-time distance or hours data. If asked for exact distance or hours, say you don't have that on file yet and point them to the store list on the site, which shows every active store
- If it's unclear which store fits, ask a short clarifying question

Active stores (name — category, city, language):
{{STORE_LIST}}`;

// ── CHAT HANDLER ──
async function handleChat(sessionId, userMessage) {
  let history = [];
  try {
    history = await supabase('GET', `conversations?session_id=eq.${encodeURIComponent(sessionId)}&order=created_at.asc&limit=20`);
  } catch (e) {
    console.error('handleChat: failed to load history', e.message);
  }

  let storeListText = '(store list temporarily unavailable — tell the customer to check the site directly)';
  try {
    const stores = await supabase('GET', 'stores?select=name,category,city,language&order=priority_rank.asc&active=eq.true');
    if (Array.isArray(stores) && stores.length) {
      storeListText = stores.map(s => `- ${s.name} — ${s.category}, ${s.city}, ${s.language || 'English'}`).join('\n');
    }
  } catch (e) {
    console.error('handleChat: failed to load store list for prompt', e.message);
  }
  const systemPrompt = BASE_AGENT_PROMPT.replace('{{STORE_LIST}}', storeListText);

  const messages = Array.isArray(history) ? history.map(h => ({ role: h.role, content: h.content })) : [];
  messages.push({ role: 'user', content: userMessage });

  // Let errors from claudeAgent propagate up so the HTTP handler can
  // return a real error response instead of a silent empty reply.
  const reply = await claudeAgent(systemPrompt, messages);

  try {
    await supabase('POST', 'conversations', { session_id: sessionId, role: 'user', content: userMessage });
    await supabase('POST', 'conversations', { session_id: sessionId, role: 'assistant', content: reply });
  } catch (e) {
    console.error('handleChat: failed to save conversation', e.message);
  }

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
        try {
          const reply = await handleChat(sessionId, message);
          res.writeHead(200);
          res.end(JSON.stringify({ reply }));
        } catch (e) {
          console.error('/chat error:', e.message);
          res.writeHead(502);
          res.end(JSON.stringify({ error: 'chat_failed', detail: e.message }));
        }
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
