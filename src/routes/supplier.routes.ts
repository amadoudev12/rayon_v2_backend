import { Router } from "express";
import { requireFeature } from "@/services/billing/entitlements";
import { verifyToken } from "@/middleware/verifyToken";
import { requirePermission } from "@/middleware/requirePermission";
import {
  getAllSuppliers,
  createSupplier,
  updateSupplier,
  deleteSupplier,
  restoreSupplierHandler,
} from "@/controllers/supplier.controller";

const router = Router();

router.get("/", verifyToken, getAllSuppliers);
router.post("/", verifyToken, requirePermission("supplier:manage"), requireFeature("suppliers"), createSupplier);
router.put("/:id", verifyToken, requirePermission("supplier:manage"), requireFeature("suppliers"), updateSupplier);
// Supprimer (sans historique) ou archiver : réservé aux responsables.
router.delete("/:id", verifyToken, requirePermission("supplier:delete"), requireFeature("suppliers"), deleteSupplier);
router.post("/:id/restore", verifyToken, requirePermission("supplier:delete"), requireFeature("suppliers"), restoreSupplierHandler);

export default router;
