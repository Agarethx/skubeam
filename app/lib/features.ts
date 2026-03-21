export const PLAN_FEATURES = {
  bsale: {
    maxSkus:        500,
    bsaleSync:      true,
    bsaleDocuments: true,
    forecast:       false,
    analytics:      false,
    csvExport:      false,
    wooMigration:   false,
    multiLocation:  false,
    aiAssistant:    false,
    multiErp:       false,
    apiAccess:      false,
  },
  starter: {
    maxSkus:        500,
    bsaleSync:      true,
    bsaleDocuments: true,
    forecast:       true,
    analytics:      true,
    csvExport:      true,
    wooMigration:   true,
    multiLocation:  false,
    aiAssistant:    false,
    multiErp:       false,
    apiAccess:      false,
  },
  growth: {
    maxSkus:        5000,
    bsaleSync:      true,
    bsaleDocuments: true,
    forecast:       true,
    analytics:      true,
    csvExport:      true,
    wooMigration:   true,
    multiLocation:  true,
    aiAssistant:    false,
    multiErp:       false,
    apiAccess:      false,
  },
  pro: {
    maxSkus:        10000,
    bsaleSync:      true,
    bsaleDocuments: true,
    forecast:       true,
    analytics:      true,
    csvExport:      true,
    wooMigration:   true,
    multiLocation:  true,
    aiAssistant:    true,
    multiErp:       true,
    apiAccess:      false,
  },
  enterprise: {
    maxSkus:        Infinity,
    bsaleSync:      true,
    bsaleDocuments: true,
    forecast:       true,
    analytics:      true,
    csvExport:      true,
    wooMigration:   true,
    multiLocation:  true,
    aiAssistant:    true,
    multiErp:       true,
    apiAccess:      true,
  },
} as const

export type Plan = keyof typeof PLAN_FEATURES
export type PlanFeatures = (typeof PLAN_FEATURES)[Plan]
export type FeatureKey = keyof PlanFeatures

const PLAN_ORDER: Plan[] = ['bsale', 'starter', 'growth', 'pro', 'enterprise']

export function hasFeature(plan: string, feature: FeatureKey): boolean {
  const planFeatures = PLAN_FEATURES[plan as Plan]
  if (!planFeatures) return false
  const value = planFeatures[feature]
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value > 0
  return false
}

export function getRequiredPlan(feature: FeatureKey): Plan {
  for (const plan of PLAN_ORDER) {
    if (hasFeature(plan, feature)) return plan
  }
  return 'enterprise'
}

export const PLAN_PRICES: Record<Plan, number> = {
  bsale:      25,
  starter:    30,
  growth:     69,
  pro:        129,
  enterprise: 199,
}
