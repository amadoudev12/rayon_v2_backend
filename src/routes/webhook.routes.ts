import express, { Router, type Request, type Response } from "express";
import { handleProviderWebhook } from "@/services/billing/webhooks";

/**
 * `POST /api/webhooks/payments/:provider` : notifications des prestataires.
 * Le corps reste brut (Buffer) pour que l'adaptateur vérifie la signature
 * exactement sur les octets reçus. Réponse minimale, sans détail interne.
 */
const router = Router();

router.post("/payments/:provider", express.raw({ type: () => true, limit: "256kb" }), async (req: Request, res: Response) => {
  const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  const outcome = await handleProviderWebhook(String(req.params.provider), body, req.headers);
  res.json({ received: true, status: outcome.status });
});

export default router;
