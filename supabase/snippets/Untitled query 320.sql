SELECT id, type, status, started_at, completed_at, error_message 
FROM sync_jobs 
WHERE shop_id = '176shop.myshopify.com' 
ORDER BY started_at DESC 
LIMIT 5;