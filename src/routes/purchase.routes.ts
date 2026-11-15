import { Router } from "express";
import { verifyToken } from "@/middleware/verifyToken";
import { requirePermission } from "@/middleware/requirePermission";
import { RATE_RULES, rateLimit } from "@/lib/rate-limit";
import { addSupplierPayment, cancelPurchase, createPurchase, getAllPurchases, getPurchaseById } from "@/controllers/purchase.controller";

const router = Router();
const sensitiveRate = rateLimit(RATE_RULES.sensitive);

router.get("/", verifyToken, requirePermission("purchase:manage"), getAllPurchases);
router.post("/", verifyToken, requirePermission("purchase:manage"), sensitiveRate, createPurchase);
// Même règle que la page Achats : les coûts d'achat ne sont pas visibles des vendeurs.
router.get("/:id", verifyToken, requirePermission("purchase:manage"), getPurchaseById);
// Règlement d'une dette fournisseur.
router.post("/:id/payments", verifyToken, requirePermission("purchase:manage"), sensitiveRate, addSupplierPayment);
// Annulation (contre-mouvements de stock) : réservée aux responsables.
router.post("/:id/cancel", verifyToken, requirePermission("purchase:cancel"), sensitiveRate, cancelPurchase);

export default router;
