# CloseBuy Backend

## Deploy to Railway

1. Go to railway.app
2. New Project → Deploy from GitHub repo
3. Upload this folder
4. Add environment variables from .env.example
5. Deploy — Railway gives you a live URL

## API Routes

- GET  /          health check
- POST /chat      Claude AI agent chat
- POST /request   send availability request to store
- GET  /stores    get all stores from Supabase
- GET  /products  get all products from Supabase
- POST /sms-reply store owner SMS reply webhook (Twilio)
