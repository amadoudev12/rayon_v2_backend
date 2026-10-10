import { Router } from "express";
import { verifyToken } from "@/middleware/verifyToken";
import { requirePermission } from "@/middleware/requirePermission";
import {
  getAllSuppliers,
  createSupplier,
  updateSupplier,
  deleteSupplier,
} from "@/controllers/supplier.controller";

const router = Router();

router.get("/", verifyToken, getAllSuppliers);
router.post("/", verifyToken, requirePermission("supplier:manage"), createSupplier);
router.put("/:id", verifyToken, requirePermission("supplier:manage"), updateSupplier);
router.delete("/:id", verifyToken, requirePermission("supplier:manage"), deleteSupplier);

export default router;
