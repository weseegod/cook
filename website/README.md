# Cook website

The Cook project website is built with Astro and deployed as static files on Cloudflare Pages. The landing page keeps its existing download links and version refresh. The docs pages render Markdown directly from the Cook repository, so the user guide has one source of truth.

## Run locally

```sh
npm install
npm run dev
```

## Build

```sh
npm run build
npm run preview
```

Astro writes the static site to `dist/`.

## Cloudflare Workers

The site deploys as a static-asset Worker (`cook`) via Workers Builds connected to this repository:

- **Root directory:** `website`
- **Build command:** `npm run build`
- **Deploy command:** `npx wrangler deploy`
- **Production branch:** `main`

`wrangler.toml` names the Worker `cook` and serves Astro's `dist/` through `[assets]`. Attach `letcook.dev` as a custom domain on the Worker. Keep `download.letcook.dev` pointed at the release bucket; the landing page uses it for the installer and app downloads.

The site does not need an adapter, server function, or database. Astro builds the home page and every docs route before deployment.

Use Node.js 22.12.0 or newer. `.node-version` pins Node 22.22.1 for local development and Cloudflare Workers Builds.

## Docs source

Product guide Markdown lives in `../crates/codegen/xai-grok-pager/docs/user-guide/`. `src/lib/docs.js` reads those files during the build and rewrites their relative Markdown links to site routes. Add or edit product guides in that source folder; do not copy them into `website/`.
