import { useTranslation } from 'react-i18next'
import { hasFeature, getRequiredPlan, PLAN_PRICES } from '../lib/features'
import type { FeatureKey } from '../lib/features'
import { useSkuBeamNavigate } from '../lib/navigate'

interface FeatureGateProps {
  feature: FeatureKey
  plan: string
  children: React.ReactNode
}

export function FeatureGate({ feature, plan, children }: FeatureGateProps) {
  const { t } = useTranslation()
  const navigate = useSkuBeamNavigate()

  if (hasFeature(plan, feature)) {
    return <>{children}</>
  }

  const requiredPlan = getRequiredPlan(feature)
  const price = PLAN_PRICES[requiredPlan]

  return (
    <s-box padding="large" borderWidth="small" borderRadius="base" background="base">
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '16px', textAlign: 'center' }}>
        <s-badge tone="warning">
          {t('features.requiredPlan', { plan: requiredPlan, price })}
        </s-badge>
        <s-text>
          <strong>🔒 {t(`features.${feature}.title`)}</strong>
        </s-text>
        <s-text color="subdued">
          {t(`features.${feature}.description`)}
        </s-text>
        <s-button variant="primary" onClick={() => navigate('/app/billing')}>
          {t('features.upgradeCta')}
        </s-button>
      </div>
    </s-box>
  )
}
