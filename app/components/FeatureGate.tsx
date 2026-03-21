import { useTranslation } from 'react-i18next'
import { hasFeature, getRequiredPlan, PLAN_PRICES } from '../lib/features'
import type { FeatureKey } from '../lib/features'
import { useSkuBeamNavigate } from '../lib/navigate'

interface FeatureGateProps {
  feature: FeatureKey
  plan: string
  children: React.ReactNode
}

/** Feature keys where a bsale-plan user gets a specific "$5 more" upsell to Starter. */
const BSALE_UPSELL_FEATURES: FeatureKey[] = ['forecast', 'analytics', 'csvExport', 'wooMigration']

interface UpsellMessage {
  description: string
  cta:         string
  targetPlan:  string
}

function getUpsellMessage(currentPlan: string, feature: FeatureKey): UpsellMessage | null {
  if (currentPlan === 'bsale' && BSALE_UPSELL_FEATURES.includes(feature)) {
    return {
      description: 'Ya tienes la integración Bsale activa. Mejora a Starter por solo $5 más para acceder a esta función.',
      cta:         'Mejorar a Starter ($30/mes)',
      targetPlan:  'starter',
    }
  }
  return null
}

export function FeatureGate({ feature, plan, children }: FeatureGateProps) {
  const { t } = useTranslation()
  const navigate = useSkuBeamNavigate()

  if (hasFeature(plan, feature)) {
    return <>{children}</>
  }

  const upsell       = getUpsellMessage(plan, feature)
  const requiredPlan = getRequiredPlan(feature)
  const price        = PLAN_PRICES[requiredPlan]

  const description = upsell?.description ?? t(`features.${feature}.description`)
  const cta         = upsell?.cta         ?? t('features.upgradeCta')

  return (
    <s-box padding="large" borderWidth="small" borderRadius="base" background="base">
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '16px', textAlign: 'center' }}>
        <s-badge tone="warning">
          {upsell
            ? `Plan ${upsell.targetPlan} ($${PLAN_PRICES[upsell.targetPlan as keyof typeof PLAN_PRICES]}/mes)`
            : t('features.requiredPlan', { plan: requiredPlan, price })}
        </s-badge>
        <s-text>
          <strong>🔒 {t(`features.${feature}.title`)}</strong>
        </s-text>
        <s-text color="subdued">
          {description}
        </s-text>
        <s-button variant="primary" onClick={() => navigate('/app/billing')}>
          {cta}
        </s-button>
      </div>
    </s-box>
  )
}
