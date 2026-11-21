import { Router } from "express";
import { verifyTokenAllowingReadOnly } from "@/middleware/verifyToken";
import { requirePermission } from "@/middleware/requirePermission";
import { RATE_RULES, rateLimit } from "@/lib/rate-limit";
import {
  deleteScheduledChange,
  getSubscription,
  getPaymentById,
  getPayments,
  getReceiptById,
  getReceipts,
  getSubscriptionHistory,
  postCancelPayment,
  postPayment,
  postQuote,
  postScheduledChange,
} from "@/controllers/billing.controller";

/**
 * Abonnement de l'organisation connectée. Ouvert en lecture seule (le
 * renouvellement doit rester possible) ; consultation pour tous les membres,
 * actions réservées au propriétaire.
 */
const router = Router();
const paymentRate = rateLimit(RATE_RULES.sensitive);

router.get("/", verifyTokenAllowingReadOnly, getSubscription);
router.get("/history", verifyTokenAllowingReadOnly, requirePermission("subscription:manage"), getSubscriptionHistory);
router.post("/quote", verifyTokenAllowingReadOnly, requirePermission("subscription:manage"), postQuote);
router.post("/scheduled-change", verifyTokenAllowingReadOnly, requirePermission("subscription:manage"), postScheduledChange);
router.delete("/scheduled-change", verifyTokenAllowingReadOnly, requirePermission("subscription:manage"), deleteScheduledChange);
// Paiements et reçus : propriétaire uniquement, ouverts en lecture seule (renouvellement).
router.post("/payments", verifyTokenAllowingReadOnly, requirePermission("subscription:manage"), paymentRate, postPayment);
router.get("/payments", verifyTokenAllowingReadOnly, requirePermission("subscription:manage"), getPayments);
router.get("/payments/:id", verifyTokenAllowingReadOnly, requirePermission("subscription:manage"), getPaymentById);
router.post("/payments/:id/cancel", verifyTokenAllowingReadOnly, requirePermission("subscription:manage"), postCancelPayment);
router.get("/receipts", verifyTokenAllowingReadOnly, requirePermission("subscription:manage"), getReceipts);
router.get("/receipts/:id", verifyTokenAllowingReadOnly, requirePermission("subscription:manage"), getReceiptById);

export default router;
