/**
 * TeeFind Backend — Express API + Scraper Engine
 *
 * Both sources use direct JSON API calls — no headless browser needed at all.
 *
 * Chrono Golf: GET  https://www.chronogolf.ca/marketplace/clubs/:id/teetimes
 * Minute Golf:  POST https://www.minutegolf.ca/index.php?option=com_ggportal&format=raw&req=teetimes
 *
 * Run:     node server.js
 * Requires: npm install express cors node-cron nodemailer twilio
 *           (no playwright needed anymore!)
 */

const express    = require('express');
const cors       = require('cors');
const cron       = require('node-cron');
const nodemailer = require('nodemailer');
const { chromium } = require('playwright');

const app = express();
app.use(cors());
app.use(express.json());

// ─────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────
const CONFIG = {
  port: 3001,
  scrapeIntervalMinutes: 10,
  email: {
    host: 'smtp.resend.com',
    port: 465,
    secure: true,
    auth: { user: 'resend', pass: process.env.RESEND_API_KEY || 'YOUR_KEY' },
    from: 'alerts@yourdomain.com',
  },
  twilio: {
    accountSid: process.env.TWILIO_SID   || 'YOUR_SID',
    authToken:  process.env.TWILIO_TOKEN || 'YOUR_TOKEN',
    fromNumber: '+15550000000',
  },
};

// ─────────────────────────────────────────────
// IN-MEMORY STORE
// Replace with PostgreSQL/SQLite for production
// ─────────────────────────────────────────────
let teeTimeCache   = [];
let alertsStore    = [];
let lastScrapeTime = null;
let alertIdCounter = 1;

