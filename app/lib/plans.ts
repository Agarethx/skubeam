// Shared plan constants — safe to import in both server and client code.
// Server-only billing logic (createSubscription, checkBilling, etc.) stays in billing.server.ts.

export const PLANS = {
  bsale:   { name: "SkuBeam Bsale",   amount: 25,  currencyCode: "USD", interval: "EVERY_30_DAYS", trialDays: 14 },
  starter: { name: "SkuBeam Starter", amount: 30,  currencyCode: "USD", interval: "EVERY_30_DAYS", trialDays: 14 },
  growth:  { name: "Growth",          amount: 69,  currencyCode: "USD", interval: "EVERY_30_DAYS", trialDays: 14 },
  pro:     { name: "Pro",             amount: 129, currencyCode: "USD", interval: "EVERY_30_DAYS", trialDays: 14 },
} as const;

export type PlanKey = keyof typeof PLANS;

/** SKU limits enforced per plan. */
export const SKU_LIMITS: Record<string, number> = {
  trial:   500,
  bsale:   500,
  starter: 500,
  growth:  5_000,
  pro:     10_000,
};

export interface PlanFeatureItem {
  label:    string;
  included: boolean;
}

export const PLAN_FEATURES: Record<string, PlanFeatureItem[]> = {
  bsale: [
    { label: `Hasta ${SKU_LIMITS.bsale.toLocaleString()} SKUs`,   included: true  },
    { label: "Sync bidireccional Bsale ↔ Shopify",                included: true  },
    { label: "Boleta electrónica automática",                      included: true  },
    { label: "Forecast & Replenishment",                           included: false },
    { label: "Analytics ABC",                                      included: false },
    { label: "Exportar CSV",                                       included: false },
    { label: "Soporte por email",                                  included: true  },
  ],
  starter: [
    { label: `Hasta ${SKU_LIMITS.starter.toLocaleString()} SKUs`, included: true },
    { label: "Todo lo del plan Bsale",                             included: true },
    { label: "Forecast & Replenishment",                           included: true },
    { label: "Analytics ABC",                                      included: true },
    { label: "Exportar CSV",                                       included: true },
    { label: "Migración desde WooCommerce",                        included: true },
    { label: "Soporte por email",                                  included: true },
  ],
  growth: [
    { label: `Hasta ${SKU_LIMITS.growth.toLocaleString()} SKUs`,  included: true },
    { label: "Todo lo de Starter",                                 included: true },
    { label: "Inventario multi-sucursal",                          included: true },
    { label: "Dashboard de analytics avanzado",                    included: true },
    { label: "Soporte prioritario",                                included: true },
  ],
  pro: [
    { label: `Hasta ${SKU_LIMITS.pro.toLocaleString()} SKUs`,     included: true },
    { label: "Todo lo de Growth",                                  included: true },
    { label: "AI Assistant de inventario",                         included: true },
    { label: "Múltiples integraciones ERP",                        included: true },
    { label: "Soporte dedicado",                                   included: true },
  ],
};
