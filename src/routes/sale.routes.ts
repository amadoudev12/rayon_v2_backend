import { Router } from "express";
import { verifyToken } from "@/middleware/verifyToken";
import { requirePermission } from "@/middleware/requirePermission";
import {
  getAllSales,
  createSale,
  getSaleById,
  cancelSale,
} from "@/controllers/sale.controller";

const router = Router();

router.get("/", verifyToken, getAllSales);
router.post("/", verifyToken, requirePermission("sale:create"), createSale);
router.get("/:id", verifyToken, getSaleById);
router.post("/:id/cancel", verifyToken, requirePermission("sale:cancel"), cancelSale);

export default router;
