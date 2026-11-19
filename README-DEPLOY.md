# PoijutStore — backend deployment

The site uses Netlify Functions and Netlify Blobs for administrator login and warranty storage.

## Required Netlify environment variables

Set these in **Netlify → Site configuration → Environment variables**:

- `ADMIN_USERNAME`: administrator login name.
- `ADMIN_PASSWORD`: a long, unique administrator password.
- `ADMIN_SESSION_SECRET`: a random secret of at least 32 characters.

Never put these values in this repository or in frontend HTML.

## Deploy

Connect this GitHub repository to Netlify (or confirm the existing Netlify site is connected), use the repository root as the base directory, and deploy. Netlify automatically provisions Blobs for the function store.

After deployment, verify:
- `/api/admin/session` returns 401 when logged out.
- Admin login works with the environment variables above.
- Saving an invoice creates a warranty record.
- The public warranty lookup returns that record.

Warranty records are stored server-side in Netlify Blobs. The public lookup exposes the warranty record associated with a supplied invoice/resi number; do not store sensitive payment credentials or identity documents in these records.
