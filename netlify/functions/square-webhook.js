const https = require('https');
const crypto = require('crypto');

const SQUARE_WEBHOOK_SIGNATURE_KEY = 'g8cTyi6D3GKAc8E7v0yE7g';
const SQUARE_ACCESS_TOKEN = 'EAAAlyv_zslUDGu4TXvvIx5L_6zSBhQaifNoknH_Sa0XKzaK2PwbNbRMXjZFhSAu';
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

async function getSquarePayment(paymentId) {
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
    return { statusCode: 200, body: 'OK' };
  }

  const body = event.body;
  const sig = event.headers['x-square-hmacsha256-signature'];
  const url = 'https://thelambplace.com/.netlify/functions/square-webhook';

  if (!verifySig(body, sig, url)) {
    console.log('Invalid signature');
    return { statusCode: 200, body: 'OK' };
  }

  let payload;
  try { payload = JSON.parse(body); } catch(e) {
    return { statusCode: 200, body: 'OK' };
  }

  const payment = payload.data && payload.data.object && payload.data.object.payment;
  if (!payment || payment.status !== 'COMPLETED') {
    return { statusCode: 200, body: 'OK' };
  }

  const amountPaid = payment.amount_money ? (payment.amount_money.amount / 100) : 0;
  const paymentId = payment.id;
  const desc = payment.note || payment.description || '';

  // Parse lamb_id from description (format: TLP-1002|customer|phone|pickup)
  const descParts = desc.split('|');
  const lambIdFromDesc = descParts[0] || '';

  console.log(`✅ Payment COMPLETED: $${amountPaid} | ID: ${paymentId} | Desc: ${desc}`);

  try {
    // Find matching pending reservation
    const reservations = await sbFetch(
      `reservations?status=eq.pending_payment&order=created_at.desc&limit=20`,
      'GET'
    );

    console.log(`Pending reservations found: ${reservations ? reservations.length : 0}`);

    if (reservations && reservations.length > 0) {
      // Match by lamb_id or amount
      const match = reservations.find(r => lambIdFromDesc && r.lamb_id === lambIdFromDesc)
        || reservations.find(r => Math.abs(Number(r.deposit) - amountPaid) < 0.5)
        || reservations[0];

      // Mark reservation paid
      await sbFetch(`reservations?id=eq.${match.id}`, 'PATCH', {
        status: 'paid',
        payment_id: paymentId
      });

      // Mark lamb reserved
      await sbFetch(`lambs?farm_id=eq.${match.lamb_id}`, 'PATCH', { available: false });

      console.log(`✅ Reservation ${match.id} paid, lamb ${match.lamb_id} reserved`);

    } else {
      // No pending reservation found — get full payment details from Square
      // and find the lamb by matching amount to price
      console.log('No pending reservation — finding lamb by payment amount');

      const lambs = await sbFetch(`lambs?available=eq.true&select=*`, 'GET');
      console.log(`Available lambs: ${JSON.stringify(lambs)}`);

      let matchedLamb = null;

      if(lambs && lambs.length > 0) {
        // Match by deposit (25% of price) or full price
        matchedLamb = lambs.find(l => Math.abs(Math.round(Number(l.price) * 0.25) - amountPaid) < 1)
          || lambs.find(l => Math.abs(Number(l.price) - amountPaid) < 1);
      }

      if(matchedLamb) {
        console.log(`Matched lamb: ${matchedLamb.farm_id}`);

        // Get buyer info from Square payment details
        const payDetails = await getSquarePayment(paymentId);
        const buyerEmail = payDetails && payDetails.payment && payDetails.payment.buyer_email_address || '';
        const buyerName = payDetails && payDetails.payment && payDetails.payment.shipping_address && payDetails.payment.shipping_address.recipient_name || 'Customer';

        // Create reservation record
        const pif = Math.abs(Number(matchedLamb.price) - amountPaid) < 1;
        const dep = Math.round(Number(matchedLamb.price) * 0.25);

        await sbFetch('reservations', 'POST', {
          lamb_id: matchedLamb.farm_id,
          lamb_name: matchedLamb.name,
          customer_name: buyerName,
          phone: 'See Square payment ' + paymentId,
          email: buyerEmail,
          pickup: 'eid1',
          notes: `Auto-created from Square payment ${paymentId}`,
          payment_type: pif ? 'full' : 'deposit',
          deposit: amountPaid,
          balance_due: pif ? 0 : Number(matchedLamb.price) - amountPaid,
          total: Number(matchedLamb.price),
          status: 'paid',
          payment_id: paymentId
        });

        // Mark lamb reserved
        await sbFetch(`lambs?farm_id=eq.${matchedLamb.farm_id}`, 'PATCH', { available: false });

        console.log(`✅ Auto-created reservation for lamb ${matchedLamb.farm_id}`);
      } else {
        console.log('Could not match payment to any lamb');
      }
    }

  } catch(e) {
    console.error('Error:', e.message);
  }

  // Clean up old pending reservations (10 min)
  try {
    const tenMinsAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    await sbFetch(`reservations?status=eq.pending_payment&created_at=lt.${tenMinsAgo}`, 'DELETE');
  } catch(e) {}

  return { statusCode: 200, body: 'OK' };
};
