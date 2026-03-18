import type { ActionFunctionArgs } from 'react-router'
import Anthropic from '@anthropic-ai/sdk'
import { authenticate } from '../shopify.server'
import { ASSISTANT_TOOLS, SYSTEM_PROMPT } from '../lib/assistant/tools.server'
import {
  getSkusForAssistant,
  getKpisForAssistant,
  getForecastForAssistant,
  getSalesForAssistant,
} from '../lib/assistant/queries.server'

const client = new Anthropic()

export async function action({ request }: ActionFunctionArgs) {
  const { session } = await authenticate.admin(request)
  const shopId = session.shop

  if (!process.env.ANTHROPIC_API_KEY) {
    return Response.json({ reply: 'Error: ANTHROPIC_API_KEY no está configurada en el servidor.' }, { status: 500 })
  }

  const { messages } = await request.json() as { messages: Anthropic.MessageParam[] }

  try {
  // Primera llamada a Claude con tools
  let response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    tools: ASSISTANT_TOOLS,
    messages,
  })

  // Agentic loop — ejecutar tools hasta que Claude responda con texto
  while (response.stop_reason === 'tool_use') {
    const toolUseBlocks = response.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use'
    )
    const toolResults: Anthropic.ToolResultBlockParam[] = []

    for (const toolUse of toolUseBlocks) {
      let result: unknown

      try {
        if (toolUse.name === 'get_skus') {
          result = await getSkusForAssistant(shopId, toolUse.input as Parameters<typeof getSkusForAssistant>[1])
        } else if (toolUse.name === 'get_kpis') {
          result = await getKpisForAssistant(shopId)
        } else if (toolUse.name === 'get_forecast') {
          result = await getForecastForAssistant(shopId)
        } else if (toolUse.name === 'get_sales') {
          const input = toolUse.input as { days?: 7 | 14 | 30 | 90 }
          result = await getSalesForAssistant(shopId, input?.days ?? 30)
        }
      } catch (e) {
        result = { error: String(e) }
      }

      toolResults.push({
        type: 'tool_result' as const,
        tool_use_id: toolUse.id,
        content: JSON.stringify(result),
      })
    }

    // Continuar conversación con los resultados de las tools
    response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      tools: ASSISTANT_TOOLS,
      messages: [
        ...messages,
        { role: 'assistant', content: response.content },
        { role: 'user', content: toolResults },
      ],
    })
  }

  const textBlock = response.content.find((b): b is Anthropic.TextBlock => b.type === 'text')
  return Response.json({ reply: textBlock?.text ?? 'Sin respuesta' })
  } catch (e) {
    console.error('[api.assistant]', e)
    const msg = e instanceof Anthropic.APIError ? e.message : 'Error al contactar el asistente. Intenta de nuevo.'
    return Response.json({ reply: msg }, { status: 500 })
  }
}
