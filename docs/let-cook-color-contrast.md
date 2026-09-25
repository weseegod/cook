# Let Cook color contrast

Rules for colors in the Let Cook desktop app. Follow this when adding or changing UI.

Let Cook is workbench chrome, not an editor. VS Code's accessibility guideline applies to the whole window: [everything outside the editor must be 4.5:1](https://github.com/microsoft/vscode-wiki/blob/main/Accessibility-Guidelines.md). Control boundaries and the focus ring follow WCAG 2.2 non-text contrast at 3:1.

## Current files

| File | Role |
|---|---|
| `frontend/apps/let-cook/src/theme/tokens.css` | The only place theme colors are declared. Dark on `:root`, light on `:root[data-theme="light"]` |
| `frontend/apps/let-cook/src/theme/app.css` | Entry: `tokens.css`, then `components.css` |
| `frontend/apps/let-cook/src/theme/components.css` | Ordered `@import` barrel for the component modules below |
| `frontend/apps/let-cook/src/theme/base.css` | Preflight reset, body, scrollbars, focus, shared chrome (chips, buttons, toggle) |
| `frontend/apps/let-cook/src/theme/shell.css` | App frame, agent header, sidebar, session list |
| `frontend/apps/let-cook/src/theme/chat.css` | Transcript, messages, markdown, tools, permissions |
| `frontend/apps/let-cook/src/theme/composer.css` | Prompt, slash menu, attachments, model picker |
| `frontend/apps/let-cook/src/theme/overlays.css` | Palette, dialogs, popovers, shortcuts |
| `frontend/apps/let-cook/src/theme/settings.css` | Settings workspace, tabs, providers, models |
| `frontend/apps/let-cook/src/theme/utility.css` | Utility panel, tasks/plan/goal chips, review/files |
| `frontend/apps/let-cook/tests/ui-layout.spec.ts` | Composer text, placeholder, border, and focus, in both themes |
| `frontend/apps/let-cook/tests/data-controls.spec.ts` | Destructive label contrast, translucency included, in both themes |

Import order is cascade order. Do not reorder the barrel imports. The desktop module map points here for colors; the contract indexes this file from [`desktop-app.md`](desktop-app.md).

## Floors

Measure against the surface the pixel is painted on, after any translucency is composited. UI type is 11–14px, so the large-text exception (3:1 at 24px, or 18.67px bold) does not apply. Check both themes. A gray that passes on `#1f1f1f` usually fails on white.

| What | Floor |
|---|---|
| Text the user reads: body, secondary, muted, placeholder, links, status words | **4.5:1** |
| Boundary that shows where a control is (input border, focus ring) | **3:1** |
| Focus ring thickness | **2px** |

Not floors:

- Hairline separators (`--border`, `--settings-border`) only divide regions. They are not the outline of a control.
- Scrollbar thumbs (`--scrollbar-thumb`) are not text and not a control boundary. Do not reuse that color for either.
- `button:disabled { opacity: .45 }` is the inactive-control exception. Do not put that opacity on text the user still has to read.
- VS Code's 7:1 high-contrast target is not a Let Cook theme.

## Token roles

Component CSS uses `var(--…)`. Do not add a hex in a component rule. Declare a new color in `tokens.css` for both themes.

Keep a CSS class in sync with its markup: if the TSX no longer names a class, delete the rule. Dynamic names (`plan-entry-${status}`, `dialog-${size}`, `drop-${position}`) stay as long as the template is in the source.

| Token | Use for | Do not use for |
|---|---|---|
| `--text` | Primary copy | |
| `--text-soft` | Secondary copy | Borders |
| `--muted` | Meta, eyebrows, timestamps, hints | A label whose opacity you then reduce |
| `--input-placeholder` | Placeholder text, with `opacity: 1` | |
| `--accent-text` | Accent-colored words and icons | Fills |
| `--accent` | Fill behind `--on-accent` label text | Text on `--bg` (3.64:1 on `#1f1f1f`) |
| `--on-accent` | Label on `--accent` fills (always white) | Text on page surfaces |
| `--control-border` | The stroke that shows an input | Section dividers |
| `--focus-border` | The 2px focus ring | Body text |
| `--border` | Dividers between regions | Input edges |
| `--success`, `--danger`, `--warning` | Short status marks (dots, diff counts) | A sentence. Light `--success` is 4.33:1 on white |
| `--success-soft-text`, `--danger-soft-text`, `--warning-soft-text` | Status sentences, on the page or on the matching `*-soft` fill | |
| `--danger-button-fg` | Label on a translucent danger fill (Data Controls delete) | Body copy elsewhere |
| `--settings-text`, `--settings-soft`, `--settings-muted` | Copy on the settings surface | Chat chrome |

