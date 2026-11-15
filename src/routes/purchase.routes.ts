import { Router } from "express";
import { verifyToken } from "@/middleware/verifyToken";
import { requirePermission } from "@/middleware/requirePermission";
import { getAllPurchases, createPurchase, getPurchaseById } from "@/controllers/purchase.controller";

const router = Router();

router.get("/", verifyToken, requirePermission("purchase:manage"), getAllPurchases);
router.post("/", verifyToken, requirePermission("purchase:manage"), createPurchase);
// Même règle que la page Achats : les coûts d'achat ne sont pas visibles des vendeurs.
router.get("/:id", verifyToken, requirePermission("purchase:manage"), getPurchaseById);

export default router;
