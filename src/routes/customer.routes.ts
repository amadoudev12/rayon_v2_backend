import { Router } from "express";
import { verifyToken } from "@/middleware/verifyToken";
import { requirePermission } from "@/middleware/requirePermission";
import {
  getAllCustomers,
  createCustomer,
  updateCustomer,
  deleteCustomer,
} from "@/controllers/customer.controller";

const router = Router();

router.get("/", verifyToken, getAllCustomers);
router.post("/", verifyToken, requirePermission("customer:manage"), createCustomer);
router.put("/:id", verifyToken, requirePermission("customer:manage"), updateCustomer);
router.delete("/:id", verifyToken, requirePermission("customer:manage"), deleteCustomer);

export default router;
