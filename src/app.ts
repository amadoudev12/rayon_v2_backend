import cookieParser from "cookie-parser";
import cors from "cors";
import express from "express";
import { allowedOrigins } from "@/env";
import { requestContext } from "@/lib/http/context";
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
import stockRoutes from "@/routes/stock.routes";
import storeRoutes from "@/routes/store.routes";
import supplierRoutes from "@/routes/supplier.routes";

export function createApp() {
  const app = express();
  app.disable("x-powered-by");
  app.set("etag", false);

  // Middlewares appliqués à toutes les requêtes
  app.use(securityHeaders);
  app.use(cors({ origin: allowedOrigins(), credentials: true }));
  app.use(cookieParser());
  app.use(express.json({ limit: "1mb" }));
  app.use(requestContext);
  app.use(verifyOrigin);

  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  // Routes
  app.use("/api/admin", adminRoutes);
  app.use("/api/pages", pageRoutes);
  // Connexion, session, inscription, profil, onboarding
  app.use("/api", authRoutes);
  app.use("/api/organization", organizationRoutes);
  app.use("/api/stores", storeRoutes);
  app.use("/api/members", memberRoutes);
  app.use("/api/categories", categoryRoutes);
  app.use("/api/products", productRoutes);
  app.use("/api/stock", stockRoutes);
  app.use("/api/dashboard", dashboardRoutes);
  app.use("/api/sales", saleRoutes);
  app.use("/api/purchases", purchaseRoutes);
  app.use("/api/quotes", quoteRoutes);
  app.use("/api/customers", customerRoutes);
  app.use("/api/suppliers", supplierRoutes);
  app.use("/api/expenses", expenseRoutes);

  app.use((_req, res) => {
    res.status(404).json({ message: "Ressource introuvable" });
  });
  // Middleware d'erreur : doit être en dernier
  app.use(errorHandler);

  return app;
}
