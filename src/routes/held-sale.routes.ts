import { Router } from "express";
import { verifyToken } from "@/middleware/verifyToken";
import { requirePermission } from "@/middleware/requirePermission";
import { RATE_RULES, rateLimit } from "@/lib/rate-limit";
import * as controller from "@/controllers/held-sale.controller";

/** Ventes en attente : mêmes rôles que l'encaissement. */
const router = Router();
const sensitiveRate = rateLimit(RATE_RULES.sensitive);

router.get("/", verifyToken, requirePermission("sale:create"), controller.list);
router.post("/", verifyToken, requirePermission("sale:create"), sensitiveRate, controller.create);
router.post("/:id/resume", verifyToken, requirePermission("sale:create"), controller.resume);
router.delete("/:id", verifyToken, requirePermission("sale:create"), controller.remove);

export default router;
