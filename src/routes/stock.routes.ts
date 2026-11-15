import { Router } from "express";
import { verifyToken } from "@/middleware/verifyToken";
import { getStock, getStockMovements, getStockAlerts, getStockValuation, setThreshold } from "@/controllers/stock.controller";
import { requirePermission } from "@/middleware/requirePermission";

const router = Router();

router.get("/", verifyToken, getStock);
router.get("/movements", verifyToken, requirePermission("stock-movement:read"), getStockMovements);
router.get("/alerts", verifyToken, requirePermission("stock:report"), getStockAlerts);
router.get("/valuation", verifyToken, requirePermission("stock:report"), getStockValuation);
router.put("/threshold", verifyToken, requirePermission("stock:threshold:manage"), setThreshold);

export default router;
