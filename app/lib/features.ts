export const PLAN_FEATURES = {
  starter: {
    maxSkus: 500,
    multiLocation: false,
    aiAssistant: false,
    multiErp: false,
    apiAccess: false,
  },
  growth: {
    maxSkus: 5000,
    multiLocation: true,
    aiAssistant: false,
    multiErp: false,
    apiAccess: false,
  },
  pro: {
    maxSkus: 10000,
    multiLocation: true,
    aiAssistant: true,
    multiErp: true,
    apiAccess: false,
  },
  enterprise: {
    maxSkus: Infinity,
    multiLocation: true,
    aiAssistant: true,
    multiErp: true,
    apiAccess: true,
  },
} as const

export type Plan = keyof typeof PLAN_FEATURES
export type PlanFeatures = (typeof PLAN_FEATURES)[Plan]
export type FeatureKey = keyof PlanFeatures

export function hasFeature(plan: string, feature: FeatureKey): boolean {
  const planFeatures = PLAN_FEATURES[plan as Plan]
  if (!planFeatures) return false
  const value = planFeatures[feature]
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value > 0
  return false
}

export function getRequiredPlan(feature: FeatureKey): Plan {
  const plans: Plan[] = ['starter', 'growth', 'pro', 'enterprise']
  for (const plan of plans) {
    if (hasFeature(plan, feature)) return plan
  }
  return 'enterprise'
}

export const PLAN_PRICES: Record<Plan, number> = {
  starter: 29,
  growth: 69,
  pro: 129,
  enterprise: 199,
}
