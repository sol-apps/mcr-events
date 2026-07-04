// ingest.js — scrapes Manchester event sources into the `events` collection.
// Loaded via require() from main.pb.js; runs in PocketBase's Goja VM (no Node).
//
// Time convention: all `starts_at`/`ends_at` are Manchester WALL-CLOCK time
// stored with a Z suffix (both sources return local times without offsets).
// The frontend must format with UTC getters — never convert timezones.

var RA_AREA_MANCHESTER = 344;
var DAYS_AHEAD = 60;
var UA = "Mozilla/5.0 (X11; Linux x86_64; rv:126.0) Gecko/20100101 Firefox/126.0";

function pad(n) { return (n < 10 ? "0" : "") + n; }

function isoDate(d) {
  return d.getUTCFullYear() + "-" + pad(d.getUTCMonth() + 1) + "-" + pad(d.getUTCDate());
}

// "2026-07-04T13:00:00.000" (local wall time) -> "2026-07-04 13:00:00.000Z"
function wallToPb(s) {
  if (!s) return "";
  s = String(s).replace("T", " ").replace(/([+-]\d\d:?\d\d|Z)$/, "");
  if (!/\d\d:\d\d/.test(s)) s += " 00:00:00";
  if (!/\.\d+$/.test(s)) s += ".000";
  return s + "Z";
}

function normVenue(name) {
  return String(name || "").toLowerCase().replace(/^the\s+/, "").replace(/[^a-z0-9]/g, "").slice(0, 40);
}

function dedupKey(dateStr, venue) {
  return String(dateStr || "").slice(0, 10) + "|" + normVenue(venue);
}

function getJson(cfg) {
  var res = $http.send({
    url: cfg.url,
    method: cfg.method || "GET",
    body: cfg.body || "",
    headers: cfg.headers || {},
    timeout: 90,
  });
  if (res.statusCode !== 200) {
    throw new Error("HTTP " + res.statusCode + " from " + cfg.url.split("?")[0]);
  }
  return res.json;
}

// Upsert one normalized event. `f` holds the record fields; a manually set
// is_pick on an existing record is never cleared by a re-scrape.
function upsert(f, stats) {
  var rec = null;
  try {
    rec = $app.findFirstRecordByFilter(
      "events", "source = {:s} && source_id = {:sid}",
      { s: f.source, sid: f.source_id }
    );
  } catch (_) {}
  var isNew = !rec;
  if (isNew) {
    rec = new Record($app.findCollectionByNameOrId("events"));
    rec.set("source", f.source);
    rec.set("source_id", f.source_id);
  }
  var pick = rec.getBool("is_pick") || !!f.is_pick;
  rec.set("title", f.title);
  rec.set("artists", f.artists || []);
  rec.set("venue", f.venue || "");
  rec.set("venue_id", f.venue_id || "");
  rec.set("starts_at", f.starts_at);
  rec.set("ends_at", f.ends_at || "");
  rec.set("url", f.url || "");
  rec.set("image", f.image || "");
  rec.set("category", f.category || "other");
  rec.set("genres", f.genres || []);
  rec.set("price", f.price || "");
  rec.set("description", (f.description || "").slice(0, 4000));
  rec.set("attending", f.attending || 0);
  rec.set("is_pick", pick);
  rec.set("dedup_key", dedupKey(f.starts_at, f.venue));
  rec.set("last_seen", wallToPb(new Date().toISOString()));
  $app.save(rec);
  stats[isNew ? "created" : "updated"]++;
}

// --- Resident Advisor (unofficial GraphQL; area 344 = Manchester) ---------
// RA caps listing date ranges at 30 days, so DAYS_AHEAD is fetched in windows.
var RA_QUERY =
  "query($f:FilterInputDtoInput,$p:Int,$ps:Int){" +
  " eventListings(filters:$f, page:$p, pageSize:$ps){ totalResults data{" +
  " event{ id title date startTime endTime contentUrl attending" +
  " images{ filename } venue{ id name } artists{ name } pick{ id } } } } }";

