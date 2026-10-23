import { Router } from "express";
import { verifyToken } from "@/middleware/verifyToken";
import { requirePermission } from "@/middleware/requirePermission";
import { getAllQuotes, createQuote, getQuoteById, deleteQuote } from "@/controllers/quote.controller";

const router = Router();

router.get("/", verifyToken, getAllQuotes);
router.post("/", verifyToken, requirePermission("sale:create"), createQuote);
router.get("/:id", verifyToken, getQuoteById);
router.delete("/:id", verifyToken, requirePermission("sale:cancel"), deleteQuote);

export default router;
