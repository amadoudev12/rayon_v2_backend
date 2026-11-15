import { Router } from "express";
import { verifyToken } from "@/middleware/verifyToken";
import { requirePermission } from "@/middleware/requirePermission";
import { exportCredits, exportPurchases, exportSales, exportStock } from "@/controllers/export.controller";

/** Exports CSV : mêmes permissions que les écrans correspondants. */
const router = Router();

router.get("/sales", verifyToken, exportSales);
router.get("/credits", verifyToken, exportCredits);
router.get("/purchases", verifyToken, requirePermission("purchase:manage"), exportPurchases);
router.get("/stock", verifyToken, requirePermission("stock:report"), exportStock);

export default router;
