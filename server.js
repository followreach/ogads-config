const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');

// Initialize Firebase Admin SDK
if (!admin.apps.length) {
  admin.initializeApp();
}

const db = admin.firestore();
const app = express();

app.use(cors({ origin: true }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 3000;
const EXPECTED_SECRET_KEY = process.env.POSTBACK_SECRET_KEY || 'YtView4View_SuperSecret_998877!';
const CREDITS_PER_USD = parseInt(process.env.CREDITS_PER_USD || '100', 10);

function calculateCoinReward(rawPayout) {
  const parsedVal = parseFloat(rawPayout);
  if (isNaN(parsedVal) || parsedVal <= 0) {
    return 10;
  }
  if (parsedVal < 1.0) {
    return Math.max(1, Math.round(parsedVal * CREDITS_PER_USD));
  }
  return Math.max(1, Math.round(parsedVal));
}

app.all('/api/postback', async (req, res) => {
  try {
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

    const userId = (
      req.query.userid ||
      req.query.subid ||
      req.query.subID ||
      req.query.uid ||
      ''
    ).toString().trim();

    const rawPayout = (
      req.query.payout ||
      req.query.amount ||
      req.query.credits ||
      '10'
    ).toString().trim();

    const offerId = (
      req.query.offer_id ||
      req.query.offerid ||
      'OGADS_OFFER'
    ).toString().trim();

    const conversionTxId = (
      req.query.txid ||
      req.query.transaction_id ||
      `ogads_${offerId}_${userId}`
    ).toString().trim();

    if (!userId) {
      return res.status(400).send('BAD_REQUEST_MISSING_USERID');
    }

    const rewardCredits = calculateCoinReward(rawPayout);

    const idempotencyRef = db.collection('idempotency_keys').doc(`postback_${conversionTxId}`);
    const walletRef = db.collection('wallets').doc(userId);
    const ledgerRef = db.collection('credit_ledger').doc();

    const result = await db.runTransaction(async (transaction) => {
      const idempotencyDoc = await transaction.get(idempotencyRef);
      if (idempotencyDoc.exists) {
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

    return res.status(200).send('OK');
  } catch (error) {
    console.error('[S2S Postback Exception] Transaction failed:', error);
    return res.status(500).send('INTERNAL_SERVER_ERROR');
  }
});

app.get('/health', (req, res) => res.status(200).send('OK'));

app.listen(PORT, () => {
  console.log(`[Server] S2S Postback Listener running on port ${PORT}`);
});
