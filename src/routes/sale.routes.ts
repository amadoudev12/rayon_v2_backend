import { Router } from "express";
import { verifyToken } from "@/middleware/verifyToken";
import { requirePermission } from "@/middleware/requirePermission";
import {
  getAllSales,
  createSale,
  getSaleById,
  cancelSale,
  getSalesStatsSummary,
  addSalePayment,
} from "@/controllers/sale.controller";

const router = Router();

router.get("/", verifyToken, getAllSales);
router.post("/", verifyToken, requirePermission("sale:create"), createSale);
router.get("/stats", verifyToken, getSalesStatsSummary);
router.get("/:id", verifyToken, getSaleById);
router.post("/:id/cancel", verifyToken, requirePermission("sale:cancel"), cancelSale);
// Encaisser un versement est un geste de caisse : mêmes rôles que la vente.
router.post("/:id/payments", verifyToken, requirePermission("sale:create"), addSalePayment);

export default router;
