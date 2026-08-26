# Landing page

A single, dependency-free `index.html` — the public page for AuraOS.

Open it directly (`xdg-open landing/index.html`) or serve the repo root:

```bash
python3 -m http.server 8080   # → http://localhost:8080/landing/
```

## Notes

- **Styling** uses the OS's own tokens: the scificn HUD silhouette
  (`--clip-corner-md`), the shell status-bar wordmark from
  `packages/shell/src/components/shell/StatusBar.astro`, and the **CYAN**
  palette from `packages/core/src/theme/ThemeManager.ts`. Keep them in sync by
  hand — the page is standalone on purpose and imports nothing.
- **Screenshot** is referenced as `../assets/aura-os.png` (the same file the
  README uses) rather than copied, so there is one source of truth. If this
  folder is ever deployed on its own, copy the asset in and change that path
  plus the `og:image` meta.
- **Text** tracks `VISION.md`. Update both together.
- Fonts come from Google Fonts; everything else is inline.
