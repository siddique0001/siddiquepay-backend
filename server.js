require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const crypto = require('crypto');

const app = express();
app.use(cors());

/* ═══════════════════════════════════════════════════════
   WEBHOOK ROUTE — MUST BE FIRST (before express.json)
   Raw body chahiye signature verify karne ke liye
   ═══════════════════════════════════════════════════════ */
const APINEPAL_WEBHOOK_SECRET = process.env.APINEPAL_WEBHOOK_SECRET;

app.post(
    '/api/webhook',
    express.raw({ type: '*/*', limit: '5mb' }),
    async (req, res) => {
        try {
            console.log('📥 Webhook received');
            console.log('   Headers:', JSON.stringify(req.headers));

            const signature = req.headers['x-anp-signature'] || req.headers['x-signature'];
            const bodyBuffer = req.body;
            const bodyStr = Buffer.isBuffer(bodyBuffer) ? bodyBuffer.toString('utf8') : String(bodyBuffer || '');

            console.log('   Body length:', bodyStr.length);
            console.log('   Body preview:', bodyStr.substring(0, 300));

            // ═══ Verify signature ═══
            if (APINEPAL_WEBHOOK_SECRET && signature) {
                const expectedSig = crypto
                    .createHmac('sha256', APINEPAL_WEBHOOK_SECRET)
                    .update(bodyStr)
                    .digest('hex');

                if (signature !== expectedSig) {
                    console.warn('❌ Signature mismatch');
                    console.warn('   Expected:', expectedSig);
                    console.warn('   Got:', signature);
                    // Still return 200 to avoid retries during testing
                    // Change to 401 later if you want strict
                    return res.status(200).json({ received: true, warning: 'signature_mismatch' });
                }
                console.log('✅ Signature verified');
            } else {
                console.log('⚠️ No signature or secret — skipping verify');
            }

            // ═══ Parse event ═══
            let event = {};
            try {
                event = bodyStr ? JSON.parse(bodyStr) : {};
            } catch (e) {
                console.warn('⚠️ JSON parse failed:', e.message);
            }

            console.log('📦 Event type:', event.type || event.status || 'unknown');

            const orderId = event.data?.order_id || event.order_id;
            const status = event.type || event.status;

            // ═══ Update Firebase ═══
            const admin = require('firebase-admin');
            const db = (admin.apps && admin.apps.length) ? admin.database() : null;

            if (db && orderId) {
                if (status === 'payment.success' || status === 'success' || status === 'completed') {
                    await db.ref('orders/' + orderId).update({
                        status: 'Processing',
                        paymentStatus: 'paid',
                        paidAt: Date.now(),
                        transactionId: event.data?.transaction_id || '',
                        webhookData: event
                    });
                    console.log('✅ Order marked PAID:', orderId);
                } else if (status === 'payment.failed' || status === 'failed') {
                    await db.ref('orders/' + orderId).update({
                        status: 'Cancelled',
                        paymentStatus: 'failed',
                        failedAt: Date.now(),
                        webhookData: event
                    });
                    console.log('❌ Order marked FAILED:', orderId);
                } else if (status === 'payment.testevent' || status === 'testevent') {
                    console.log('🧪 Test event received — all good!');
                } else {
                    console.log('ℹ️ Unhandled event type:', status);
                }
            } else {
                console.log('⚠️ Missing db or orderId — skipping update');
            }

            // ═══ Always return 200 ═══
            res.status(200).json({ received: true });

        } catch (error) {
            console.error('❌ Webhook handler error:', error);
            // Return 200 so API Nepal doesn't retry infinitely
            res.status(200).json({ received: true, error: error.message });
        }
    }
);

/* ═══════════════════════════════════════════════════════
   NOW parse JSON for all OTHER routes
   ═══════════════════════════════════════════════════════ */
app.use(express.json({ limit: '5mb' }));

/* ═══════════════════════════════════════════════════════
   FIREBASE INIT
   ═══════════════════════════════════════════════════════ */
const admin = require('firebase-admin');

try {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}');
    if (serviceAccount.project_id) {
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount),
            databaseURL: process.env.FIREBASE_DB_URL
        });
        console.log('✅ Firebase connected');
    } else {
        console.log('⚠️ Firebase not configured');
    }
} catch (e) {
    console.error('Firebase error:', e.message);
}

const db = admin.apps && admin.apps.length ? admin.database() : null;

/* ═══════════════════════════════════════════════════════
   CONFIG
   ═══════════════════════════════════════════════════════ */