function ingestRA(stats) {
  var now = new Date();
  for (var w = 0; w < DAYS_AHEAD; w += 30) {
    var gte = new Date(now.getTime() + w * 86400000);
    var lte = new Date(now.getTime() + Math.min(w + 30, DAYS_AHEAD) * 86400000);
    for (var page = 1; page <= 20; page++) {
      var body = getJson({
        url: "https://ra.co/graphql",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": UA,
          "Referer": "https://ra.co/events/uk/manchester",
        },
        body: JSON.stringify({
          query: RA_QUERY,
          variables: {
            f: { areas: { eq: RA_AREA_MANCHESTER }, listingDate: { gte: isoDate(gte), lte: isoDate(lte) } },
            p: page, ps: 50,
          },
        }),
      });
      var listings = (body.data && body.data.eventListings && body.data.eventListings.data) || [];
      for (var i = 0; i < listings.length; i++) {
        var ev = listings[i].event;
        if (!ev || !ev.id) continue;
        var artists = (ev.artists || []).map(function (a) { return a.name; });
        upsert({
          source: "ra",
          source_id: String(ev.id),
          title: ev.title || "Untitled",
          artists: artists,
          venue: (ev.venue && ev.venue.name) || "",
          venue_id: (ev.venue && String(ev.venue.id)) || "",
          starts_at: wallToPb(ev.startTime || ev.date),
          ends_at: wallToPb(ev.endTime),
          url: ev.contentUrl ? "https://ra.co" + ev.contentUrl : "",
          image: (ev.images && ev.images[0] && ev.images[0].filename) || "",
          category: "clubs",
          attending: ev.attending || 0,
          is_pick: !!ev.pick, // RA editorial pick seeds our picks rail
        }, stats);
      }
      if (listings.length < 50) break;
    }
  }
}

// --- Skiddle (official API; activates once SKIDDLE_KEY is pushed) ---------
var SKIDDLE_CATEGORY = {
  CLUB: "clubs", LIVE: "gigs", COMEDY: "comedy", THEATRE: "theatre",
  ARTS: "arts", EXHIB: "arts", FEST: "festivals", DANCE: "theatre",
};

function ingestSkiddle(stats) {
  var key = $os.getenv("SKIDDLE_KEY");
  if (!key) {
    stats.skipped.push("skiddle: no SKIDDLE_KEY set");
    return;
  }
  var now = new Date();
  var maxDate = new Date(now.getTime() + DAYS_AHEAD * 86400000);
  for (var offset = 0; offset <= 2000; offset += 100) {
    var body = getJson({
      url: "https://www.skiddle.com/api/v1/events/search/?api_key=" + key +
        "&latitude=53.4808&longitude=-2.2426&radius=10" +
        "&minDate=" + isoDate(now) + "&maxDate=" + isoDate(maxDate) +
        "&description=1&limit=100&offset=" + offset,
      headers: { "User-Agent": UA },
    });
    var results = body.results || [];
    for (var i = 0; i < results.length; i++) {
      var r = results[i];
      if (!r.id) continue;
      var artists = (r.artists || []).map(function (a) { return a.name || String(a); });
      var genres = (r.genres || []).map(function (g) { return g.name || String(g); });
      var doors = (r.openingtimes && r.openingtimes.doorsopen) || "";
      var closes = (r.openingtimes && r.openingtimes.doorsclose) || "";
      upsert({
        source: "skiddle",
        source_id: String(r.id),
        title: r.eventname || "Untitled",
        artists: artists,
        venue: (r.venue && r.venue.name) || "",
        venue_id: (r.venue && String(r.venue.id)) || "",
        starts_at: wallToPb(r.startdate || (r.date && doors ? r.date + " " + doors : r.date)),
        ends_at: wallToPb(r.enddate || (r.date && closes ? r.date + " " + closes : "")),
        url: r.link || "",
        image: r.largeimageurl || r.imageurl || "",
        category: SKIDDLE_CATEGORY[r.EventCode] || "other",
        genres: genres,
        price: r.entryprice || "",
        description: r.description || "",
        attending: parseInt(r.goingtocount, 10) || 0,
      }, stats);
    }
    if (results.length < 100) break;
  }
}

// --- Prune: past events (>7 days old) and future events that vanished
// upstream (not seen by any scrape for 3+ days: cancelled or delisted).
function prune(stats) {
  var now = Date.now();
  var pastCutoff = wallToPb(new Date(now - 7 * 86400000).toISOString());
  var staleCutoff = wallToPb(new Date(now - 3 * 86400000).toISOString());
  var nowPb = wallToPb(new Date(now).toISOString());
  var doomed = $app.findRecordsByFilter(
    "events",
    "starts_at < {:past} || (last_seen < {:stale} && starts_at > {:now})",
    "", 1000, 0,
    { past: pastCutoff, stale: staleCutoff, now: nowPb }
  );
  for (var i = 0; i < doomed.length; i++) {
    $app.delete(doomed[i]);
    stats.pruned++;
  }
}

module.exports = {
  run: function () {
    var stats = { created: 0, updated: 0, pruned: 0, errors: [], skipped: [] };
    var sources = [["ra", ingestRA], ["skiddle", ingestSkiddle]];
    for (var i = 0; i < sources.length; i++) {
      try {
        sources[i][1](stats);
      } catch (err) {
        stats.errors.push(sources[i][0] + ": " + err);
        $app.logger().error("ingest source failed", "source", sources[i][0], "err", String(err));
      }
    }
    try {
      prune(stats);
    } catch (err) {
      stats.errors.push("prune: " + err);
    }
    $app.logger().info("ingest done",
      "created", stats.created, "updated", stats.updated,
      "pruned", stats.pruned, "errors", stats.errors.join("; "));
    return stats;
  },
};