// Shared browser-like headers for both APIs
const HEADERS = {
  'User-Agent':      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept':          'application/json, text/plain, */*',
  'Accept-Language': 'en-CA,en;q=0.9,fr-CA;q=0.8',
  'Accept-Encoding': 'gzip, deflate, br',
};

// Chrono Golf requires a session cookie to avoid Cloudflare 403s
// Set via: export CHRONO_SESSION="your_cookie_value"
const CHRONO_HEADERS = {
  ...HEADERS,
  'Referer':          'https://www.chronogolf.ca/',
  'Origin':           'https://www.chronogolf.ca',
  'X-Requested-With': 'XMLHttpRequest',
  ...(process.env.CHRONO_SESSION ? { 'Cookie': `_chronogolf_session=${process.env.CHRONO_SESSION}` } : {}),
};

// ─────────────────────────────────────────────────────────────────────────────
//  MINUTE GOLF — POST API (no browser needed)
//
//  Discovered via DevTools → Network → Fetch/XHR → Payload tab:
//
//    POST https://www.minutegolf.ca/index.php
//         ?option=com_ggportal&lang=en&export=&format=raw&req=teetimes
//
//    Form Data:
//      region_id  = 11           ← Montreal region
//      date       = 2026-05-14
//      nbholes    = 9or18        ← returns both 9 and 18 hole times in one call
//      nbplayers  = 3            ← we use 1 to get all available slots
//      search     = Chercher les départs   ← button label, ignored server-side
//
//  Response shape:
//    [
//      {
//        "id": "13",
//        "name": "Joliette",       ← club/region name
//        "courses": [{
//          "name": "",
//          "teetimes": [{
//            "bookURL": "https://www.minutegolf.ca/index.php?option=com_ggportal&req=teetimes&lang=en&nbplayers=3&id=24874046&nbholes=18",
//            "holes": 18,
//            "maxPlayers": 4,
//            "time": "07:00",      ← already HH:MM, no parsing needed
//            "reservationPricing": {
//              "price": 93,
//              "discountedPrice": 93,
//              "taxesMode": "+ tax"
//            },
//            "paymentPricing": null,
//            "comments": ""
//          }]
//        }]
//      }
//    ]
//
//  NOTES:
//  - bookURL is provided directly — no need to construct deep links ourselves
//  - region_id 11 = Montreal area. Other regions may exist; check the site.
//  - nbplayers in the POST body filters results; use 1 to see all available slots
//    regardless of group size, then surface maxPlayers to the user
//  - No authentication required
// ─────────────────────────────────────────────────────────────────────────────

const MINUTE_GOLF_URL = 'https://www.minutegolf.ca/index.php?option=com_ggportal&lang=en&export=&format=raw&req=teetimes';

/**
 * Montreal-area regions only — 4 regions × 7 days = 28 requests per cycle (~12s).
 * Full region list if you ever want to expand: 9,10,11,12,13,14,15,20,23,38,40,41
 */
const MINUTE_REGIONS = [
  //{ id: 11, name: 'Lanaudière' },
  //{ id: 12, name: 'Laurentides' },
  //{ id: 13, name: 'Montérégie' },
  { id: 14, name: 'Montreal - Laval' },
];

async function scrapeMinuteGolf(dates) {
  const results = [];

  for (const region of MINUTE_REGIONS) {
    for (const date of dates) {
      try {
        console.log(`[MinuteGolf] Fetching region ${region.name} on ${date}...`);

        const body = new URLSearchParams({
          region_id: String(region.id),
          date,
          nbholes:   '9or18',
          nbplayers: '1',       // 1 = show all slots; bookURL will have the real player count
          search:    'Chercher les départs',
        });

        const resp = await fetch(MINUTE_GOLF_URL, {
          method:  'POST',
          headers: {
            ...HEADERS,
            'Content-Type':  'application/x-www-form-urlencoded',
            'Referer':       'https://www.minutegolf.ca/en/reservations',
            'Origin':        'https://www.minutegolf.ca',
          },
          body: body.toString(),
        });

        if (!resp.ok) {
          console.warn(`[MinuteGolf] HTTP ${resp.status} for region ${region.id} on ${date}`);
          continue;
        }

        const raw = await resp.json();

        // Response is either a plain array or an object with a 'clubs' key
        const data = Array.isArray(raw) ? raw : (raw.clubs || []);

        if (!Array.isArray(data) || data.length === 0) {
          console.warn('[MinuteGolf] Unexpected response shape:', typeof raw, Object.keys(raw));
          continue;
        }

        let slotCount = 0;
        for (const club of data) {
          const clubName = club.name || `Region ${region.id}`;

          for (const course of (club.courses || [])) {
            const courseName = course.name
              ? `${clubName} — ${course.name}`
              : clubName;

            for (const slot of (course.teetimes || [])) {
              const price = slot.reservationPricing?.discountedPrice
                         ?? slot.reservationPricing?.price
                         ?? null;

              results.push({
                id:             `minutegolf-${club.id}-${date}-${slot.time}-${slot.holes}h`,
                source:         'minutegolf',
                courseId:       String(club.id),
                courseName,
                date,
                time:           slot.time,          // already "HH:MM"
                holes:          slot.holes,
                players:        slot.maxPlayers || 4,
                pricePerPlayer: price,
                currency:       'CAD',
                taxesMode:      slot.reservationPricing?.taxesMode || null,
                membersOnly:    false,               // API only returns public slots
                bookingUrl:     slot.bookURL,        // deep link provided by their API!
                scrapedAt:      new Date(),
              });
              slotCount++;
            }
          }
        }

        console.log(`[MinuteGolf] ${slotCount} slots for region ${region.name} on ${date}`);

      } catch (err) {
        console.error(`[MinuteGolf] Error region ${region.id} on ${date}:`, err.message);
      }

      await sleep(400);
    }
  }

  return results;
}

// ─────────────────────────────────────────────────────────────────────────────
//  CHRONO GOLF — GET API (no browser needed)
//
//  Discovered via DevTools → Network → Fetch/XHR:
//
//    GET https://www.chronogolf.ca/marketplace/clubs/221/teetimes
//          ?date=2026-05-13
//          &course_id=152
//          &affiliation_type_ids[]=132033
//          &nb_holes=9
//
//  Response: array of tee time objects:
//    {
//      id: 557161924,
//      start_time: "07:32",      ← HH:MM format
//      date: "2026-05-13",
//      out_of_capacity: true,    ← skip these (fully booked)
//      green_fees: [{
//        green_fee: 45.0,
//        price: 45.0,
//        affiliation_type_id: 132033,
//      }]
//    }
//
//  TO ADD A CLUB:
//    1. Go to its chronogolf.ca page, open DevTools → Network → Fetch/XHR
//    2. Pick a date so tee times load
//    3. Find the `teetimes?date=...` request
//    4. Copy clubId, courseId, affiliation_type_ids[] from the URL
//    5. Add an entry to CHRONO_CLUBS below
// ─────────────────────────────────────────────────────────────────────────────

const CHRONO_CLUBS = [
  {
    clubId:         221,
    courseId:       152,
    affiliationIds: [132033],
    name:           'Mystic Pines Montreal',
    slug:           'mystic-pines-i-montreal',
    holes:          9,
  },
  {
    clubId:         18364,
    courseId:       21560,
    affiliationIds: [90415],
    name:           'Golf St-Rose',
    slug:           'golf-st-rose',
    holes:          18,
  },
  {
    clubId:         1619,
    courseId:       1871,
    affiliationIds: [7193],
    name:           'Golf Dorval',
    slug:           'golf-dorval',
    holes:          18,
  },
  {
    clubId:         1395,
    courseId:       1584,
    affiliationIds: [6297],
    name:           'Club de Golf Metropolitain Anjou',
    slug:           'club-de-golf-metropolitain-anjou',
    holes:          9,
  },
  {
    clubId:         1594,
    courseId:       1845,
    affiliationIds: [7093],
    name:           'Golf Municipal de Montréal',
    slug:           'golf-municipal-de-montreal',
    holes:          9,
  },
  {
    clubId:         1524,
    courseId:       1763,
    affiliationIds: [6813],
    name:           'Golf St-Lambert',
    slug:           'golf-st-lambert',
    holes:          18,
  },
  {
    clubId:         1509,
    courseId:       1740,
    affiliationIds: [6753],
    name:           'Golf des Îles de Boucherville',
    slug:           'golf-des-iles-de-boucherville',
    holes:          18,
  },
  {
    clubId:         1476,
    courseId:       1704,
    affiliationIds: [6621],
    name:           'Golf St-Janvier',
    slug:           'golf-st-janvier',
    holes:          18,
  },
  {
    clubId:         1397,
    courseId:       1589,
    affiliationIds: [6305],
    name:           'Golf Mirabel - Le Boisé',
    slug:           'golf-mirabel',
    holes:          18,
  },
  {
    clubId:         1397,
    courseId:       1588,
    affiliationIds: [6305],
    name:           'Golf Mirabel - Le Campagnard',
    slug:           'golf-mirabel',
    holes:          18,
  },
  {
    clubId:         18950,
    courseId:       23133,
    affiliationIds: [112078],
    name:           'La Seigneurie',
    slug:           'la-seigneurie',
    holes:          18,
  },
  // Add more: browse club on chronogolf.ca, pick a date,
  // grab the teetimes?date=... URL from DevTools → Headers.
];

async function scrapeChronoGolf(dates) {
  const results = [];

  // Launch real browser — Cloudflare blocks Node fetch but allows real browsers
  const browser = await chromium.launch({
    headless: false,
    args: ['--disable-blink-features=AutomationControlled'],
  });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    locale: 'en-CA',
    extraHTTPHeaders: {
      'Accept-Language': 'en-CA,en;q=0.9,fr-CA;q=0.8',
    },
  });
  // Hide automation flags
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });
  const page = await context.newPage();

  // Navigate to a club page first — looks like a real user to Cloudflare
  console.log('[ChronoGolf] Loading chronogolf.ca to establish session...');
  await page.goto('https://www.chronogolf.ca', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(3000);

  // Navigate to first club page to get full Cloudflare clearance
  const firstClub = CHRONO_CLUBS[0];
  await page.goto(`https://www.chronogolf.ca/club/${firstClub.slug}/teetimes`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(3000);

  for (const club of CHRONO_CLUBS) {
    for (const date of dates) {
      try {
        // Query for each player count (1-4) since Chrono Golf filters server-side
        for (const nbPlayers of [1, 2, 3, 4]) {
        const affiliationParams = club.affiliationIds
          .map(id => `affiliation_type_ids%5B%5D=${id}`)
          .join('&');

        const url = `https://www.chronogolf.ca/marketplace/clubs/${club.clubId}/teetimes` +
                    `?date=${date}&course_id=${club.courseId}&${affiliationParams}&nb_holes=${club.holes}&nb_players=${nbPlayers}`;

        console.log(`[ChronoGolf] Fetching ${club.name} on ${date} (${nbPlayers}p)...`);

        // Use the browser's fetch — has Cloudflare cookies already set
        const response = await page.evaluate(async (fetchUrl) => {
          try {
            const resp = await fetch(fetchUrl, {
              headers: {
                'Accept': 'application/json, text/plain, */*',
                'X-Requested-With': 'XMLHttpRequest',
                'Referer': 'https://www.chronogolf.ca/',
              }
            });
            if (!resp.ok) return { error: resp.status };
            return await resp.json();
          } catch (e) {
            return { error: e.message };
          }
        }, url);

        if (response?.error) {
          console.warn(`[ChronoGolf] HTTP ${response.error} for ${club.name} on ${date}`);
          await sleep(800);
          continue;
        }

        const slots = Array.isArray(response) ? response : [];
        let count = 0;

        for (const slot of slots) {
          if (slot.out_of_capacity) continue;

          const fees = slot.green_fees || [];
          const publicFee = fees.find(f => club.affiliationIds.includes(f.affiliation_type_id));
          const price = publicFee?.green_fee ?? publicFee?.price ?? null;
          // Number of players = number of green_fee entries in the slot
          const nbPlayers = fees.length || 1;

          results.push({
            id:             `chronogolf-${club.clubId}-${club.courseId}-${date}-${slot.start_time}-${nbPlayers}p`,
            source:         'chronogolf',
            courseId:       String(club.courseId),
            courseName:     club.name,
            date,
            time:           slot.start_time,
            holes:          club.holes,
            players:        nbPlayers,
            pricePerPlayer: price,
            currency:       'CAD',
            membersOnly:    false,
            bookingUrl:     `https://www.chronogolf.ca/club/${club.slug}#?date=${date}&course_id=${club.courseId}&nb_holes=${club.holes}&nb_players=${nbPlayers}&affiliation_type_ids=${club.affiliationIds.join(',')}&is_deal=false`,
            rawId:          slot.id,
            uuid:           slot.uuid,
            scrapedAt:      new Date(),
          });
          count++;
        }

        console.log(`[ChronoGolf] ${count} available slots for ${club.name} on ${date} (${nbPlayers}p)`);
        await sleep(300);
        } // end nbPlayers loop

      } catch (err) {
        console.error(`[ChronoGolf] Error ${club.name} ${date}:`, err.message);
      }

      await sleep(800);
    }
  }

  await browser.close();
  return results;
}

// ─────────────────────────────────────────────
// MAIN ORCHESTRATOR
// ─────────────────────────────────────────────

async function runScrape(daysAhead = 7) {
  console.log(`\n[Scraper] ── ${new Date().toISOString()} ──`);

  const dates = [];
  for (let i = 0; i < daysAhead; i++) {
    const d = new Date();
    d.setDate(d.getDate() + i);
    dates.push(d.toISOString().split('T')[0]);
  }

  // Run sequentially to avoid Cloudflare rate limiting on Chrono Golf
  const minuteTimes = await scrapeMinuteGolf(dates);
  const chronoTimes = await scrapeChronoGolf(dates);

  const freshTimes    = [...minuteTimes, ...chronoTimes];
  const existingIds   = new Set(teeTimeCache.map(t => t.id));
  const newlyAppeared = freshTimes.filter(t => !existingIds.has(t.id));

  teeTimeCache   = freshTimes;
  lastScrapeTime = new Date();

  console.log(`[Scraper] Done — ${freshTimes.length} total (${minuteTimes.length} Minute, ${chronoTimes.length} Chrono). ${newlyAppeared.length} new.`);

  if (newlyAppeared.length > 0) await checkAndFireAlerts(newlyAppeared);
}

// ─────────────────────────────────────────────
// ALERT MATCHING & NOTIFICATIONS
// ─────────────────────────────────────────────

async function checkAndFireAlerts(newTeeTimes) {
  for (const alert of alertsStore.filter(a => a.active)) {
    const matches = newTeeTimes.filter(t => matchesAlert(t, alert));
    if (!matches.length) continue;
    if (alert.lastNotifiedAt && Date.now() - alert.lastNotifiedAt < 3_600_000) continue;
    await sendAlertNotification(alert, matches);
    alert.lastNotifiedAt = Date.now();
  }
}

function matchesAlert(t, alert) {
  if (t.membersOnly) return false;
  if (alert.source !== 'all' && alert.source !== t.source) return false;
  if (alert.type === 'course') {
    if (alert.courseId && alert.courseId !== t.courseId) return false;
  }
  if (alert.type === 'date-window') {
    if (alert.date     && alert.date     !== t.date)     return false;
    if (alert.timeFrom && t.time < alert.timeFrom)       return false;
    if (alert.timeTo   && t.time > alert.timeTo)         return false;
  }
  if (alert.players && t.players < parseInt(alert.players)) return false;
  return true;
}

async function sendAlertNotification(alert, matches) {
  const subject = `TeeFind: ${matches.length} tee time(s) just opened up`;
  const body = [
    'A tee time you\'re watching just became available!\n',
    ...matches.map(t =>
      `• ${t.courseName} — ${formatTime12h(t.time)} on ${t.date}\n` +
      `  ${t.pricePerPlayer ? `$${t.pricePerPlayer} CAD/player${t.taxesMode ? ' ' + t.taxesMode : ''}` : 'Price TBD'} · ${t.holes} holes\n` +
      `  Book here: ${t.bookingUrl}`
    ),
    '\n— TeeFind',
  ].join('\n');

  if (alert.contactType === 'email') {
    await sendEmail(alert.contact, subject, body);
  } else {
    await sendSMS(alert.contact, `TeeFind: tee time opened at ${matches[0].courseName} on ${matches[0].date}. Book: ${matches[0].bookingUrl}`);
  }
}

async function sendEmail(to, subject, text) {
  try {
    await nodemailer.createTransport(CONFIG.email).sendMail({ from: CONFIG.email.from, to, subject, text });
    console.log(`[Email] → ${to}`);
  } catch (e) { console.error('[Email] Failed:', e.message); }
}

async function sendSMS(to, body) {
  try {
    const twilio = require('twilio')(CONFIG.twilio.accountSid, CONFIG.twilio.authToken);
    await twilio.messages.create({ body, from: CONFIG.twilio.fromNumber, to });
    console.log(`[SMS] → ${to}`);
  } catch (e) { console.error('[SMS] Failed:', e.message); }
}

// ─────────────────────────────────────────────
// API ROUTES
// ─────────────────────────────────────────────

app.get('/api/tee-times', (req, res) => {
  const { date, source, players, timeFrom, timeTo, holesOnly, membersOnly } = req.query;
  let r = [...teeTimeCache];
  if (date)                       r = r.filter(t => t.date === date);
  if (source && source !== 'all') r = r.filter(t => t.source === source);
  if (players)                    r = r.filter(t => t.players >= parseInt(players));
  if (timeFrom)                   r = r.filter(t => t.time >= timeFrom);
  if (timeTo)                     r = r.filter(t => t.time <= timeTo);
  if (holesOnly)                  r = r.filter(t => t.holes === parseInt(holesOnly));
  if (membersOnly === 'false')    r = r.filter(t => !t.membersOnly);
  r.sort((a, b) => a.date.localeCompare(b.date) || a.time.localeCompare(b.time));
  res.json({ count: r.length, lastUpdated: lastScrapeTime, teeTimes: r });
});

app.get('/api/courses', (req, res) => {
  const seen = {};
  for (const t of teeTimeCache) {
    if (!seen[t.courseId]) seen[t.courseId] = { id: t.courseId, name: t.courseName, source: t.source };
  }
  res.json(Object.values(seen));
});

app.get('/api/status', (req, res) => {
  res.json({
    cachedTeeTimes: teeTimeCache.length,
    lastScrape:     lastScrapeTime,
    activeAlerts:   alertsStore.filter(a => a.active).length,
  });
});

app.post('/api/alerts', (req, res) => {
  const { type, contact, courseId, date, timeFrom, timeTo, players, source } = req.body;
  if (!contact || !type) return res.status(400).json({ error: 'contact and type required' });
  const isEmail = /^[^@]+@[^@]+\.[^@]+$/.test(contact);
  const isPhone = /^\+?[\d\s\-()\\.]{7,}$/.test(contact);
  if (!isEmail && !isPhone) return res.status(400).json({ error: 'invalid contact' });

  const alert = {
    id:              alertIdCounter++,
    type, contact,
    contactType:     isEmail ? 'email' : 'sms',
    courseId:        courseId  || null,
    date:            date      || null,
    timeFrom:        timeFrom  || null,
    timeTo:          timeTo    || null,
    players:         players   ? parseInt(players) : null,
    source:          source    || 'all',
    active:          true,
    createdAt:       new Date(),
    lastNotifiedAt:  null,
  };

  alertsStore.push(alert);
  console.log(`[Alert] Created #${alert.id} for ${contact}`);
  res.status(201).json({ alertId: alert.id });
});

app.delete('/api/alerts/:id', (req, res) => {
  const a = alertsStore.find(a => a.id === parseInt(req.params.id));
  if (!a) return res.status(404).json({ error: 'Not found' });
  a.active = false;
  res.json({ message: 'Cancelled' });
});

// Manual scrape trigger (useful for testing)
app.post('/api/scrape', async (req, res) => {
  res.json({ message: 'Scrape started' });
  runScrape(req.body?.daysAhead || 7).catch(console.error);
});

// ─────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────

function formatTime12h(t) {
  const [h, m] = t.split(':').map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─────────────────────────────────────────────
// STARTUP
// ─────────────────────────────────────────────

app.listen(CONFIG.port, () => console.log(`[Server] TeeFind on http://localhost:${CONFIG.port}`));

cron.schedule(`*/${CONFIG.scrapeIntervalMinutes} * * * *`, () => {
  runScrape().catch(console.error);
});

// Initial scrape 3 seconds after boot
setTimeout(() => runScrape().catch(console.error), 3000);

module.exports = app;