Placeholder and muted share a hex (`#a6a6a6` dark, `#5f5f5f` light). Keep them together. The browser's default placeholder opacity is about half and pulls a passing gray under 4.5:1, so placeholder rules set `opacity: 1`.

White on `--accent` (`#0078d4`) is 4.53:1. That label color is `--on-accent` (always `#ffffff`).

Light `--danger` (`#c72e0f`) is fine as a mark on white, but on the translucent Data Controls tint it drops under 4.5:1. That label uses `--danger-button-fg` (`#9e2638` in light).

## Exceptions (hex allowed in component CSS)

Documented only. Everything else is a token.

| Where | Why |
|---|---|
| Provider brand plates (Claude `#d97757`, Xiaomi `#ff6900`, Moonshot `#1783ff`) | Fixed brand hues, not theme surfaces |
| macOS-style toggle track/thumb (`#39393d` / `#34c759` / white thumb) | System control chrome |
| `--code-bg` / shiki plates | Stay dark in both themes so `github-dark` tokens stay readable |

Do not add `:root[data-theme="light"] .component` color patches. Change the token instead.

## Values that clear the floors

Ratios are against the surface in the column. Recompute when a surface changes. Page background is `#1f1f1f` (Dark Modern `editor.background`). The composer sits on `--panel-elevated` `#252526`.

| Token | Dark | On `#1f1f1f` | On `#252526` | Light | On `#ffffff` |
|---|---|---|---|---|---|
| `--text` | `#eeeeee` | 14.21 | 13.20 | `#242424` | 15.52 |
| `--text-soft` | `#d0d0d0` | 10.69 | | `#444444` | 9.74 |
| `--muted`, `--input-placeholder` | `#a6a6a6` | 6.77 | 6.29 | `#5f5f5f` | 6.39 |
| `--accent-text` | `#75beff` | 8.29 | | `#005a9e` | 7.10 |
| `--control-border` | `#747474` | 3.53 | 3.28 | `#767676` | 4.54 |
| `--focus-border` | `#007fd4` | 3.91 | 3.64 | `#006fbe` | 5.23 |
| `--danger` | `#f48771` | 6.71 | | `#c72e0f` | 5.49 |
| `--danger-button-fg` | `#f48771` | 6.71 | | `#9e2638` | 8.59 |
| `--warning` | `#cca700` | 7.14 | | `#8a6500` | 5.33 |

`--control-border` on the dark settings input (`#2b2b2b`) is 3.03:1. Do not lighten `#747474`.

These differ from default VS Code colors where the default misses the floor:

- `input.border` is unset in the default themes. Let Cook draws `--control-border` so the composer is visible without focus.
- Registry light `focusBorder` `#0090F1` is 3.35:1. Let Cook uses `#006fbe` (5.23:1).
- Registry `textLink.foreground` is `#3794FF` / `#006AB1`. `--accent-text` is `#75beff` / `#005a9e`, which clears 4.5 with more room.
- The current registry placeholder is `foreground` at 50% opacity. That fails 4.5:1. Let Cook uses a solid gray at opacity 1.
- `--accent` `#0078d4` is a fill (Dark Modern `button.background`). It is not a text color on the dark page.
- Light `--success` `#388a34` is 4.33:1 on white. Keep it a mark. A sentence uses `--success-soft-text`.

## Adding a color

1. Use an existing token when the role matches.
2. Otherwise add the hex to both themes in `tokens.css`.
3. Measure it on every surface it sits on, in both themes. The composer and settings inputs are not `--bg`.
4. For a translucent fill, composite first: per channel, `painted = color * alpha + surface * (1 - alpha)`, then measure. The Data Controls destructive button is the case the suite already locks.
5. Focus is `outline: 2px solid var(--focus-border)` with a visible offset. The composer draws that ring on the frame and clears the textarea's own outline. A new field does one of those, still at 2px.
6. Extend `ui-layout.spec.ts` or `data-controls.spec.ts` when the new control is a text field or a translucent danger action.

Relative luminance, the same function the tests use:

```
srgb(channel) = channel / 255
linear(c)     = c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ^ 2.4
L             = 0.2126 * R + 0.7152 * G + 0.0722 * B
ratio         = (lighter + 0.05) / (darker + 0.05)
```

`channel` is 0–255 from `rgb()` or `#rrggbb`. `color(srgb …)` is already 0–1. The Data Controls test branches on that.

Run before changing a token those checks read:

```
cd frontend/apps/let-cook
pnpm exec playwright test tests/ui-layout.spec.ts tests/data-controls.spec.ts
```
