// main.pb.js — PocketBase JS hooks for mcr-events. THIS FILE RUNS ON THE SERVER.
//
// Delivery: push to main → CI rsyncs pb_hooks/ to the instance's hooks dir;
// PocketBase hot-reloads. Runs on the embedded Goja VM (no npm/Node).
//
// Runtime secrets (set from dev, never committed):
//   pb-secret set mcr-events.SKIDDLE_KEY    # enables the Skiddle source
//   pb-secret set mcr-events.INGEST_TOKEN   # guards the manual trigger below
//   pb-provision mcr-events --push-env

// Daily scrape of all sources at 05:23 UTC (quiet hour for RA/Skiddle).
cronAdd("ingest", "23 5 * * *", () => {
  require(`${__hooks}/ingest.js`).run();
});

// Manual trigger for testing/backfill:
//   curl -X POST -H "X-Ingest-Token: $TOKEN" https://mcr-events.solhann.net/ingest-now
routerAdd("POST", "/ingest-now", (e) => {
  const want = $os.getenv("INGEST_TOKEN");
  const got = e.request.header.get("X-Ingest-Token");
  if (!want || got !== want) {
    return e.json(403, { error: "forbidden" });
  }
  return e.json(200, require(`${__hooks}/ingest.js`).run());
});
