import { describe, it, expect } from 'vitest'
import { hasFeature, getRequiredPlan } from '../features'

describe('hasFeature', () => {
  it('starter no tiene multiLocation', () => {
    expect(hasFeature('starter', 'multiLocation')).toBe(false)
  })
  it('growth tiene multiLocation', () => {
    expect(hasFeature('growth', 'multiLocation')).toBe(true)
  })
  it('starter no tiene aiAssistant', () => {
    expect(hasFeature('starter', 'aiAssistant')).toBe(false)
  })
  it('pro tiene aiAssistant', () => {
    expect(hasFeature('pro', 'aiAssistant')).toBe(true)
  })
  it('plan desconocido retorna false', () => {
    expect(hasFeature('unknown', 'multiLocation')).toBe(false)
  })
})

describe('getRequiredPlan', () => {
  it('multiLocation requiere growth', () => {
    expect(getRequiredPlan('multiLocation')).toBe('growth')
  })
  it('aiAssistant requiere pro', () => {
    expect(getRequiredPlan('aiAssistant')).toBe('pro')
  })
})
