const https = require('https');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const SQUARE_ACCESS_TOKEN = process.env.SQUARE_ACCESS_TOKEN;
  const SQUARE_LOCATION_ID = process.env.SQUARE_LOCATION_ID;

  let body;
  try {
    body = JSON.parse(event.body);
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid request body' }) };
  }

  const { sourceId, amountCents, note } = body;

  if (!sourceId || !amountCents) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Missing required fields' }) };
  }

  const idempotencyKey = `${Date.now()}-${Math.random().toString(36).slice(2)}`;

  const paymentData = JSON.stringify({
    source_id: sourceId,
    idempotency_key: idempotencyKey,
    amount_money: { amount: amountCents, currency: 'USD' },
    location_id: SQUARE_LOCATION_ID,
    note: note || 'The Lamb Place reservation'
  });

  return new Promise((resolve) => {
    const options = {
      hostname: 'connect.squareup.com',
      path: '/v2/payments',
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
        const parsed = JSON.parse(data);
        if (res.statusCode === 200 && parsed.payment && parsed.payment.status === 'COMPLETED') {
          resolve({
            statusCode: 200,
            headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' },
            body: JSON.stringify({ success: true, paymentId: parsed.payment.id })
          });
        } else {
          resolve({
            statusCode: 400,
            headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' },
            body: JSON.stringify({ success: false, error: parsed.errors ? parsed.errors[0].detail : 'Payment failed' })
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
