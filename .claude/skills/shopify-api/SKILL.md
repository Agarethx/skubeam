# Skill: shopify-api
Ver agente shopify-sync-agent.md para queries GraphQL completas.

## Autenticación
```typescript
const { admin, session } = await authenticate.admin(request);
const shopId = session.shop;
```

## GIDs → número
```typescript
const id = parseInt(gid.split("/").pop() ?? "0", 10);
```

## Paginación
Usar cursor-based: `pageInfo { hasNextPage endCursor }` en todas las queries de listas.

## Rate limit
Budget: 1000 puntos, recupera 50/seg. Pausar si `currentlyAvailable < 150`.
