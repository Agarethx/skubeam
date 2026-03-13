// Shared plan constants — safe to import in both server and client code.
// Server-only billing logic (createSubscription, checkBilling, etc.) stays in billing.server.ts.

export const PLANS = {
  starter: { name: "Starter", amount: 29,  currencyCode: "USD", interval: "EVERY_30_DAYS", trialDays: 14 },
  growth:  { name: "Growth",  amount: 69,  currencyCode: "USD", interval: "EVERY_30_DAYS", trialDays: 14 },
  pro:     { name: "Pro",     amount: 129, currencyCode: "USD", interval: "EVERY_30_DAYS", trialDays: 14 },
} as const;

export type PlanKey = keyof typeof PLANS;

/** SKU limits enforced per plan. */
export const SKU_LIMITS: Record<string, number> = {
  trial:   500,
  starter: 500,
  growth:  5_000,
  pro:     10_000,
};

export const PLAN_FEATURES: Record<string, string[]> = {
  starter: [
    `Hasta ${SKU_LIMITS.starter.toLocaleString()} SKUs`,
    "Sync bidireccional Bsale ↔ Shopify",
    "Forecast & Replenishment",
    "Analytics ABC",
    "Soporte por email",
  ],
  growth: [
    `Hasta ${SKU_LIMITS.growth.toLocaleString()} SKUs`,
    "Todo lo de Starter",
    "Dashboard de analytics avanzado",
    "Exportar reportes CSV",
    "Soporte prioritario",
  ],
  pro: [
    `Hasta ${SKU_LIMITS.pro.toLocaleString()} SKUs`,
    "Todo lo de Growth",
    "Múltiples integraciones ERP",
    "API access",
    "Soporte dedicado",
  ],
};
