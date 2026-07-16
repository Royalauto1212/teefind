/**
 * TeeFind Backend — Express API + Scraper Engine
 *
 * Sources:
 *  - Minute Golf:  POST API (no browser needed)
 *  - Chrono Golf:  GET API via Playwright (Cloudflare bypass)
 *  - Foreup Golf:  GET API (no browser needed) — used by Caughnawaga + others
 *
 * Run:     node server.js
 * Requires: npm install express cors node-cron nodemailer twilio playwright
 */

const express      = require('express');
const cors         = require('cors');
const cron         = require('node-cron');
const nodemailer   = require('nodemailer');
const { chromium } = require('playwright');

const app = express();
app.use(cors());
app.use(express.json());

const CONFIG = {
  port: 3001,
  scrapeIntervalMinutes: 10,
  email: {
    host:   'smtp.resend.com',
    port:   465,
    secure: true,
    auth:   { user: 'resend', pass: process.env.RESEND_API_KEY || 'YOUR_KEY' },
    from:   'alerts@yourdomain.com',
  },
  twilio: {
    accountSid: process.env.TWILIO_SID   || 'YOUR_SID',
    authToken:  process.env.TWILIO_TOKEN || 'YOUR_TOKEN',
    fromNumber: '+15550000000',
  },
};

let teeTimeCache   = [];
let alertsStore    = [];
let lastScrapeTime = null;
let alertIdCounter = 1;

