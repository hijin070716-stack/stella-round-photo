Stella Survival - Cloudflare Pages compatible package

Contents:
- index.html: round photo upload site UI (API endpoint updated)
- functions/api/stella-api.js: Cloudflare Pages Function at /api/stella-api
- SETUP_KO.txt: Korean deployment guide
- supabase_setup.sql: retained SQL reference from the original package

Deploy via Cloudflare Pages Git integration or Wrangler. Do not use a static-only upload method that omits Pages Functions.
Keep Supabase service-role key in Cloudflare environment secrets only.
