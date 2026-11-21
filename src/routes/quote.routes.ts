import { Router } from "express";
import { requireFeature } from "@/services/billing/entitlements";
import { verifyToken } from "@/middleware/verifyToken";
import { requirePermission } from "@/middleware/requirePermission";
import { getAllQuotes, createQuote, getQuoteById, deleteQuote } from "@/controllers/quote.controller";

const router = Router();

router.get("/", verifyToken, getAllQuotes);
router.post("/", verifyToken, requirePermission("sale:create"), requireFeature("quotes"), createQuote);
router.get("/:id", verifyToken, getQuoteById);
router.delete("/:id", verifyToken, requirePermission("sale:cancel"), requireFeature("quotes"), deleteQuote);

export default router;
