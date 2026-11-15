import { Router } from "express";
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
router.post("/", verifyToken, requirePermission("supplier:manage"), createSupplier);
router.put("/:id", verifyToken, requirePermission("supplier:manage"), updateSupplier);
// Supprimer (sans historique) ou archiver : réservé aux responsables.
router.delete("/:id", verifyToken, requirePermission("supplier:delete"), deleteSupplier);
router.post("/:id/restore", verifyToken, requirePermission("supplier:delete"), restoreSupplierHandler);

export default router;
