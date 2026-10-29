# TriAyam Stall Tracker - Netlify + Supabase

* `public/index.html` - the website (served by Netlify)
* `netlify/functions/api.mjs` - the server logic and role checks (runs on Netlify)
* `supabase/schema.sql` - database tables (run once in Supabase)

All data (sales, users, catalog, brand) lives in your Supabase database, so it is shared by every
device and survives cache clearing, logout and crashes.

## Setup (about 10 minutes)

### 1. Create the tables in Supabase
Supabase dashboard > **SQL Editor** > **New query** > paste the whole of `supabase/schema.sql` > **Run**.
You should see "Success. No rows returned".

### 2. Set environment variables in Netlify
Netlify > your site > **Site configuration** > **Environment variables** > **Add a variable**
(make sure it applies to **Functions**; "All scopes" is fine):

| Name | Value |
|---|---|
| `SUPABASE_URL` | Supabase > Project Settings > API > Project URL |
| `SUPABASE_SERVICE_KEY` | the **secret** / **service_role** key (never the publishable/anon one) |
| `ADMIN_EMAIL` | the Super Admin login you want |
| `ADMIN_PASSWORD` | its password (min 6 characters) |

`ADMIN_EMAIL` / `ADMIN_PASSWORD` are used once, to create the first Super Admin when the users table is empty.

### 3. Deploy
Do not use Netlify's drag-and-drop upload: it does not reliably deploy Functions.

**A. With GitHub (no command line)**
1. Create a private GitHub repository and upload this folder's contents (keep the folder structure).
2. Netlify > **Add new site > Import an existing project** > pick the repo (or open your existing site >
   Site configuration > Build & deploy > Link repository). Build command: leave empty. Publish directory: `public`
   (already set in `netlify.toml`).
3. Deploy. Every later change you push redeploys automatically.

**B. With the Netlify CLI (Windows, from this folder)**
```
npm install -g netlify-cli
netlify login
netlify link          (choose your existing site)
netlify deploy --prod
```

Environment variables only take effect on a new deploy - after changing one, deploy again
(Deploys > Trigger deploy > Deploy site).

### 4. Check it works
* Open `https://YOUR-SITE.netlify.app/api/health` - it should show `{"ok":true}`.
* Open the site and sign in with `ADMIN_EMAIL` / `ADMIN_PASSWORD`.
* Error messages tell you what is wrong: "Server is not configured" = missing variables;
  "Database tables are missing" = step 1 not run; "Database rejected the key" = wrong `SUPABASE_SERVICE_KEY`.

### 5. Move over your old browser data (optional)
Sign in as Super Admin on the browser that has the old data > **Brand Settings** > **Import old data from this browser**.
Sales and catalog are copied (duplicates skipped). Create users again under **Manage Users**.

## Good to know
* **Roles are enforced on the server**: Super Admin (everything, brand settings), Admin (edit/delete sales, export,
  manage Staff/Admin), Staff (record sales, print, catalog).
* **Syncing**: each open screen checks for changes once a minute and when you switch back to the tab; click the
  "Synced" label in the header to refresh instantly. Netlify's free plan has a monthly limit on function calls, so
  avoid leaving many tabs open all day.
* **Supabase free projects pause after about 7 days without activity.** Daily stall use keeps it awake; if it ever
  pauses, press Restore in the Supabase dashboard (data is kept).
* **Backups**: use **Export Excel** regularly. Supabase's free plan does not give long-term backups.
* **Keep `SUPABASE_SERVICE_KEY` secret.** It lives only in Netlify's settings. If it ever leaks, regenerate it in
  Supabase and update Netlify. The tables also have row-level security on, so the public key cannot read anything.
