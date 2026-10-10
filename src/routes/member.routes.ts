import { Router } from "express";
import { verifyToken } from "@/middleware/verifyToken";
import { requirePermission } from "@/middleware/requirePermission";
import { getAllMembers, createMember, deleteMember } from "@/controllers/member.controller";

const router = Router();

router.get("/", verifyToken, requirePermission("members:manage"), getAllMembers);
router.post("/", verifyToken, requirePermission("members:manage"), createMember);
router.delete("/:id", verifyToken, requirePermission("members:manage"), deleteMember);

export default router;
