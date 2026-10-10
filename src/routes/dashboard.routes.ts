import { Router } from "express";
import { verifyToken } from "@/middleware/verifyToken";
import { getDashboard } from "@/controllers/dashboard.controller";

const router = Router();

router.get("/", verifyToken, getDashboard);

export default router;
