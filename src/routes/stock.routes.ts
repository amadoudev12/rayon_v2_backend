import { Router } from "express";
import { verifyToken } from "@/middleware/verifyToken";
import { getStock, getStockMovements } from "@/controllers/stock.controller";

const router = Router();

router.get("/", verifyToken, getStock);
router.get("/movements", verifyToken, getStockMovements);

export default router;
