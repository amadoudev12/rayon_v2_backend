import { Router } from "express";
import { verifyToken } from "@/middleware/verifyToken";
import { requirePermission } from "@/middleware/requirePermission";
import { RATE_RULES, rateLimit } from "@/lib/rate-limit";
import {
  getAllSales,
  createSale,
  getSaleById,
  cancelSale,
  getSalesStatsSummary,
  addSalePayment,
  returnSaleItems,
  makeRefundPayout,
} from "@/controllers/sale.controller";

// Limites par utilisateur : largement au-dessus d'un usage normal en caisse,
// elles bloquent un script ou un appareil compromis qui enverrait en rafale.
const saleRate = rateLimit(RATE_RULES.saleCreate);
const sensitiveRate = rateLimit(RATE_RULES.sensitive);

const router = Router();

router.get("/", verifyToken, getAllSales);
router.post("/", verifyToken, requirePermission("sale:create"), saleRate, createSale);
router.get("/stats", verifyToken, getSalesStatsSummary);
router.get("/:id", verifyToken, getSaleById);
router.post("/:id/cancel", verifyToken, requirePermission("sale:cancel"), sensitiveRate, cancelSale);
// Encaisser un versement est un geste de caisse : mêmes rôles que la vente.
router.post("/:id/payments", verifyToken, requirePermission("sale:create"), sensitiveRate, addSalePayment);
// Retour d'articles : avoir, remise en stock éventuelle et remboursement de l'excédent payé.
router.post("/:id/returns", verifyToken, requirePermission("return:manage"), sensitiveRate, returnSaleItems);
router.post("/refunds/:id/payouts", verifyToken, requirePermission("refund:manage"), sensitiveRate, makeRefundPayout);

export default router;
