import { Router } from "express";
import { verifyLegalAccount } from "@/middleware/verifyToken";
import { RATE_RULES, rateLimit } from "@/lib/rate-limit";
import { acceptLegalDocuments, getLegalCatalog, getLegalDocument, getMyLegalStatus } from "@/controllers/legal.controller";

/**
 * Documents juridiques. Les textes sont publics ; statut et acceptation sont
 * les seules routes connectées ouvertes à un compte qui n'a pas encore accepté.
 */
const router = Router();

router.get("/", getLegalCatalog);
router.get("/documents/:slug", getLegalDocument);
router.get("/status", verifyLegalAccount, getMyLegalStatus);
router.post("/acceptance", verifyLegalAccount, rateLimit(RATE_RULES.sensitive), acceptLegalDocuments);

export default router;
