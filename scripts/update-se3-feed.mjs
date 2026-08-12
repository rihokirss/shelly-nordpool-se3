import fs from "node:fs/promises";
import path from "node:path";

const API = "https://dataportal-api.nordpoolgroup.com/api/DayAheadPrices";
const ZONE = "Europe/Helsinki";
const OUTPUT = process.argv[2] || "feed/se3";

function parts(date) {
  const values = new Intl.DateTimeFormat("en-CA", {
    timeZone: ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date);
  const result = {};
  for (const item of values) if (item.type !== "literal") result[item.type] = item.value;
  return result;
}

function dateKey(date) {
  const value = parts(date);
  return value.year + value.month + value.day;
}

function dateText(key) {
  return `${key.slice(0, 4)}-${key.slice(4, 6)}-${key.slice(6, 8)}`;
}

function addDay(key, amount) {
  const middayUtc = Date.UTC(Number(key.slice(0, 4)), Number(key.slice(4, 6)) - 1, Number(key.slice(6, 8)), 12);
  return dateKey(new Date(middayUtc + amount * 86400000));
}

function priceCode(price) {
  const value = Math.round(price * 1000) + 50000000;
  const text = String(value);
  if (!Number.isFinite(price) || value < 0 || text.length > 8) throw new Error(`Price outside supported range: ${price}`);
  return text.padStart(8, "0");
}

async function fetchMarketDate(key) {
  const url = `${API}?currency=EUR&market=DayAhead&deliveryArea=SE3&date=${dateText(key)}`;
  const response = await fetch(url, { headers: { "User-Agent": "shelly-nordpool-se3-feed/1" } });
  if (!response.ok) throw new Error(`Nord Pool ${response.status} for ${key}`);
  const data = await response.json();
  if (!Array.isArray(data.multiAreaEntries)) throw new Error(`No entries for ${key}`);
  return data.multiAreaEntries;
}

async function buildDay(key) {
  const responses = await Promise.all([fetchMarketDate(addDay(key, -1)), fetchMarketDate(key)]);
  const slots = responses.flat().map((entry) => ({
    start: new Date(entry.deliveryStart).getTime(),
    end: new Date(entry.deliveryEnd).getTime(),
    price: entry.entryPerArea?.SE3
  })).filter((entry) => dateKey(new Date(entry.start)) === key);
  slots.sort((left, right) => left.start - right.start);

  if (![92, 96, 100].includes(slots.length)) throw new Error(`${key}: expected 92, 96 or 100 slots, got ${slots.length}`);
  const first = parts(new Date(slots[0].start));
  const afterLast = parts(new Date(slots.at(-1).end));
  if (first.hour !== "00" || first.minute !== "00" || dateKey(new Date(slots.at(-1).end)) !== addDay(key, 1) ||
      afterLast.hour !== "00" || afterLast.minute !== "00") throw new Error(`${key}: incomplete local day`);
  for (let index = 0; index < slots.length; index++) {
    const slot = slots[index];
    if (!Number.isFinite(slot.price) || slot.end - slot.start !== 900000) throw new Error(`${key}: invalid slot ${index}`);
    if (index && slot.start !== slots[index - 1].start + 900000) throw new Error(`${key}: gap at slot ${index}`);
  }
  return JSON.stringify({ v: 1, d: key, n: slots.length, c: slots.map((slot) => priceCode(slot.price)).join("") });
}

const today = dateKey(new Date());
const targets = [today, addDay(today, 1)];
await fs.mkdir(OUTPUT, { recursive: true });
for (const target of targets) {
  try {
    const body = await buildDay(target);
    await fs.writeFile(path.join(OUTPUT, `${target}.json`), body + "\n", "utf8");
    console.log(`${target}: ${JSON.parse(body).n} slots, ${Buffer.byteLength(body)} bytes`);
  } catch (error) {
    if (target === today) throw error;
    console.warn(`${target}: not published yet (${error.message})`);
  }
}
