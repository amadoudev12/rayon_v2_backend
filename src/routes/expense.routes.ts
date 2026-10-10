import { Router } from "express";
import { verifyToken } from "@/middleware/verifyToken";
import { requirePermission } from "@/middleware/requirePermission";
import { getAllExpenses, createExpense, deleteExpense } from "@/controllers/expense.controller";

const router = Router();

router.get("/", verifyToken, getAllExpenses);
router.post("/", verifyToken, requirePermission("expense:manage"), createExpense);
router.delete("/:id", verifyToken, requirePermission("expense:manage"), deleteExpense);

export default router;
