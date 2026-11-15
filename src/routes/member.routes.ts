import { Router } from "express";
import { verifyToken } from "@/middleware/verifyToken";
import { requirePermission } from "@/middleware/requirePermission";
import { getAllMembers, createMember, deleteMember, resetPassword } from "@/controllers/member.controller";
import { RATE_RULES, rateLimit } from "@/lib/rate-limit";

const router = Router();

router.get("/", verifyToken, requirePermission("members:manage"), getAllMembers);
router.post("/", verifyToken, requirePermission("members:manage"), createMember);
router.delete("/:id", verifyToken, requirePermission("members:manage"), deleteMember);
router.post("/:id/reset-password", verifyToken, requirePermission("members:manage"), rateLimit(RATE_RULES.passwordReset), resetPassword);

export default router;