const HEADERS = {
  'User-Agent':      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept':          'application/json, text/plain, */*',
  'Accept-Language': 'en-CA,en;q=0.9,fr-CA;q=0.8',
  'Accept-Encoding': 'gzip, deflate, br',
};

// ═══════════════════════════════════════════════════════════════════════════
//  MINUTE GOLF
//  One entry per slot. players = maxPlayers (how many spots available).
//  Frontend filters by players >= selected, booking URL uses selected count.
// ═══════════════════════════════════════════════════════════════════════════

const MINUTE_GOLF_URL = 'https://www.minutegolf.ca/index.php?option=com_ggportal&lang=en&export=&format=raw&req=teetimes';

const MINUTE_REGIONS = [
  // { id: 11, name: 'Lanaudière' },
  // { id: 12, name: 'Laurentides' },
  // { id: 13, name: 'Montérégie' },
  { id: 14, name: 'Montreal - Laval' },
];

async function scrapeMinuteGolf(dates) {
  const results = [];

  for (const region of MINUTE_REGIONS) {
    for (const date of dates) {
      try {
        console.log(`[MinuteGolf] Fetching ${region.name} on ${date}...`);

        // Query once per player count — Minute Golf filters server-side
        for (const nbPlayers of [1, 2, 3, 4]) {
          const resp = await fetch(MINUTE_GOLF_URL, {
            method:  'POST',
            headers: {
              ...HEADERS,
              'Content-Type': 'application/x-www-form-urlencoded',
              'Referer':      'https://www.minutegolf.ca/en/reservations',
              'Origin':       'https://www.minutegolf.ca',
            },
            body: new URLSearchParams({
              region_id: String(region.id),
              date,
              nbholes:   '9or18',
              nbplayers: String(nbPlayers),
              search:    'Chercher les départs',
            }).toString(),
          });

          if (!resp.ok) { console.warn(`[MinuteGolf] HTTP ${resp.status}`); continue; }

          const raw  = await resp.json();
          const data = Array.isArray(raw) ? raw : (raw.clubs || []);
          if (!Array.isArray(data) || !data.length) continue;

          let count = 0;
          for (const club of data) {
            for (const course of (club.courses || [])) {
              const courseName = course.name ? `${club.name} — ${course.name}` : club.name;
              for (const slot of (course.teetimes || [])) {
                const price = slot.reservationPricing?.discountedPrice ?? slot.reservationPricing?.price ?? null;
                // Build booking URL with correct player count
                const bookUrl = slot.bookURL
                  ? slot.bookURL.replace(/nbplayers=\d+/, `nbplayers=${nbPlayers}`)
                  : `https://www.minutegolf.ca/en/reservations?date=${date}`;

                results.push({
                  id:             `minutegolf-${club.id}-${date}-${slot.time}-${slot.holes}h-${nbPlayers}p`,
                  source:         'minutegolf',
                  courseId:       String(club.id),
                  courseName,
                  date,
                  time:           slot.time,
                  holes:          slot.holes,
                  players:        nbPlayers,
                  pricePerPlayer: price,
                  currency:       'CAD',
                  taxesMode:      slot.reservationPricing?.taxesMode || null,
                  membersOnly:    false,
                  bookingUrl:     bookUrl,
                  scrapedAt:      new Date(),
                });
                count++;
              }
            }
          }
          console.log(`[MinuteGolf] ${count} slots for ${region.name} on ${date} (${nbPlayers}p)`);
          await sleep(300);
        } // end nbPlayers loop

      } catch (err) {
        console.error(`[MinuteGolf] Error ${region.id} on ${date}:`, err.message);
      }
      await sleep(400);
    }
  }
  return results;
}

// ═══════════════════════════════════════════════════════════════════════════
//  FOREUP GOLF
//  One entry per slot per allowed group size (from allowed_group_sizes).
//  Includes minPlayers so frontend can show a warning badge.
// ═══════════════════════════════════════════════════════════════════════════

const FOREUP_CLUBS = [
  {
    courseId:       8116,
    scheduleId:     1000,
    bookingClassId: 51525,
    name:           'Caughnawaga Golf Club',
    holes:          18,
  },
];

async function scrapeForeuUpGolf(dates) {
  const results = [];

  for (const club of FOREUP_CLUBS) {
    for (const date of dates) {
      try {
        const [year, month, day] = date.split('-');
        const foreuDate = `${month}-${day}-${year}`;
        const url = `https://foreupsoftware.com/index.php/api/booking/times` +
          `?time=all&date=${foreuDate}&holes=all&players=0` +
          `&booking_class=${club.bookingClassId}` +
          `&schedule_id=${club.scheduleId}` +
          `&schedule_ids%5B%5D=${club.scheduleId}` +
          `&specials_only=0&api_key=`;

        console.log(`[Foreup] Fetching ${club.name} on ${date}...`);
        const resp = await fetch(url, {
          headers: { ...HEADERS, 'Referer': `https://foreupsoftware.com/index.php/booking/${club.courseId}/${club.scheduleId}` }
        });

        if (!resp.ok) { console.warn(`[Foreup] HTTP ${resp.status}`); continue; }
        const slots = await resp.json();
        if (!Array.isArray(slots)) { console.warn(`[Foreup] Unexpected response`); continue; }

        let count = 0;
        for (const slot of slots) {
          if (!slot.available_spots) continue;
          const timePart = slot.time?.split(' ')[1];
          if (!timePart) continue;

          const price        = slot.green_fee_18 || slot.green_fee || null;
          const allowedSizes = (slot.allowed_group_sizes || []).map(Number);
          const minPlayers   = allowedSizes.length > 0 ? Math.min(...allowedSizes) : 1;
          const maxPlayers   = Math.min(slot.available_spots, slot.maximum_players_per_booking || 4);

          // One entry per player count 1..maxPlayers
          // minPlayers stored so frontend can show "Min. N players" badge
          for (let players = 1; players <= maxPlayers; players++) {
            results.push({
              id:             `foreup-${club.courseId}-${date}-${timePart}-${players}p`,
              source:         'foreup',
              courseId:       String(club.courseId),
              courseName:     club.name,
              date,
              time:           timePart,
              holes:          slot.teesheet_holes || club.holes,
              players,
              minPlayers,
              pricePerPlayer: price,
              currency:       'CAD',
              membersOnly:    false,
              bookingUrl:     `https://foreupsoftware.com/index.php/booking/${club.courseId}/${club.scheduleId}#teetimes`,
              courseUrl:      `https://foreupsoftware.com/index.php/booking/${club.courseId}/${club.scheduleId}`,
              scrapedAt:      new Date(),
            });
            count++;
          }
        }
        console.log(`[Foreup] ${count} entries for ${club.name} on ${date}`);

      } catch (err) {
        console.error(`[Foreup] Error ${club.name} ${date}:`, err.message);
      }
      await sleep(400);
    }
  }
  return results;
}

// ═══════════════════════════════════════════════════════════════════════════
//  CHRONO GOLF — via Playwright
//  Query once with nb_players=4 to get maximum availability.
//  players = green_fees.length (actual available spots for this query).
//  Frontend filters by players >= selected.
// ═══════════════════════════════════════════════════════════════════════════

const CHRONO_CLUBS = [
  { clubId: 221,   courseId: 152,   affiliationIds: [132033], name: 'Mystic Pines Montreal',              slug: 'mystic-pines-i-montreal',           holes: 9  },
  { clubId: 18364, courseId: 21560, affiliationIds: [90415],  name: 'Golf St-Rose',                       slug: 'golf-st-rose',                      holes: 18 },
  { clubId: 1619,  courseId: 1871,  affiliationIds: [7193],   name: 'Golf Dorval',                        slug: 'golf-dorval',                       holes: 18 },
  { clubId: 1395,  courseId: 1584,  affiliationIds: [6297],   name: 'Club de Golf Metropolitain Anjou (9)',  slug: 'club-de-golf-metropolitain-anjou',   holes: 9  },
  { clubId: 1395,  courseId: 1584,  affiliationIds: [6297],   name: 'Club de Golf Metropolitain Anjou (18)', slug: 'club-de-golf-metropolitain-anjou',   holes: 18 },
  { clubId: 1594,  courseId: 1845,  affiliationIds: [7093],   name: 'Golf Municipal de Montréal',         slug: 'golf-municipal-de-montreal',         holes: 9  },
  { clubId: 1524,  courseId: 1763,  affiliationIds: [6813],   name: 'Golf St-Lambert',                    slug: 'golf-st-lambert',                   holes: 18 },
  { clubId: 1509,  courseId: 1740,  affiliationIds: [6753],   name: 'Golf des Îles de Boucherville',      slug: 'golf-des-iles-de-boucherville',      holes: 18 },
  { clubId: 1476,  courseId: 1704,  affiliationIds: [6621],   name: 'Golf St-Janvier',                    slug: 'golf-st-janvier',                   holes: 18 },
  { clubId: 1397,  courseId: 1589,  affiliationIds: [6305],   name: 'Golf Mirabel - Le Boisé',            slug: 'golf-mirabel',                      holes: 18 },
  { clubId: 1397,  courseId: 1588,  affiliationIds: [6305],   name: 'Golf Mirabel - Le Campagnard',       slug: 'golf-mirabel',                      holes: 18 },
  { clubId: 18950, courseId: 23133, affiliationIds: [112078], name: 'La Seigneurie',                      slug: 'la-seigneurie',                     holes: 18 },
];

async function scrapeChronoGolf(dates) {
  const results = [];

  const browser = await chromium.launch({
    headless: false,
    args: ['--disable-blink-features=AutomationControlled'],
  });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    locale: 'en-CA',
    extraHTTPHeaders: { 'Accept-Language': 'en-CA,en;q=0.9,fr-CA;q=0.8' },
  });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });
  const page = await context.newPage();

  console.log('[ChronoGolf] Establishing session...');
  await page.goto('https://www.chronogolf.ca', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(3000);
  await page.goto(`https://www.chronogolf.ca/club/${CHRONO_CLUBS[0].slug}/teetimes`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(3000);

  for (const club of CHRONO_CLUBS) {
    for (const date of dates) {
      try {
        for (const nbPlayers of [1, 2, 3, 4]) {
        const affiliationParams = club.affiliationIds.map(id => `affiliation_type_ids%5B%5D=${id}`).join('&');
        const url = `https://www.chronogolf.ca/marketplace/clubs/${club.clubId}/teetimes` +
          `?date=${date}&course_id=${club.courseId}&${affiliationParams}&nb_holes=${club.holes}&nb_players=${nbPlayers}`;

        console.log(`[ChronoGolf] Fetching ${club.name} on ${date} (${nbPlayers}p)...`);

        const response = await page.evaluate(async (fetchUrl) => {
          try {
            const resp = await fetch(fetchUrl, {
              headers: {
                'Accept':           'application/json, text/plain, */*',
                'X-Requested-With': 'XMLHttpRequest',
                'Referer':          'https://www.chronogolf.ca/',
              }
            });
            if (!resp.ok) return { error: resp.status };
            return await resp.json();
          } catch (e) {
            return { error: e.message };
          }
        }, url);

        if (response?.error) {
          console.warn(`[ChronoGolf] Error ${response.error} for ${club.name} on ${date}`);
          await sleep(800);
          continue;
        }

        const slots = Array.isArray(response) ? response : [];
        let count = 0;

        for (const slot of slots) {
          if (slot.out_of_capacity) continue;

          const fees      = slot.green_fees || [];
          const publicFee = fees.find(f => club.affiliationIds.includes(f.affiliation_type_id));
          const price     = publicFee?.green_fee ?? publicFee?.price ?? null;
          const players   = nbPlayers;

          results.push({
            id:             `chronogolf-${club.clubId}-${club.courseId}-${date}-${slot.start_time}-${nbPlayers}p`,
            source:         'chronogolf',
            courseId:       String(club.courseId),
            courseName:     club.name,
            date,
            time:           slot.start_time,
            holes:          club.holes,
            players,
            pricePerPlayer: price,
            currency:       'CAD',
            membersOnly:    false,
            bookingUrl:     `https://www.chronogolf.ca/club/${club.slug}#?date=${date}&course_id=${club.courseId}&nb_holes=${club.holes}&nb_players=${players}&affiliation_type_ids=${club.affiliationIds.join(',')}&is_deal=false`,
            courseUrl:      `https://www.chronogolf.ca/club/${club.slug}`,
            rawId:          slot.id,
            uuid:           slot.uuid,
            scrapedAt:      new Date(),
          });
          count++;
        }

        console.log(`[ChronoGolf] ${count} slots for ${club.name} on ${date} (${nbPlayers}p)`);
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

  const minuteTimes = await scrapeMinuteGolf(dates);
  const foreupTimes = await scrapeForeuUpGolf(dates);
  const chronoTimes = await scrapeChronoGolf(dates);

  const freshTimes    = [...minuteTimes, ...foreupTimes, ...chronoTimes];
  const existingIds   = new Set(teeTimeCache.map(t => t.id));
  const newlyAppeared = freshTimes.filter(t => !existingIds.has(t.id));

  teeTimeCache   = freshTimes;
  lastScrapeTime = new Date();

  console.log(`[Scraper] Done — ${freshTimes.length} total (${minuteTimes.length} Minute, ${foreupTimes.length} Foreup, ${chronoTimes.length} Chrono). ${newlyAppeared.length} new.`);
  if (newlyAppeared.length > 0) await checkAndFireAlerts(newlyAppeared);
}

