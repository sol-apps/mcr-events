// main.pb.js — PocketBase JS hooks for mcr-events. THIS FILE RUNS ON THE SERVER.
//
// Delivery: push to main → CI rsyncs pb_hooks/ to the instance's hooks dir
// (write-only jail, separate from the site deploy); PocketBase reloads on
// change. Deleting a file here deletes it on prod. pb_hooks/ is never
// published on the public site.
//
// Runtime: PocketBase's embedded Goja VM — NO npm, NO Node APIs. You get
// PocketBase's helpers only: $app, $http.send(...), $os.getenv(...),
// $filesystem, cronAdd, routerAdd, onRecordCreate, ...
// Docs: https://pocketbase.io/docs/js-overview/
//
// Runtime secrets are set from the dev box (never committed here):
//   pb-secret set mcr-events.MY_KEY        # store value (prompted on stdin)
//   pb-provision mcr-events --push-env     # apply to the live instance
// then read them below with $os.getenv("MY_KEY").

// Example: a daily cron writing a record — uncomment (and create the
// collection first via pb-schema) to try it.
// cronAdd("daily-example", "0 6 * * *", () => {
//   const collection = $app.findCollectionByNameOrId("items");
//   const record = new Record(collection);
//   record.set("note", "hello from a server-side cron");
//   $app.save(record);
// });
