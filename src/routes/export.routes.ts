import { Router } from "express";
import { requireFeature } from "@/services/billing/entitlements";
import { verifyToken } from "@/middleware/verifyToken";
import { requirePermission } from "@/middleware/requirePermission";
import { exportCredits, exportMovements, exportPurchases, exportSales, exportStock } from "@/controllers/export.controller";

/** Exports CSV : mêmes permissions que les écrans correspondants ; inclus à partir du forfait BUSINESS. */
const router = Router();

router.get("/sales", verifyToken, requireFeature("csv_export"), exportSales);
router.get("/credits", verifyToken, requireFeature("csv_export"), exportCredits);
router.get("/purchases", verifyToken, requireFeature("csv_export"), requirePermission("purchase:manage"), exportPurchases);
router.get("/stock", verifyToken, requireFeature("csv_export"), requirePermission("stock:report"), exportStock);
router.get("/movements", verifyToken, requireFeature("csv_export"), requirePermission("stock-movement:read"), exportMovements);

export default router;
