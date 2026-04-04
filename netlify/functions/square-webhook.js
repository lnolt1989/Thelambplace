const https = require('https');
const crypto = require('crypto');

const SQUARE_WEBHOOK_SIGNATURE_KEY = 'g8cTyi6D3GKAc8E7v0yE7g';
const SQUARE_ACCESS_TOKEN = 'EAAAlyv_zslUDGu4TXvvIx5L_6zSBhQaifNoknH_Sa0XKzaK2PwbNbRMXjZFhSAu';
const SB_URL = 'https://suyyqepxyucygkpdrqzi.supabase.co';
const SB_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InN1eXlxZXB4eXVjeWdrcGRycXppIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzUyNjMzNDMsImV4cCI6MjA5MDgzOTM0M30.DyFlELcgVNHarIV_Z0D_redurv4EMwl_w6H_Hog2vy8';
const NOTIFICATION_EMAIL = 'thelambplace@gmail.com';

function verifySig(body, sig, url) {
  try {
    const hmac = crypto.createHmac('sha256', SQUARE_WEBHOOK_SIGNATURE_KEY);
    hmac.update(url + body);
    const expected = hmac.digest('base64');
    return expected === sig;
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
      res.on('end', () => resolve(d ? JSON.parse(d) : null));
    });
    req.on('error', reject);
    if(data) req.write(data);
    req.end();
  });
}

async function sendEmail(to, subject, body) {
  // Use Square's notification — we'll log the payment details
  // and rely on Supabase + admin panel for tracking
  console.log(`Email would be sent to ${to}: ${subject}`);
  console.log(body);
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const body = event.body;
  const sig = event.headers['x-square-hmacsha256-signature'];
  const url = `https://thelambplace.com/.netlify/functions/square-webhook`;

  // Verify signature
  if (!verifySig(body, sig, url)) {
    console.log('Invalid signature');
    return { statusCode: 401, body: 'Unauthorized' };
  }

  let payload;
  try { payload = JSON.parse(body); } catch(e) {
    return { statusCode: 400, body: 'Invalid body' };
  }

  const eventType = payload.type;
  console.log('Square webhook event:', eventType);

  // Handle payment completed
  if (eventType === 'payment.updated' || eventType === 'payment.created') {
    const payment = payload.data && payload.data.object && payload.data.object.payment;
    if (!payment) return { statusCode: 200, body: 'OK' };

    if (payment.status === 'COMPLETED') {
      const amountPaid = (payment.amount_money.amount / 100).toFixed(2);
      const paymentId = payment.id;
      const note = payment.note || '';

      console.log(`Payment completed: $${amountPaid} - ${note}`);

      // Find reservation by matching amount or note
      try {
        const reservations = await sbFetch(
          `reservations?status=eq.awaiting_payment&order=created_at.desc&limit=10`,
          'GET'
        );

        if (reservations && reservations.length > 0) {
          // Find best matching reservation
          const match = reservations.find(r =>
            Math.abs(r.deposit - parseFloat(amountPaid)) < 1 ||
            note.includes(r.lamb_name) ||
            note.includes(r.lamb_id)
          ) || reservations[0];

          if (match) {
            // Update reservation to paid
            await sbFetch(
              `reservations?id=eq.${match.id}`,
              'PATCH',
              { status: 'paid', payment_id: paymentId }
            );

            // Mark lamb as reserved
            await sbFetch(
              `lambs?farm_id=eq.${match.lamb_id}`,
              'PATCH',
              { available: false }
            );

            console.log(`Reservation ${match.id} marked as paid`);

            // Log confirmation details for admin
            const pickupTxt = match.pickup === 'eid1' ? 'Day 1 of Eid' : 'Day 2 of Eid';
            const balanceDue = match.balance_due || 0;
            console.log(`
PAID RESERVATION — THE LAMB PLACE
===================================
Payment ID: ${paymentId}
Amount Paid: $${amountPaid}

LAMB: ${match.lamb_name} (${match.lamb_id})
Total: $${match.total}
Balance Due on Pickup: $${balanceDue}
Pickup: ${pickupTxt}

CUSTOMER
Name: ${match.customer_name}
Phone: ${match.phone}
Email: ${match.email}
Notes: ${match.notes || 'None'}
            `);
          }
        }
      } catch(e) {
        console.error('DB error:', e.message);
      }
    }
  }

  return { statusCode: 200, body: 'OK' };
};