const APINEPAL_API_KEY = process.env.APINEPAL_API_KEY;
const APINEPAL_SECRET_KEY = process.env.APINEPAL_SECRET_KEY;
const APINEPAL_BASE_URL = process.env.APINEPAL_BASE_URL || 'https://apinepal.com/api/v1';
const BASE_URL = process.env.BASE_URL || 'https://siddiquepay-backend.onrender.com';

/* ═══════════════════════════════════════════════════════
   ROUTE 1: CREATE PAYMENT
   ═══════════════════════════════════════════════════════ */
app.post('/api/create-payment', async (req, res) => {
    try {
        const { amount, orderId, customerName, customerPhone, packageName } = req.body;

        if (!amount || !orderId) {
            return res.status(400).json({ success: false, error: 'amount and orderId required' });
        }

        console.log('📤 Creating payment:', { amount, orderId });

        const response = await axios.post(
            `${APINEPAL_BASE_URL}/payment/initialize`,
            {
                amount: Number(amount),
                order_id: orderId,
                customer_name: customerName || 'Customer',
                customer_phone: customerPhone || '',
                package_name: packageName || '',
                return_url: `${BASE_URL}/api/return?order_id=${orderId}`,
                webhook_url: `${BASE_URL}/api/webhook`
            },
            {
                headers: {
                    'Authorization': `Bearer ${APINEPAL_API_KEY}`,
                    'X-Secret-Key': APINEPAL_SECRET_KEY,
                    'Content-Type': 'application/json',
                    'Accept': 'application/json'
                },
                timeout: 15000
            }
        );

        console.log('✅ API Nepal response:', response.data);
        res.json({ success: true, data: response.data });

    } catch (error) {
        console.error('❌ Create payment error:', error.response?.data || error.message);
        res.status(500).json({
            success: false,
            error: error.response?.data?.message || error.message
        });
    }
});

/* ═══════════════════════════════════════════════════════
   ROUTE 2: PAYMENT STATUS
   ═══════════════════════════════════════════════════════ */
app.get('/api/payment-status/:orderId', async (req, res) => {
    try {
        const { orderId } = req.params;

        if (db) {
            const snap = await db.ref('orders/' + orderId).once('value');
            const order = snap.val();
            if (order && order.paymentStatus) {
                return res.json({
                    success: true,
                    status: order.paymentStatus,
                    order: order
                });
            }
        }

        const response = await axios.get(
            `${APINEPAL_BASE_URL}/payment/status/${orderId}`,
            {
                headers: {
                    'Authorization': `Bearer ${APINEPAL_API_KEY}`,
                    'X-Secret-Key': APINEPAL_SECRET_KEY
                },
                timeout: 10000
            }
        );

        res.json({ success: true, status: response.data.status, data: response.data });

    } catch (error) {
        console.error('Status error:', error.message);
        res.json({ success: false, status: 'unknown' });
    }
});

/* ═══════════════════════════════════════════════════════
   ROUTE 3: CANCEL PAYMENT
   ═══════════════════════════════════════════════════════ */
app.post('/api/cancel-payment', async (req, res) => {
    try {
        const { orderId } = req.body;

        try {
            await axios.post(
                `${APINEPAL_BASE_URL}/payment/cancel`,
                { order_id: orderId },
                {
                    headers: {
                        'Authorization': `Bearer ${APINEPAL_API_KEY}`,
                        'X-Secret-Key': APINEPAL_SECRET_KEY
                    },
                    timeout: 10000
                }
            );
        } catch (e) {
            console.warn('Cancel API failed:', e.message);
        }

        if (db) {
            await db.ref('orders/' + orderId).update({
                status: 'Cancelled',
                paymentStatus: 'cancelled',
                cancelledAt: Date.now()
            });
        }

        res.json({ success: true });

    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

/* ═══════════════════════════════════════════════════════
   ROUTE 5: RETURN URL
   ═══════════════════════════════════════════════════════ */
app.get('/api/return', (req, res) => {
    const { order_id } = req.query;
    res.redirect(`${process.env.FRONTEND_URL || 'https://siddiquemarkett.netlify.app'}/#success=${order_id}`);
});

/* ═══════════════════════════════════════════════════════
   HEALTH CHECK
   ═══════════════════════════════════════════════════════ */
app.get('/', (req, res) => {
    res.json({ status: 'ok', service: 'Siddique Payment Backend' });
});

/* ═══════════════════════════════════════════════════════
   START
   ═══════════════════════════════════════════════════════ */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
});