// ─────────────────────────────────────────────
// ALERTS
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
  if (alert.type === 'course' && alert.courseId && alert.courseId !== t.courseId) return false;
  if (alert.type === 'date-window') {
    if (alert.date     && alert.date     !== t.date)   return false;
    if (alert.timeFrom && t.time < alert.timeFrom)     return false;
    if (alert.timeTo   && t.time > alert.timeTo)       return false;
  }
  if (alert.players && t.players < parseInt(alert.players)) return false;
  return true;
}

async function sendAlertNotification(alert, matches) {
  const subject = `TeeFind: ${matches.length} tee time(s) just opened up`;
  const body = [
    "A tee time you're watching just became available!\n",
    ...matches.map(t =>
      `• ${t.courseName} — ${formatTime12h(t.time)} on ${t.date}\n` +
      `  ${t.pricePerPlayer ? `$${t.pricePerPlayer} CAD/player` : 'Price TBD'} · ${t.holes} holes\n` +
      `  Book here: ${t.bookingUrl}`
    ),
    '\n— TeeFind',
  ].join('\n');
  if (alert.contactType === 'email') await sendEmail(alert.contact, subject, body);
  else await sendSMS(alert.contact, `TeeFind: tee time opened at ${matches[0].courseName} on ${matches[0].date}. Book: ${matches[0].bookingUrl}`);
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
  res.json({ cachedTeeTimes: teeTimeCache.length, lastScrape: lastScrapeTime, activeAlerts: alertsStore.filter(a => a.active).length });
});

app.post('/api/alerts', (req, res) => {
  const { type, contact, courseId, date, timeFrom, timeTo, players, source } = req.body;
  if (!contact || !type) return res.status(400).json({ error: 'contact and type required' });
  const isEmail = /^[^@]+@[^@]+\.[^@]+$/.test(contact);
  const isPhone = /^\+?[\d\s\-()\\.]{7,}$/.test(contact);
  if (!isEmail && !isPhone) return res.status(400).json({ error: 'invalid contact' });
  const alert = {
    id: alertIdCounter++, type, contact,
    contactType: isEmail ? 'email' : 'sms',
    courseId: courseId || null, date: date || null,
    timeFrom: timeFrom || null, timeTo: timeTo || null,
    players: players ? parseInt(players) : null,
    source: source || 'all', active: true,
    createdAt: new Date(), lastNotifiedAt: null,
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
cron.schedule(`*/${CONFIG.scrapeIntervalMinutes} * * * *`, () => runScrape().catch(console.error));
setTimeout(() => runScrape().catch(console.error), 3000);
module.exports = app;