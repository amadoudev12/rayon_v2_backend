import { Router } from "express";
import { verifyToken } from "@/middleware/verifyToken";
import { requirePermission } from "@/middleware/requirePermission";
import {
  getAllCategories,
  createCategory,
  updateCategory,
  deleteCategory,
} from "@/controllers/category.controller";

const router = Router();

router.get("/", verifyToken, getAllCategories);
router.post("/", verifyToken, requirePermission("category:manage"), createCategory);
router.put("/:id", verifyToken, requirePermission("category:manage"), updateCategory);
router.delete("/:id", verifyToken, requirePermission("category:manage"), deleteCategory);

export default router;
