# BodaBoda Queen (`bodabodaqueen.co.ke`)

Serverless Safaricom Data, SMS, Voice & Boda Combo reseller platform running on **Cloudflare Pages**, **Cloudflare D1**, **Cloudflare R2**, **Safaricom Daraja M-Pesa STK Push**, and an **Android SIM Automation Worker**.

## Environment Bindings & Secrets (Cloudflare Pages)
1. **D1 Binding:** `DB` -> `bodabodaqueen-db`
2. **R2 Binding:** `BACKUP_BUCKET` -> `bodabodaqueen-backups`
3. **Environment Variables & Secrets:**
   - `MPESA_ENV`: `sandbox` or `production`
   - `MPESA_CONSUMER_KEY` *(Secret)*
   - `MPESA_CONSUMER_SECRET` *(Secret)*
   - `MPESA_SHORTCODE`
   - `MPESA_TILL_OR_ACCOUNT`
   - `MPESA_TRANSACTION_TYPE`: `CustomerPayBillOnline` or `CustomerBuyGoodsOnline`
   - `MPESA_PASSKEY` *(Secret)*
   - `MPESA_CALLBACK_SECRET` *(Secret)*
   - `MPESA_CALLBACK_URL`: `https://bodabodaqueen.co.ke/api/mpesa-callback?token=<MPESA_CALLBACK_SECRET>`
   - `ADMIN_SECRET_KEY` *(Secret)*
   - `SIM_WORKER_SECRET` *(Secret)*
