import type { HeadersFunction, LoaderFunctionArgs } from 'react-router'
import { useLoaderData, useFetcher, useRouteError } from 'react-router'
import { useState, useRef, useEffect } from 'react'
import { boundary } from '@shopify/shopify-app-react-router/server'
import { authenticate } from '../shopify.server'
import { getShop } from '../models/shop.server'
import { FeatureGate } from '../components/FeatureGate'
import { useTranslation } from 'react-i18next'

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request)
  const shop = await getShop(session.shop)
  return { plan: shop?.plan ?? 'starter' }
}

interface Message {
  role: 'user' | 'assistant'
  content: string
}

const SUGGESTED_PROMPTS = [
  '¿Cuáles son mis SKUs críticos?',
  '¿Cuánto vale mi inventario?',
  '¿Qué debo reponer esta semana?',
  '¿Cuáles son mis productos más vendidos?',
]

export default function AssistantPage() {
  const { plan } = useLoaderData<typeof loader>()
  const { t } = useTranslation()
  const fetcher = useFetcher<{ reply: string }>()
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const isLoading = fetcher.state === 'submitting'

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  useEffect(() => {
    if (fetcher.data?.reply && fetcher.state === 'idle') {
      setMessages(prev => [...prev, { role: 'assistant', content: fetcher.data!.reply }])
    }
  }, [fetcher.data, fetcher.state])

  const sendMessage = (text: string) => {
    if (!text.trim() || isLoading) return
    const newMessages: Message[] = [...messages, { role: 'user', content: text }]
    setMessages(newMessages)
    setInput('')

    fetcher.submit(
      { messages: newMessages } as unknown as Record<string, string>,
      { method: 'post', action: '/api/assistant', encType: 'application/json' },
    )
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') sendMessage(input)
  }

  return (
    <FeatureGate feature="aiAssistant" plan={plan}>
      <s-page heading={t('assistant.title')}>
        <s-box padding="large" borderWidth="small" borderRadius="base" background="base">
          {/* Chat messages area */}
          <div style={{ height: '500px', overflowY: 'auto', padding: '16px' }}>
            {messages.length === 0 ? (
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '16px', paddingTop: '40px', textAlign: 'center' }}>
                <p style={{ margin: 0, fontWeight: 600, fontSize: '16px' }}>
                  {t('assistant.greeting')}
                </p>
                <s-text color="subdued">
                  {t('assistant.subtitle')}
                </s-text>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', justifyContent: 'center', marginTop: '8px' }}>
                  {SUGGESTED_PROMPTS.map(prompt => (
                    <s-button
                      key={prompt}
                      onClick={() => sendMessage(prompt)}
                    >
                      {prompt}
                    </s-button>
                  ))}
                </div>
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                {messages.map((msg, i) => (
                  <div
                    key={i}
                    style={{
                      display: 'flex',
                      justifyContent: msg.role === 'user' ? 'flex-end' : 'flex-start',
                    }}
                  >
                    <div
                      style={{
                        maxWidth: '80%',
                        padding: '12px 16px',
                        borderRadius: '12px',
                        background: msg.role === 'user' ? '#008060' : '#f1f1f1',
                        color: msg.role === 'user' ? 'white' : 'black',
                        whiteSpace: 'pre-wrap',
                        fontSize: '14px',
                        lineHeight: '1.5',
                      }}
                    >
                      {msg.content}
                    </div>
                  </div>
                ))}
                {isLoading && (
                  <div style={{ display: 'flex', justifyContent: 'flex-start' }}>
                    <div style={{ padding: '12px 16px', borderRadius: '12px', background: '#f1f1f1' }}>
                      <s-spinner />
                    </div>
                  </div>
                )}
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>

          {/* Input area */}
          <div style={{ padding: '16px', borderTop: '1px solid #e1e3e5', display: 'flex', gap: '8px' }}>
            <div style={{ flex: 1 }}>
              <input
                type="text"
                value={input}
                onChange={e => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={t('assistant.placeholder')}
                disabled={isLoading}
                style={{
                  width: '100%',
                  padding: '8px 12px',
                  border: '1px solid #c9cccf',
                  borderRadius: '4px',
                  fontSize: '14px',
                  outline: 'none',
                  boxSizing: 'border-box',
                }}
              />
            </div>
            <s-button
              variant="primary"
              onClick={() => sendMessage(input)}
              disabled={!input.trim() || isLoading}
            >
              {t('assistant.send')}
            </s-button>
          </div>
        </s-box>
      </s-page>
    </FeatureGate>
  )
}

export function ErrorBoundary() {
  return boundary.error(useRouteError())
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs)
}
