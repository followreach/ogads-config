/**
 * Production-Grade Firebase Cloud Function / Express Server with Secure S2S Postback Listener Endpoint.
 * Route: /api/postback
 * Description: Securely receives automated conversion notifications from OGAds,
 * validates secret key, converts payout commission to coin rewards, atomically updates
 * database balance with replay protection, and returns HTTP status 200 "OK".
 */

const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const { onRequest } = require('firebase-functions/v2/https');

// Initialize Firebase Admin SDK if not initialized
if (!admin.apps.length) {
  admin.initializeApp();
}

const db = admin.firestore();
const app = express();

app.use(cors({ origin: true }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const EXPECTED_SECRET_KEY = process.env.POSTBACK_SECRET_KEY || 'YtView4View_SuperSecret_998877!';
const CREDITS_PER_USD = parseInt(process.env.CREDITS_PER_USD || '100', 10);

/**
 * Server-side mathematical conversion helper.
 * Safely converts USD payout metric or raw credit count into integer coin rewards.
 */
function calculateCoinReward(rawPayout) {
  const parsedVal = parseFloat(rawPayout);
  if (isNaN(parsedVal) || parsedVal <= 0) {
    return 10; // Default fallback reward
  }

  // If payout is passed as a fraction (< 1.0, e.g. 0.25 USD), multiply by CREDITS_PER_USD
  if (parsedVal < 1.0) {
    return Math.max(1, Math.round(parsedVal * CREDITS_PER_USD));
  }

  // If payout is passed directly as integer/credit count (>= 1.0, e.g. 15, 25)
  return Math.max(1, Math.round(parsedVal));
}

/**
 * Secure S2S Callback Endpoint (/api/postback)
 * Designed for automated OGAds conversion notifications & webhooks.
 */
app.all('/api/postback', async (req, res) => {
  try {
    // 1. Security Validation Layer
    const providedSecret = (
      req.query.secure ||
      req.body?.secure ||
      req.headers['x-postback-secret'] ||
      ''
    ).toString().trim();

    if (!providedSecret || providedSecret !== EXPECTED_SECRET_KEY) {
      console.warn(`[S2S Postback Security] Blocked unauthorized request attempt with secret: "${providedSecret}"`);
      return res.status(403).send('FORBIDDEN_INVALID_KEY');
    }

    // 2. Parameter Parsing & Extraction
    const userId = (
      req.query.userid ||
      req.query.subid ||
      req.query.subID ||
      req.query.uid ||
      req.body?.userid ||
      req.body?.subid ||
      req.body?.subID ||
      req.body?.uid ||
      ''
    ).toString().trim();

    const rawPayout = (
      req.query.payout ||
      req.query.amount ||
      req.query.credits ||
      req.query.reward ||
      req.body?.payout ||
      req.body?.credits ||
      '10'
    ).toString().trim();

    const offerId = (
      req.query.offer_id ||
      req.query.offerid ||
      req.query.id ||
      req.body?.offer_id ||
      'OGADS_OFFER'
    ).toString().trim();

    const conversionTxId = (
      req.query.txid ||
      req.query.transaction_id ||
      req.query.subid2 ||
      req.body?.txid ||
      `ogads_${offerId}_${userId}`
    ).toString().trim();

    if (!userId) {
      console.error('[S2S Postback Error] Missing required user identifier (userid/subID).');
      return res.status(400).send('BAD_REQUEST_MISSING_USERID');
    }

    // 3. Server-Side Mathematical Conversion
    const rewardCredits = calculateCoinReward(rawPayout);

    // 4. Atomic Database Updates & Replay Protection
    const idempotencyRef = db.collection('idempotency_keys').doc(`postback_${conversionTxId}`);
    const walletRef = db.collection('wallets').doc(userId);
    const ledgerRef = db.collection('credit_ledger').doc();

    const result = await db.runTransaction(async (transaction) => {
      // Replay Protection: Check if conversion was already processed
      const idempotencyDoc = await transaction.get(idempotencyRef);
      if (idempotencyDoc.exists) {
        console.log(`[S2S Postback Replay] Conversion ${conversionTxId} already processed. Suppressing duplicate credit award.`);
        return { duplicate: true };
      }

      const walletDoc = await transaction.get(walletRef);
      const todayStr = new Date().toISOString().split('T')[0];

      if (!walletDoc.exists) {
        transaction.set(walletRef, {
          uid: userId,
          balance: rewardCredits,
          lifetimeEarned: rewardCredits,
          lifetimeSpent: 0,
          dailyEarned: rewardCredits,
          dailyEarnedDate: todayStr,
          completedSurveys: [offerId],
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          version: 1,
        });
      } else {
        const data = walletDoc.data() || {};
        const currentBalance = Number(data.balance || 0);
        const currentLifetime = Number(data.lifetimeEarned || 0);
        const currentDaily = data.dailyEarnedDate === todayStr ? Number(data.dailyEarned || 0) : 0;

        transaction.update(walletRef, {
          balance: currentBalance + rewardCredits,
          lifetimeEarned: currentLifetime + rewardCredits,
          dailyEarned: currentDaily + rewardCredits,
          dailyEarnedDate: todayStr,
          completedSurveys: admin.firestore.FieldValue.arrayUnion(offerId),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      }

      transaction.set(ledgerRef, {
        uid: userId,
        amount: rewardCredits,
        type: 'CPA_S2S_POSTBACK',
        description: `OGAds S2S Conversion Reward (Offer #${offerId})`,
        offerId,
        payoutUsd: rawPayout,
        txId: conversionTxId,
        status: 'COMPLETED',
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      transaction.set(idempotencyRef, {
        txId: conversionTxId,
        userId,
        rewardCredits,
        processedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      return { duplicate: false };
    });

    if (result.duplicate) {
      return res.status(200).send('OK');
    }

    console.log(`[S2S Postback Success] Atomically awarded +${rewardCredits} Credits to User ${userId} for conversion ${conversionTxId}.`);
    return res.status(200).send('OK');
  } catch (error) {
    console.error('[S2S Postback Exception] Transaction failed:', error);
    return res.status(500).send('INTERNAL_SERVER_ERROR');
  }
});

// Health check endpoint
app.get('/health', (req, res) => res.status(200).send('OK'));

// Export as a Firebase Cloud Function (Gen 2)
exports.api = onRequest(app);