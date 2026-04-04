const https = require('https');
const crypto = require('crypto');

const SQUARE_WEBHOOK_SIGNATURE_KEY = 'g8cTyi6D3GKAc8E7v0yE7g';
const SB_URL = 'https://suyyqepxyucygkpdrqzi.supabase.co';
const SB_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InN1eXlxZXB4eXVjeWdrcGRycXppIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzUyNjMzNDMsImV4cCI6MjA5MDgzOTM0M30.DyFlELcgVNHarIV_Z0D_redurv4EMwl_w6H_Hog2vy8';

function verifySig(body, sig, url) {
  try {
    const hmac = crypto.createHmac('sha256', SQUARE_WEBHOOK_SIGNATURE_KEY);
    hmac.update(url + body);
    return hmac.digest('base64') === sig;
  } catch(e) { return false; }
}

async function sbFetch(path, method, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const options = {
      hostname: 'suyyqepxyucygkpdrqzi.supabase.co',
      path: `/rest/v1/${path}`,
      method: method || 'GET',
      headers: {
        'apikey': SB_KEY,
        'Authorization': `Bearer ${SB_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': method === 'PATCH' ? 'return=minimal' : 'return=representation'
      }
    };
    if(data) options.headers['Content-Length'] = Buffer.byteLength(data);
    const req = https.request(options, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(d ? JSON.parse(d) : null); } catch(e) { resolve(null); } });
    });
    req.on('error', reject);
    if(data) req.write(data);
    req.end();
  });
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const body = event.body;
  const sig = event.headers['x-square-hmacsha256-signature'];
  const url = 'https://thelambplace.com/.netlify/functions/square-webhook';

  if (!verifySig(body, sig, url)) {
    console.log('Invalid signature');
    return { statusCode: 401, body: 'Unauthorized' };
  }

  let payload;
  try { payload = JSON.parse(body); } catch(e) {
    return { statusCode: 400, body: 'Invalid body' };
  }

  const eventType = payload.type;
  const payment = payload.data && payload.data.object && payload.data.object.payment;

  if (!payment) return { statusCode: 200, body: 'OK' };

  console.log(`Event: ${eventType} | Status: ${payment.status} | Amount: ${payment.amount_money ? payment.amount_money.amount : 'N/A'}`);

  // Only act on completed payments
  if (payment.status === 'COMPLETED') {
    const amountPaid = payment.amount_money ? (payment.amount_money.amount / 100) : 0;
    const paymentId = payment.id;
    const note = payment.note || '';

    try {
      // Find matching awaiting_payment reservation
      const reservations = await sbFetch(
        'reservations?status=eq.awaiting_payment&order=created_at.desc&limit=20',
        'GET'
      );

      if (reservations && reservations.length > 0) {
        const match = reservations.find(r =>
          Math.abs(Number(r.deposit) - amountPaid) < 1 ||
          note.includes(r.lamb_name) ||
          note.includes(r.lamb_id)
        ) || reservations[0];

        if (match) {
          // Mark reservation as paid
          await sbFetch(
            `reservations?id=eq.${match.id}`,
            'PATCH',
            { status: 'paid', payment_id: paymentId }
          );

          // NOW mark lamb as reserved — only after payment confirmed
          await sbFetch(
            `lambs?farm_id=eq.${match.lamb_id}`,
            'PATCH',
            { available: false }
          );

          console.log(`✅ Payment confirmed — Reservation ${match.id} paid, lamb ${match.lamb_id} reserved`);
        }
      }
    } catch(e) {
      console.error('DB error:', e.message);
    }
  }

  // Clean up old pending/abandoned reservations (older than 1 hour)
  if (eventType === 'payment.updated') {
    try {
      const oneHourAgo = new Date(Date.now() - 3600000).toISOString();
      await sbFetch(
        `reservations?status=eq.awaiting_payment&created_at=lt.${oneHourAgo}`,
        'DELETE'
      );
    } catch(e) {
      console.log('Cleanup skipped:', e.message);
    }
  }

  return { statusCode: 200, body: 'OK' };
};
