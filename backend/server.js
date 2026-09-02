/**
 * TeeFind Backend — Express API + Scraper Engine
 */

require('dotenv').config();
const { Resend } = require('resend');
const resend = new Resend(process.env.RESEND_API_KEY);
const Stripe = require('stripe');
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const premiumUsers = new Set();

const express = require('express');
const cors    = require('cors');
const cron    = require('node-cron');

const app = express();
app.use(cors());
app.use(express.json());

const CONFIG = { port: 3001 };

let teeTimeCache   = [];
let alertsStore    = [];
let lastScrapeTime = null;
let alertIdCounter = 1;
let isScraping     = false;

const CHRONO_WORKER = 'https://chrono-proxy.markusfares.workers.dev';

const HEADERS = {
  'User-Agent':      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept':          'application/json, text/plain, */*',
  'Accept-Language': 'en-CA,en;q=0.9,fr-CA;q=0.8',
};

// ═══════════════════════════════════════════════════════════
//  MINUTE GOLF
// ═══════════════════════════════════════════════════════════

const MINUTE_GOLF_URL = 'https://www.minutegolf.ca/index.php?option=com_ggportal&lang=en&export=&format=raw&req=teetimes';

const MINUTE_REGIONS = [
  { id: 11, name: 'Lanaudière' },
  { id: 12, name: 'Laurentides' },
  { id: 13, name: 'Montérégie' },
  { id: 14, name: 'Montreal - Laval' },
];

const MINUTE_GOLF_ALLOWED_KEYWORDS = [
  'st-francois', 'saint-francois',
  'versant',
  'triangle',
  'atlantide', 'atlantides',
  'champetre',
  'cardinal',
  'ufo',
  'ile de montreal', 'ile-de-montreal',
];

function normalizeClubName(name) {
  return (name || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

function isAllowedMinuteGolfClub(name) {
  const normalized = normalizeClubName(name);
  return MINUTE_GOLF_ALLOWED_KEYWORDS.some(k => normalized.includes(k));
}

function isAllowedCourse(clubName, courseName) {
  const club = normalizeClubName(clubName);
  const course = normalizeClubName(courseName || '');
  if (club.includes('versant')) {
    return course.includes('versant #1') || course.includes('versant #2');
  }
  return true;
}

async function scrapeMinuteGolf(dates) {
  const results = [];
  for (const region of MINUTE_REGIONS) {
    for (const date of dates) {
      try {
        console.log(`[MinuteGolf] Fetching ${region.name} on ${date}...`);
        for (const nbPlayers of [1, 2, 3, 4]) {
          const resp = await fetch(MINUTE_GOLF_URL, {
            method: 'POST',
            headers: { ...HEADERS, 'Content-Type': 'application/x-www-form-urlencoded', 'Referer': 'https://www.minutegolf.ca/en/reservations', 'Origin': 'https://www.minutegolf.ca' },
            body: new URLSearchParams({ region_id: String(region.id), date, nbholes: '9or18', nbplayers: String(nbPlayers), search: 'Chercher les départs' }).toString(),
          });
          if (!resp.ok) continue;
          const raw  = await resp.json();
          const data = Array.isArray(raw) ? raw : (raw.clubs || []);
          if (!Array.isArray(data) || !data.length) continue;
          if (nbPlayers === 1) console.log(`[MinuteGolf][DEBUG] ${region.name} clubs: ${data.map(c => `${c.id}:${c.name}`).join(' | ')}`);
          const allowedData = data.filter(club => isAllowedMinuteGolfClub(club.name));
          let count = 0;
          for (const club of allowedData) {
            for (const course of (club.courses || [])) {
              if (!isAllowedCourse(club.name, course.name)) continue;
              const courseName = course.name ? `${club.name} — ${course.name}` : club.name;
              for (const slot of (course.teetimes || [])) {
                const price = slot.reservationPricing?.discountedPrice ?? slot.reservationPricing?.price ?? null;
                const bookUrl = slot.bookURL ? slot.bookURL.replace(/nbplayers=\d+/, `nbplayers=${nbPlayers}`) : `https://www.minutegolf.ca/en/reservations?date=${date}`;
                results.push({
                  id: `minutegolf-${club.id}-${date}-${slot.time}-${slot.holes}h-${nbPlayers}p`,
                  source: 'minutegolf', courseId: String(club.id), courseName, date,
                  time: slot.time, holes: slot.holes, players: nbPlayers,
                  pricePerPlayer: price, currency: 'CAD', taxesMode: slot.reservationPricing?.taxesMode || null,
                  membersOnly: false, bookingUrl: bookUrl, scrapedAt: new Date(),
                });
                count++;
              }
            }
          }
          console.log(`[MinuteGolf] ${count} slots for ${region.name} on ${date} (${nbPlayers}p)`);
          await sleep(800);
        }
      } catch (err) { console.error(`[MinuteGolf] Error ${region.id} on ${date}:`, err.message); }
      await sleep(400);
    }
  }
  return results;
}

// ═══════════════════════════════════════════════════════════
//  FOREUP GOLF
// ═══════════════════════════════════════════════════════════

const FOREUP_CLUBS = [
  { courseId: 8116, scheduleId: 1000, bookingClassId: 51525, name: 'Caughnawaga Golf Club', holes: 18 },
];

async function scrapeForeuUpGolf(dates) {
  const results = [];
  for (const club of FOREUP_CLUBS) {
    for (const date of dates) {
      try {
        const [year, month, day] = date.split('-');
        const foreuDate = `${month}-${day}-${year}`;
        const url = `https://foreupsoftware.com/index.php/api/booking/times?time=all&date=${foreuDate}&holes=all&players=0&booking_class=${club.bookingClassId}&schedule_id=${club.scheduleId}&schedule_ids%5B%5D=${club.scheduleId}&specials_only=0&api_key=`;
        const workerUrl = `${CHRONO_WORKER}?url=${encodeURIComponent(url)}`;
        const resp = await fetch(workerUrl, { headers: HEADERS });
        if (!resp.ok) continue;
        const slots = await resp.json();
        if (!Array.isArray(slots)) continue;
        let count = 0;
        for (const slot of slots) {
          if (!slot.available_spots) continue;
          const timePart = slot.time?.split(' ')[1];
          if (!timePart) continue;
          const price = slot.green_fee_18 || slot.green_fee || null;
          const maxPlayers = Math.min(slot.available_spots, slot.maximum_players_per_booking || 4);
          const minPlayers = (slot.allowed_group_sizes?.length > 0) ? Math.min(...slot.allowed_group_sizes.map(Number)) : 1;
          for (let players = 1; players <= maxPlayers; players++) {
            results.push({
              id: `foreup-${club.courseId}-${date}-${timePart}-${players}p`,
              source: 'foreup', courseId: String(club.courseId), courseName: club.name, date,
              time: timePart, holes: slot.teesheet_holes || club.holes, players, minPlayers,
              pricePerPlayer: price, currency: 'CAD', membersOnly: false,
              bookingUrl: `https://foreupsoftware.com/index.php/booking/${club.courseId}/${club.scheduleId}#teetimes`,
              courseUrl: `https://foreupsoftware.com/index.php/booking/${club.courseId}/${club.scheduleId}`,
              scrapedAt: new Date(),
            });
            count++;
          }
        }
        console.log(`[Foreup] ${count} entries for ${club.name} on ${date}`);
      } catch (err) { console.error(`[Foreup] Error ${club.name} ${date}:`, err.message); }
      await sleep(400);
    }
  }
  return results;
}

// ═══════════════════════════════════════════════════════════
//  CHRONO GOLF V2 (uses min/max player size)
// ═══════════════════════════════════════════════════════════

const CHRONO_V2_CLUBS = [
  { courseUuid: 'a54a368d-f2e2-4c94-8111-792ad2781616', clubId: 221,   courseId: 152,   affiliationIds: [132033], name: 'Mystic Pines Montreal',            slug: 'mystic-pines-i-montreal'          },
  { courseUuid: '9d02c695-92ad-49d4-ac4f-43199c8c46e1', clubId: 1619,  courseId: 1871,  affiliationIds: [7193],   name: 'Golf Dorval',                      slug: 'golf-dorval'                      },
  { courseUuid: 'fb4614de-ed4c-4f92-99ce-0ef19038c6ee', clubId: 1395,  courseId: 1584,  affiliationIds: [6297],   name: 'Club de Golf Metropolitain Anjou', slug: 'club-de-golf-metropolitain-anjou' },
  { courseUuid: '65397bfa-7e70-469b-bd9f-191e275a33e9', clubId: 1594,  courseId: 1845,  affiliationIds: [7093],   name: 'Golf Municipal de Montréal',       slug: 'golf-municipal-de-montreal'       },
  { courseUuid: 'b93c771d-1943-430e-86f6-27c5f330443d', clubId: 1524,  courseId: 1763,  affiliationIds: [6813],   name: 'Golf St-Lambert',                  slug: 'golf-st-lambert'                  },
  { courseUuid: 'c6872cec-8c75-473e-8ff0-19588efbc2c0', clubId: 1509,  courseId: 1740,  affiliationIds: [6753],   name: 'Golf des Îles de Boucherville',    slug: 'golf-des-iles-de-boucherville'    },
  { courseUuid: '93b10ca7-9fb0-40d3-98f3-1a17acd9b80f', clubId: 1476,  courseId: 1704,  affiliationIds: [6621],   name: 'Golf St-Janvier',                  slug: 'golf-st-janvier'                  },
  { courseUuid: '844bc3ef-34b2-4d54-a14b-f85f074113e8', clubId: 18950, courseId: 23133, affiliationIds: [112078], name: 'La Seigneurie',                    slug: 'club-de-golf-la-seigneurie'       },
  { courseUuid: '394f1a7b-9183-490b-b772-86f3501bcc80', clubId: 18890, courseId: 22977, affiliationIds: [109868], name: 'Falcon Golf Course',                slug: 'falcon-golf-course-quebec'        },
];

async function scrapeChronoGolfV2(dates) {
  const results = [];
  const v2CourseUuids = CHRONO_V2_CLUBS.map(c => c.courseUuid);

  for (const date of dates) {
    const chronoUrl = `https://www.chronogolf.ca/marketplace/v2/teetimes?start_date=${date}&course_ids=${v2CourseUuids.join(',')}&holes=9,18&start_time=00:00&page=1`;
    const url = `${CHRONO_WORKER}?url=${encodeURIComponent(chronoUrl)}`;
    console.log(`[ChronoGolf V2] Fetching all clubs on ${date}...`);

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);
      const resp = await fetch(url, { headers: HEADERS, signal: controller.signal });
      clearTimeout(timeout);
      if (!resp.ok) { console.warn(`[ChronoGolf V2] HTTP ${resp.status} on ${date}`); await sleep(800); continue; }

      let data;
      try { data = await resp.json(); } catch(e) { console.warn(`[ChronoGolf V2] JSON error on ${date}`); await sleep(800); continue; }
      if (!data.teetimes) { console.warn(`[ChronoGolf V2] No teetimes on ${date}, status:`, data.status); await sleep(800); continue; }

      const slots = data.teetimes;
      let count = 0;

      for (const slot of slots) {
        const courseUuid = slot.course?.uuid;
        const club = CHRONO_V2_CLUBS.find(c => c.courseUuid === courseUuid);
        if (!club) continue;

        const pmin = slot.min_player_size || 1;
        const pmax = slot.max_player_size || 4;
        const price = slot.default_price?.green_fee ?? null;
        const cartPrice = slot.default_price?.half_cart ?? null;
        const holes = slot.course?.holes || 18;

        for (let nbPlayers = pmin; nbPlayers <= pmax; nbPlayers++) {
          results.push({
            id:             `chronogolf-${club.clubId}-${club.courseId}-${date}-${slot.start_time}-${nbPlayers}p`,
            source:         'chronogolf',
            courseId:       String(club.courseId),
            courseName:     club.name,
            date,
            time:           slot.start_time,
            holes,
            players:        nbPlayers,
            minPlayers:     pmin,
            pricePerPlayer: price,
            cartPrice,
            currency:       'CAD',
            membersOnly:    false,
            bookingUrl:     `https://www.chronogolf.ca/club/${club.slug}/widget#/teesheet?date=${date}&course_id=${club.courseId}&nb_holes=${holes}&affiliation_type_ids=${Array(nbPlayers).fill(club.affiliationIds[0]).join(',')}&teetime_id=${slot.id}&is_deal=false`,
            courseUrl:      `https://www.chronogolf.ca/club/${club.slug}`,
            rawId:          slot.id,
            uuid:           slot.uuid,
            scrapedAt:      new Date(),
          });
          count++;
        }
      }

      console.log(`[ChronoGolf V2] ${count} slots on ${date}`);
    } catch (err) { console.error(`[ChronoGolf V2] Error on ${date}:`, err.message); }
    await sleep(800);
  }
  return results;
}

// ═══════════════════════════════════════════════════════════
//  CHRONO GOLF V1 (St-Rose, Mirabel, International 2000)
// ═══════════════════════════════════════════════════════════

const CHRONO_V1_CLUBS = [
  { clubId: 18364, courseId: 21560, affiliationIds: [90415],  name: 'Golf St-Rose',                                         slug: 'ste-rose',              holes: 18 },
  { clubId: 1397,  courseId: 1589,  affiliationIds: [6305],   name: 'Golf Mirabel - Le Boisé',                             slug: 'club-de-golf-mirabel',  holes: 18 },
  { clubId: 1397,  courseId: 1588,  affiliationIds: [6305],   name: 'Golf Mirabel - Le Campagnard',                        slug: 'club-de-golf-mirabel',  holes: 18 },
  { clubId: 1411,  courseId: 20766, affiliationIds: [6361],   name: 'Golf International 2000 — A (St-Bernard/Champlain)',  slug: 'golf-international-2000', holes: 18 },
  { clubId: 1411,  courseId: 1619,  affiliationIds: [6361],   name: 'Golf International 2000 — B (Champlain/America)',     slug: 'golf-international-2000', holes: 18 },
  { clubId: 1411,  courseId: 1618,  affiliationIds: [6361],   name: 'Golf International 2000 — D (America/St-Bernard)',    slug: 'golf-international-2000', holes: 18 },
];

async function scrapeChronoGolfV1(dates) {
  const results = [];
  const priceCache = {};

  for (const club of CHRONO_V1_CLUBS) {
    for (const date of dates) {
      try {
        for (const nbPlayers of [1, 2, 3, 4]) {
          const affiliationParams = club.affiliationIds.map(id => `affiliation_type_ids[]=${id}`).join('&');
          const chronoUrl = `https://www.chronogolf.ca/marketplace/clubs/${club.clubId}/teetimes?date=${date}&course_id=${club.courseId}&${affiliationParams}&nb_holes=${club.holes}&nb_players=${nbPlayers}`;
          const url = `${CHRONO_WORKER}?url=${encodeURIComponent(chronoUrl)}`;

          console.log(`[ChronoGolf] Fetching ${club.name} on ${date} (${nbPlayers}p)...`);

          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 15000);
          const resp = await fetch(url, { headers: HEADERS, signal: controller.signal });
          clearTimeout(timeout);
          const response = resp.ok ? await resp.json() : { error: resp.status };

          if (response?.error) { console.warn(`[ChronoGolf] Error ${response.error} for ${club.name} on ${date}`); await sleep(800); continue; }

          const slots = Array.isArray(response) ? response : [];
          let count = 0;

          for (const slot of slots) {
            if (slot.out_of_capacity) continue;
            const fees = slot.green_fees || [];
            const publicFee = fees.find(f => club.affiliationIds.includes(f.affiliation_type_id));
            const price = publicFee?.green_fee ?? publicFee?.price ?? priceCache[`${club.clubId}-${slot.start_time}-${date}`] ?? null;
            if (price) priceCache[`${club.clubId}-${slot.start_time}-${date}`] = price;

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
              cartPrice:      publicFee?.half_cart ?? publicFee?.half_cart_price ?? null,
              currency:       'CAD',
              membersOnly:    false,
              bookingUrl:     `https://www.chronogolf.ca/club/${club.slug}/widget#/teesheet?date=${date}&course_id=${club.courseId}&nb_holes=${club.holes}&affiliation_type_ids=${Array(nbPlayers).fill(club.affiliationIds[0]).join(',')}&teetime_id=${slot.id}&is_deal=false`,
              courseUrl:      `https://www.chronogolf.ca/club/${club.slug}`,
              rawId:          slot.id,
              uuid:           slot.uuid,
              scrapedAt:      new Date(),
            });
            count++;
          }

          console.log(`[ChronoGolf] ${count} slots for ${club.name} on ${date} (${nbPlayers}p)`);
          await sleep(800);
        }
      } catch (err) { console.error(`[ChronoGolf] Error ${club.name} ${date}:`, err.message); }
      await sleep(800);
    }
  }
  return results;
}

// ═══════════════════════════════════════════════════════════
//  MAIN ORCHESTRATOR
// ═══════════════════════════════════════════════════════════

async function runScrape(daysAhead = 7) {
  if (isScraping) { console.log('[Scraper] Already running, skipping.'); return; }
  isScraping = true;
  console.log(`\n[Scraper] ── ${new Date().toISOString()} ──`);

  const dates = [];
  for (let i = 0; i < daysAhead; i++) {
    const d = new Date(); d.setDate(d.getDate() + i);
    dates.push(d.toLocaleDateString('en-CA', { timeZone: 'America/Toronto' }));
  }

  try {
    const minuteTimes = await scrapeMinuteGolf(dates);
    const foreupTimes = await scrapeForeuUpGolf(dates);

    // Cache Minute+Foreup immediately, keeping existing Chrono data
    const existingChrono = teeTimeCache.filter(t => t.source === 'chronogolf');
    teeTimeCache = [...minuteTimes, ...foreupTimes, ...existingChrono];
    lastScrapeTime = new Date();
    console.log('[Scraper] Minute+Foreup cached, starting Chrono...');

    const chronoV2Times = await scrapeChronoGolfV2(dates);
    const chronoV1Times = await scrapeChronoGolfV1(dates);
    const allChronoTimes = [...chronoV2Times, ...chronoV1Times];

    const freshTimes = [...minuteTimes, ...foreupTimes, ...allChronoTimes];
    const existingIds = new Set(teeTimeCache.map(t => t.id));
    const newlyAppeared = freshTimes.filter(t => !existingIds.has(t.id));

    teeTimeCache = freshTimes;
    lastScrapeTime = new Date();

    console.log(`[Scraper] Done — ${freshTimes.length} total (${minuteTimes.length} Minute, ${foreupTimes.length} Foreup, ${allChronoTimes.length} Chrono). ${newlyAppeared.length} new.`);
    if (newlyAppeared.length > 0) await checkAndFireAlerts(newlyAppeared);
  } finally {
    isScraping = false;
  }
}

// ═══════════════════════════════════════════════════════════
//  ALERTS
// ═══════════════════════════════════════════════════════════

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
  if (alert.courseIds?.length > 0 && !alert.courseIds.includes(t.courseId)) return false;
  else if (!alert.courseIds && alert.courseId && alert.courseId !== t.courseId) return false;
  if (alert.date && alert.date !== t.date) return false;
  if (alert.timeFrom && t.time < alert.timeFrom) return false;
  if (alert.timeTo && t.time > alert.timeTo) return false;
  if (alert.players && t.players < parseInt(alert.players)) return false;
  return true;
}

async function sendAlertNotification(alert, matches) {
  const subject = `⛳ Tee time available at ${matches[0].courseName}`;
  const body = [
    `A tee time just opened up that matches your alert!`, '',
    ...matches.slice(0, 5).map(t =>
      `📍 ${t.courseName}\n🕐 ${formatTime12h(t.time)} on ${t.date}\n💰 ${t.pricePerPlayer ? `$${t.pricePerPlayer} CAD/player` : 'Price TBD'} · ${t.holes} holes\n👉 Book now: ${t.bookingUrl}`
    ),
    '', matches.length > 5 ? `...and ${matches.length - 5} more.` : '',
    '— TeeFind', 'teefind.ca',
  ].filter(Boolean).join('\n');
  await sendEmail(alert.contact, subject, body);
}

async function sendEmail(to, subject, text) {
  try {
    await resend.emails.send({ from: 'TeeFind <alerts@teefind.ca>', to, subject, text });
    console.log(`[Email] → ${to}`);
  } catch (e) { console.error('[Email] Failed:', e.message); }
}

// ═══════════════════════════════════════════════════════════
//  API ROUTES
// ═══════════════════════════════════════════════════════════

app.get('/api/tee-times', (req, res) => {
  const { date, players, timeFrom, timeTo, holesOnly, membersOnly } = req.query;
  let r = [...teeTimeCache];
  if (date) r = r.filter(t => t.date === date);
  if (players) r = r.filter(t => t.source === 'foreup' ? t.players >= parseInt(players) : t.players === parseInt(players));
  if (timeFrom) r = r.filter(t => t.time >= timeFrom);
  if (timeTo) r = r.filter(t => t.time <= timeTo);
  if (holesOnly) r = r.filter(t => t.holes === parseInt(holesOnly));
  if (membersOnly === 'false') r = r.filter(t => !t.membersOnly);
  const now = new Date();
  const todayStr = now.toLocaleDateString('en-CA', { timeZone: 'America/Toronto' });
  const currentTime = now.toLocaleTimeString('en-CA', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'America/Toronto' });
  r = r.filter(t => t.date > todayStr || (t.date === todayStr && t.time > currentTime));
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
  const { type, contact, courseId, courseIds, date, timeFrom, timeTo, players } = req.body;
  if (!contact || !type) return res.status(400).json({ error: 'contact and type required' });
  const isEmail = /^[^@]+@[^@]+\.[^@]+$/.test(contact);
  const isPhone = /^\+?[\d\s\-()\\.]{7,}$/.test(contact);
  if (!isEmail && !isPhone) return res.status(400).json({ error: 'invalid contact' });
  const userAlerts = alertsStore.filter(a => a.contact === contact && a.active);
  if (userAlerts.length >= 1 && !premiumUsers.has(contact)) {
    return res.status(403).json({ error: 'free_limit', message: 'Upgrade to Premium for unlimited alerts' });
  }
  const alert = {
    id: alertIdCounter++, type, contact,
    contactType: isEmail ? 'email' : 'sms',
    courseIds: courseIds || null, courseId: courseId || null,
    date: date || null, timeFrom: timeFrom || null, timeTo: timeTo || null,
    players: players ? parseInt(players) : null,
    active: true, createdAt: new Date(), lastNotifiedAt: null,
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

app.post('/api/suggest-course', async (req, res) => {
  const { courseName, email } = req.body;
  if (!courseName) return res.status(400).json({ error: 'courseName required' });
  await sendEmail('markusfares@outlook.com', `TeeFind: Course suggestion — ${courseName}`, `Course suggested: ${courseName}\nFrom: ${email || 'anonymous'}\nDate: ${new Date().toISOString()}`);
  res.json({ message: 'Suggestion received' });
});

app.post('/api/create-checkout', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'email required' });
  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'], mode: 'subscription', customer_email: email,
      line_items: [{ price: process.env.STRIPE_PRICE_ID, quantity: 1 }],
      success_url: 'https://teefind.ca?premium=success',
      cancel_url: 'https://teefind.ca?premium=cancelled',
    });
    res.json({ url: session.url });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/stripe-webhook', express.raw({ type: 'application/json' }), (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;
  try { event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET || ''); }
  catch (e) { return res.status(400).send(`Webhook Error: ${e.message}`); }
  if (event.type === 'customer.subscription.created' || event.type === 'invoice.payment_succeeded') {
    const email = event.data.object.customer_email || event.data.object.receipt_email;
    if (email) { premiumUsers.add(email); console.log(`[Stripe] Premium: ${email}`); }
  }
  if (event.type === 'customer.subscription.deleted') {
    const email = event.data.object.customer_email;
    if (email) premiumUsers.delete(email);
  }
  res.json({ received: true });
});

app.get('/api/is-premium', (req, res) => {
  res.json({ premium: premiumUsers.has(req.query.email) });
});

app.post('/api/test-alert', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'email required' });
  await sendEmail(email, '⛳ TeeFind — Test Alert', 'A tee time just opened up!\n\n📍 Golf St-Janvier\n🕐 8:00 AM on 2026-09-02\n💰 $45.00 CAD/player · 18 holes\n👉 Book now: https://www.chronogolf.ca/club/golf-st-janvier\n\n— TeeFind\nteefind.ca');
  res.json({ message: 'Test alert sent to ' + email });
});

app.post('/api/scrape', async (req, res) => {
  res.json({ message: 'Scrape started' });
  runScrape(req.body?.daysAhead || 7).catch(console.error);
});

// ═══════════════════════════════════════════════════════════
//  HELPERS & STARTUP
// ═══════════════════════════════════════════════════════════

function formatTime12h(t) {
  const [h, m] = t.split(':').map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

app.listen(CONFIG.port, () => console.log(`[Server] TeeFind on http://localhost:${CONFIG.port}`));
cron.schedule('*/10 * * * *', () => runScrape().catch(console.error));
setTimeout(() => runScrape().catch(console.error), 3000);
module.exports = app;
