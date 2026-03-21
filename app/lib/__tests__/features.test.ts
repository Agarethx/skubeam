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

describe('plan bsale', () => {
  it('bsale tiene bsaleSync', () => {
    expect(hasFeature('bsale', 'bsaleSync')).toBe(true)
  })
  it('bsale tiene bsaleDocuments', () => {
    expect(hasFeature('bsale', 'bsaleDocuments')).toBe(true)
  })
  it('bsale no tiene forecast', () => {
    expect(hasFeature('bsale', 'forecast')).toBe(false)
  })
  it('bsale no tiene analytics', () => {
    expect(hasFeature('bsale', 'analytics')).toBe(false)
  })
  it('starter tiene forecast', () => {
    expect(hasFeature('starter', 'forecast')).toBe(true)
  })
  it('starter tiene bsaleSync', () => {
    expect(hasFeature('starter', 'bsaleSync')).toBe(true)
  })
  it('bsaleSync requiere plan bsale como mínimo', () => {
    expect(getRequiredPlan('bsaleSync')).toBe('bsale')
  })
  it('forecast requiere plan starter como mínimo', () => {
    expect(getRequiredPlan('forecast')).toBe('starter')
  })
})
