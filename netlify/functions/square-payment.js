const https = require('https');

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'POST, OPTIONS'
      },
      body: ''
    };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const SQUARE_ACCESS_TOKEN = 'EAAAlyv_zslUDGu4TXvvIx5L_6zSBhQaifNoknH_Sa0XKzaK2PwbNbRMXjZFhSAu';
  const SQUARE_LOCATION_ID = '6C19N8VVZFCC5';

  let body;
  try {
    body = JSON.parse(event.body);
  } catch (e) {
    return {
      statusCode: 400,
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ error: 'Invalid request body' })
    };
  }

  const { amountCents, title, description } = body;

  if (!amountCents || !title) {
    return {
      statusCode: 400,
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ error: 'Missing required fields' })
    };
  }

  const idempotencyKey = `${Date.now()}-${Math.random().toString(36).slice(2)}`;

  const paymentData = JSON.stringify({
    idempotency_key: idempotencyKey,
    quick_pay: {
      name: title,
      price_money: {
        amount: amountCents,
        currency: 'USD'
      },
      location_id: SQUARE_LOCATION_ID
    },
    description: description || '',
    redirect_url: 'https://thelambplace.com'
  });

  return new Promise((resolve) => {
    const options = {
      hostname: 'connect.squareup.com',
      path: '/v2/online-checkout/payment-links',
      method: 'POST',
      headers: {
        'Square-Version': '2024-01-18',
        'Authorization': `Bearer ${SQUARE_ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(paymentData)
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode === 200 && parsed.payment_link && parsed.payment_link.url) {
            resolve({
              statusCode: 200,
              headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' },
              body: JSON.stringify({ success: true, paymentUrl: parsed.payment_link.url })
            });
          } else {
            resolve({
              statusCode: 400,
              headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' },
              body: JSON.stringify({ success: false, error: parsed.errors ? parsed.errors[0].detail : 'Failed to create payment link' })
            });
          }
        } catch(e) {
          resolve({
            statusCode: 500,
            headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' },
            body: JSON.stringify({ success: false, error: 'Parse error' })
          });
        }
      });
    });

    req.on('error', (e) => {
      resolve({
        statusCode: 500,
        headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' },
        body: JSON.stringify({ success: false, error: e.message })
      });
    });

    req.write(paymentData);
    req.end();
  });
};
