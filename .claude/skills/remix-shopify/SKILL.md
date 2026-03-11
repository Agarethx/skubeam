# Skill: remix-shopify
Ver agente shopify-sync-agent.md para patrones completos.

## Reglas críticas
- NUNCA tocar `auth.$.tsx` ni `auth.login/`
- Siempre `authenticate.admin(request)` al inicio de loader/action
- UI solo con componentes Polaris
- Variables de entorno solo en archivos `.server.ts`
- `SUPABASE_SERVICE_ROLE_KEY` NUNCA al cliente

## Toast
```typescript
const shopify = useAppBridge();
shopify.toast.show("Mensaje");
```
