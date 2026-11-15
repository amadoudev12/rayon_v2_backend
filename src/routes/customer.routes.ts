import { Router } from "express";
import { verifyToken } from "@/middleware/verifyToken";
import { requirePermission } from "@/middleware/requirePermission";
import {
  getAllCustomers,
  createCustomer,
  updateCustomer,
  deleteCustomer,
  restoreCustomerHandler,
} from "@/controllers/customer.controller";

const router = Router();

router.get("/", verifyToken, getAllCustomers);
router.post("/", verifyToken, requirePermission("customer:manage"), createCustomer);
router.put("/:id", verifyToken, requirePermission("customer:manage"), updateCustomer);
// Supprimer (sans historique) ou archiver : réservé aux responsables.
router.delete("/:id", verifyToken, requirePermission("customer:delete"), deleteCustomer);
router.post("/:id/restore", verifyToken, requirePermission("customer:delete"), restoreCustomerHandler);

export default router;
