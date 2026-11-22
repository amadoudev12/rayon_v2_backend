import cookieParser from "cookie-parser";
import cors from "cors";
import express from "express";
import { allowedOrigins, trustProxyHops } from "@/env";
import { requestContext } from "@/lib/http/context";
import { log, requestLogger } from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import { errorHandler } from "@/middleware/errorHandler";
import { securityHeaders, verifyOrigin } from "@/middleware/security";
import adminRoutes from "@/routes/admin.routes";
import authRoutes from "@/routes/auth.routes";
import categoryRoutes from "@/routes/category.routes";
import customerRoutes from "@/routes/customer.routes";
import dashboardRoutes from "@/routes/dashboard.routes";
import expenseRoutes from "@/routes/expense.routes";
import memberRoutes from "@/routes/member.routes";
import organizationRoutes from "@/routes/organization.routes";
import pageRoutes from "@/routes/page.routes";
import productRoutes from "@/routes/product.routes";
import purchaseRoutes from "@/routes/purchase.routes";
import quoteRoutes from "@/routes/quote.routes";
import saleRoutes from "@/routes/sale.routes";
import heldSaleRoutes from "@/routes/held-sale.routes";
import stockRoutes from "@/routes/stock.routes";
import inventoryRoutes from "@/routes/inventory.routes";
import lossRoutes from "@/routes/loss.routes";
import storeRoutes from "@/routes/store.routes";
import subscriptionRoutes from "@/routes/subscription.routes";
import notificationRoutes from "@/routes/notification.routes";
import webhookRoutes from "@/routes/webhook.routes";
import supplierRoutes from "@/routes/supplier.routes";
import exportRoutes from "@/routes/export.routes";

export function createApp() {
  const app = express();
  app.disable("x-powered-by");
  app.set("etag", false);
  app.set("trust proxy", trustProxyHops());

  // Middlewares appliqués à toutes les requêtes
  app.use(securityHeaders);
  app.use(cors({ origin: allowedOrigins(), credentials: true }));
  app.use(cookieParser());
  app.use(requestContext);
  app.use(requestLogger);
  // Notifications des prestataires de paiement : corps BRUT (vérification de
  // signature), avant l'analyse JSON ; jamais de session ni de cookie.
  app.use("/api/webhooks", webhookRoutes);
  app.use(express.json({ limit: "1mb" }));
  app.use(verifyOrigin);

  // Vivacité : le processus répond (pour le redémarrage automatique).
  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });
  // Disponibilité : la base répond aussi (pour la supervision et le répartiteur de charge).
  app.get("/health/ready", async (_req, res) => {
    const started = Date.now();
    try {
      await prisma.$queryRaw`SELECT 1`;
      res.json({ status: "ok", database: "ok", latencyMs: Date.now() - started });
    } catch {
      log("error", "health.database_unreachable");
      res.status(503).json({ status: "degraded", database: "unreachable" });
    }
  });

  // Routes
  app.use("/api/admin", adminRoutes);
  app.use("/api/pages", pageRoutes);
  // Connexion, session, inscription, profil, onboarding
  app.use("/api", authRoutes);
  app.use("/api/organization", organizationRoutes);
  app.use("/api/subscription", subscriptionRoutes);
  app.use("/api/notifications", notificationRoutes);
  app.use("/api/stores", storeRoutes);
  app.use("/api/members", memberRoutes);
  app.use("/api/categories", categoryRoutes);
  app.use("/api/products", productRoutes);
  app.use("/api/stock", stockRoutes);
  app.use("/api/inventories", inventoryRoutes);
  app.use("/api/losses", lossRoutes);
  app.use("/api/dashboard", dashboardRoutes);
  app.use("/api/sales", saleRoutes);
  app.use("/api/held-sales", heldSaleRoutes);
  app.use("/api/purchases", purchaseRoutes);
  app.use("/api/quotes", quoteRoutes);
  app.use("/api/customers", customerRoutes);
  app.use("/api/suppliers", supplierRoutes);
  app.use("/api/expenses", expenseRoutes);
  app.use("/api/exports", exportRoutes);

  app.use((_req, res) => {
    res.status(404).json({ message: "Ressource introuvable" });
  });
  // Middleware d'erreur : doit être en dernier
  app.use(errorHandler);

  return app;
}
