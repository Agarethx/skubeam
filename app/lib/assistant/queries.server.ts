import { supabaseAdmin } from '../../db.server'

export async function getSkusForAssistant(shopId: string, options?: {
  filter?: 'critical' | 'low' | 'dead_stock' | 'all'
  limit?: number
  orderBy?: 'stock_asc' | 'stock_desc' | 'velocity_desc'
}) {
  let query = supabaseAdmin
    .from('sku_analytics')
    .select('sku_code, title, total_stock, sold_30d, sold_90d, last_sold_at')
    .eq('shop_id', shopId)

  if (options?.filter === 'critical') {
    query = query.lte('total_stock', 0)
  } else if (options?.filter === 'low') {
    query = query.gt('total_stock', 0).lte('total_stock', 5)
  } else if (options?.filter === 'dead_stock') {
    query = query.eq('sold_30d', 0).gt('total_stock', 0)
  }

  if (options?.orderBy === 'stock_asc') query = query.order('total_stock', { ascending: true })
  else if (options?.orderBy === 'stock_desc') query = query.order('total_stock', { ascending: false })
  else if (options?.orderBy === 'velocity_desc') query = query.order('sold_30d', { ascending: false })

  query = query.limit(options?.limit ?? 20)
  const { data } = await query
  return data ?? []
}

export async function getKpisForAssistant(shopId: string) {
  const { data } = await supabaseAdmin
    .from('sku_analytics')
    .select('total_stock, cost_price, sold_30d')
    .eq('shop_id', shopId)

  if (!data?.length) return null

  return {
    totalSkus: data.length,
    totalValue: data.reduce((sum: number, s) => sum + (s.total_stock * (s.cost_price ?? 0)), 0),
    criticalSkus: data.filter((s) => s.total_stock <= 0).length,
    lowStockSkus: data.filter((s) => s.total_stock > 0 && s.total_stock <= 5).length,
    avgVelocity: data.reduce((sum: number, s) => sum + (s.sold_30d ?? 0), 0) / data.length,
  }
}

export async function getForecastForAssistant(shopId: string) {
  const { data } = await supabaseAdmin
    .from('sku_analytics')
    .select('sku_code, title, total_stock, sold_30d, sold_90d')
    .eq('shop_id', shopId)
    .not('sold_30d', 'is', null)
    .gt('sold_30d', 0)
    .order('sold_30d', { ascending: false })
    .limit(10)

  return data ?? []
}

export async function getSalesForAssistant(shopId: string, days: 7 | 14 | 30 | 90 = 30) {
  const since = new Date()
  since.setDate(since.getDate() - days)

  const { data } = await supabaseAdmin
    .from('sales_history')
    .select('sku_id, quantity_sold, revenue, sold_at, skus(sku_code, title)')
    .eq('shop_id', shopId)
    .gte('sold_at', since.toISOString())
    .order('quantity_sold', { ascending: false })
    .limit(20)

  return data ?? []
}
