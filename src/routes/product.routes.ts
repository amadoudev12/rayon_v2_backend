import { Router } from "express";
import { verifyToken } from "@/middleware/verifyToken";
import { requirePermission } from "@/middleware/requirePermission";
import {
  getAllProducts,
  createProduct,
  importProducts,
  getProductById,
  updateProduct,
  deleteProduct,
} from "@/controllers/product.controller";
import { adjustStock } from "@/controllers/stock.controller";

const router = Router();

router.get("/", verifyToken, getAllProducts);
router.post("/", verifyToken, requirePermission("product:manage"), createProduct);
router.post("/import", verifyToken, requirePermission("product:manage"), importProducts);
router.get("/:id", verifyToken, getProductById);
router.put("/:id", verifyToken, requirePermission("product:manage"), updateProduct);
router.delete("/:id", verifyToken, requirePermission("product:manage"), deleteProduct);
router.post("/:id/stock", verifyToken, requirePermission("stock:adjust"), adjustStock);

export default router;
