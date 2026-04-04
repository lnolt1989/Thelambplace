const https = require('https');
const crypto = require('crypto');

const SQUARE_WEBHOOK_SIGNATURE_KEY = 'g8cTyi6D3GKAc8E7v0yE7g';
const SQUARE_ACCESS_TOKEN = 'EAAAlyv_zslUDGu4TXvvIx5L_6zSBhQaifNoknH_Sa0XKzaK2PwbNbRMXjZFhSAu';
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
        'Prefer': method === 'POST' ? 'return=representation' : 'return=minimal'
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

async function getPaymentDetails(paymentId) {
  return new Promise((resolve) => {
    const options = {
      hostname: 'connect.squareup.com',
      path: `/v2/payments/${paymentId}`,
      method: 'GET',
      headers: {
        'Square-Version': '2024-01-18',
        'Authorization': `Bearer ${SQUARE_ACCESS_TOKEN}`,
        'Content-Type': 'application/json'
      }
    };
    const req = https.request(options, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { resolve(null); } });
    });
    req.on('error', () => resolve(null));
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

  if (!payment || payment.status !== 'COMPLETED') {
    return { statusCode: 200, body: 'OK' };
  }

  const amountPaid = payment.amount_money ? (payment.amount_money.amount / 100) : 0;
  const paymentId = payment.id;
  const note = payment.note || '';

  console.log(`✅ Payment COMPLETED: $${amountPaid} | ID: ${paymentId}`);

  try {
    // Try to parse reservation data from note
    let resData = null;
    let lambUUID = null;

    try {
      const parsed = JSON.parse(note);
      resData = parsed;
      lambUUID = parsed.lambUUID;
    } catch(e) {
      // Note is pipe-separated: lamb_id|lamb_name|customer_name|phone|email|pickup|payment_type|deposit|balance_due|total|lambUUID
      const parts = note.split('|');
      if(parts.length >= 10) {
        resData = {
          lamb_id: parts[0],
          lamb_name: parts[1],
          customer_name: parts[2],
          phone: parts[3],
          email: parts[4],
          pickup: parts[5],
          payment_type: parts[6],
          deposit: parseFloat(parts[7]),
          balance_due: parseFloat(parts[8]),
          total: parseFloat(parts[9])
        };
        lambUUID = parts[10];
      }
    }

    if(resData) {
      // Save reservation as paid
      await sbFetch('reservations', 'POST', {
        lamb_id: resData.lamb_id,
        lamb_name: resData.lamb_name,
        customer_name: resData.customer_name,
        phone: resData.phone,
        email: resData.email,
        pickup: resData.pickup,
        notes: resData.notes || '',
        payment_type: resData.payment_type,
        deposit: resData.deposit,
        balance_due: resData.balance_due,
        total: resData.total,
        status: 'paid',
        payment_id: paymentId
      });

      // Mark lamb as reserved using farm_id
      await sbFetch(`lambs?farm_id=eq.${resData.lamb_id}`, 'PATCH', { available: false });

      // Also try by UUID if available
      if(lambUUID && lambUUID !== 'undefined') {
        await sbFetch(`lambs?id=eq.${lambUUID}`, 'PATCH', { available: false });
      }

      console.log(`✅ Reservation saved and lamb ${resData.lamb_id} marked reserved`);
    } else {
      console.log('Could not parse reservation data from note:', note);
    }

  } catch(e) {
    console.error('Error processing payment:', e.message);
  }

  return { statusCode: 200, body: 'OK' };
};
