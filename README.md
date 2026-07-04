---
solhann_app: true
slug: mcr-events
title: MCR Events
description: Every gig, club night and event in Manchester — one feed
emoji: 🐝
---

# 🐝 MCR Events

Every gig, club night and event in Manchester — one feed

**Live:** https://mcr-events.solhann.net
**Gallery:** https://create.solhann.net

---

Built on the [solhann.net](https://create.solhann.net) platform. Static site — every push to `main`
auto-deploys via GitHub Actions → rsync → `/var/www/apps/mcr-events/`. The front matter above is what the
gallery reads to render this app's tile, so keep `title` / `description` / `emoji` up to date.
