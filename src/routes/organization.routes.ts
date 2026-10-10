import { Router } from "express";
import { verifyToken } from "@/middleware/verifyToken";
import { requirePermission } from "@/middleware/requirePermission";
import { getOrganization, updateOrganization } from "@/controllers/organization.controller";

const router = Router();

router.get("/", verifyToken, getOrganization);
router.put("/", verifyToken, requirePermission("org:manage"), updateOrganization);

export default router;
