import type { Tool } from '@anthropic-ai/sdk/resources'

export const ASSISTANT_TOOLS: Tool[] = [
  {
    name: 'get_skus',
    description: 'Obtiene la lista de SKUs del inventario con stock y velocidad de ventas. Usar para preguntas sobre stock, productos críticos, dead stock.',
    input_schema: {
      type: 'object' as const,
      properties: {
        filter: {
          type: 'string',
          enum: ['critical', 'low', 'dead_stock', 'all'],
          description: 'critical=sin stock, low=stock bajo (<=5), dead_stock=sin ventas en 30 días, all=todos'
        },
        limit: { type: 'number', description: 'Máximo de SKUs a retornar (default 20)' },
        orderBy: {
          type: 'string',
          enum: ['stock_asc', 'stock_desc', 'velocity_desc'],
          description: 'Ordenar por stock ascendente, descendente, o por velocidad de ventas'
        }
      }
    }
  },
  {
    name: 'get_kpis',
    description: 'Obtiene KPIs generales del inventario: total SKUs, valor total, SKUs críticos, promedio de velocidad. Usar para resúmenes generales.',
    input_schema: {
      type: 'object' as const,
      properties: {}
    }
  },
  {
    name: 'get_forecast',
    description: 'Obtiene los SKUs con mayor velocidad de ventas. Usar para preguntas sobre reposición y productos más vendidos.',
    input_schema: {
      type: 'object' as const,
      properties: {}
    }
  },
  {
    name: 'get_sales',
    description: 'Obtiene el historial de ventas recientes. Usar para preguntas sobre productos más vendidos, tendencias, rendimiento.',
    input_schema: {
      type: 'object' as const,
      properties: {
        days: {
          type: 'number',
          enum: [7, 14, 30, 90],
          description: 'Período de análisis en días (default 30)'
        }
      }
    }
  }
]

export const SYSTEM_PROMPT = `Eres SkuBeam AI, un asistente especializado en gestión de inventario para tiendas Shopify en LATAM.

Tienes acceso a los datos de inventario en tiempo real del merchant a través de las tools disponibles.

Instrucciones:
- Responde siempre en el mismo idioma que el usuario (español o inglés)
- Sé conciso y directo — máximo 3-4 párrafos
- Cuando muestres listas de productos, usa formato de tabla o lista numerada
- Siempre termina con UNA recomendación accionable concreta
- Si no tienes suficientes datos, dilo claramente
- Los precios están en la moneda local del merchant`
