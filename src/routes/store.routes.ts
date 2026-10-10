import { Router } from "express";
import { verifyToken } from "@/middleware/verifyToken";
import { requirePermission } from "@/middleware/requirePermission";
import { getAllStores, createStore } from "@/controllers/store.controller";

const router = Router();

router.get("/", verifyToken, getAllStores);
router.post("/", verifyToken, requirePermission("store:manage"), createStore);

export default router;
