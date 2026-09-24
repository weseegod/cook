# Cook website

The site uses Astro and builds to static files. Cloudflare Workers Builds
deploys it from this repository. The docs pages read Cook's existing user
guide, so the Markdown is kept in one place.

## Cloudflare setup

Connect the Cook GitHub repository to Workers Builds and use these settings:

- **Root directory:** `website`
- **Build command:** `npm run build`
- **Deploy command:** `npx wrangler deploy`
- **Production branch:** `main`

`wrangler.toml` names the Worker `cook`, serves Astro's `dist/` files, and keeps
`letcook.dev` as its custom domain. `.node-version` pins Node.js to `22.22.1`.
Workers Builds publishes commits pushed to `main`. No other build settings or
environment variables are needed.

Keep `download.letcook.dev` pointed at the release bucket; the site uses it for
install commands and app downloads.

The site does not need an Astro adapter, server function, or database. Astro
builds the homepage and documentation pages ahead of time.

## Run locally

```sh
npm ci
npm run dev
```

To build and preview the static site locally:

```sh
npm run build
npm run preview
```

Astro writes the site to `dist/`.

## Docs source

Product guide Markdown lives in
`../crates/codegen/xai-grok-pager/docs/user-guide/`. `src/lib/docs.js` reads
those files during the build and rewrites their relative Markdown links to site
routes. Add or edit product guides in that source folder; do not copy them into
`website/`.
