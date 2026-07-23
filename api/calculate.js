// Mise — Agent Service Provider endpoint
// POST /api/calculate
//
// Registered on-chain as an OKX ASP:
// tx 0xc2786fb119e5c05d46eb47e7e4e5a9d4b418fbc97f2f7ffe39897ed2e9eafb0d
//
// Actions:
//   { action: "catalog" }        → market price library + starter sheet (FREE)
//   { ingredients: [...], ... }  → costing for a batch (PAID via x402)
//
// x402: the "calculate" action requires payment. Payment is enforced by
// OKX's official x402 SDK (@okxweb3/x402-core + @okxweb3/x402-evm), which
// delegates verification AND on-chain settlement to the OKX facilitator
// (web3.okx.com) — unlike a hand-rolled check, a payload that was never
// signed by a funded wallet is rejected before this handler ever computes
// a result.
//
// Formula:
//   ingredient cost = (buyPrice / buyQty) * useQty
//   total           = Σ ingredients * (1 + wastePct/100)
//   per portion     = total / batchSize
//   menu price      = per portion / (1 - marginPct/100)

const { OKXFacilitatorClient } = require("@okxweb3/x402-core");
const { x402ResourceServer } = require("@okxweb3/x402-core/server");
const { x402HTTPResourceServer } = require("@okxweb3/x402-core/http");
const { ExactEvmScheme } = require("@okxweb3/x402-evm/exact/server");

/* ─────────────────────────────────────────────
   x402 CONFIG
   OKX_API_KEY / OKX_SECRET_KEY / OKX_PASSPHRASE must be set in Vercel env
   vars — these are your OKX facilitator (merchant) API credentials, not a
   wallet key. Get them from the OKX developer portal.
   ───────────────────────────────────────────── */
const NETWORK = "eip155:196"; // X Layer — required by OKX ASP listing
const PAY_TO = process.env.PAYMENT_ADDRESS || "0x9ff01ab21d7dd9e87ba3220c19fe3be49d5e0635";
const PRICE_USD = process.env.CALCULATE_PRICE_USD || "$0.01"; // resolved to USDT0 (6dp) by the SDK's default money parser
const ROUTE_KEY = "POST /api/calculate";

// Informational only (what the SDK resolves "$0.01" to by default on X Layer) —
// not used to build payment requirements; the SDK does that itself.
const DEFAULT_ASSET_NOTE = "USDT0 (0x779ded0c9e1022225f8e0630b35a9b54be713736), 6 decimals";

/* ─────────────────────────────────────────────
   MARKET PRICE LIBRARY — single source of truth.
   Mile 12 Market (Lagos wholesale), Naija Food,
   Jumia Groceries. Update here; the frontend
   picks it up with no redeploy.
   ───────────────────────────────────────────── */
const PRICE_BOOK = [
  // Mile 12 Market — natural market units, not forced to kg
  { key: "tomatoes",  name: "Tomatoes",                buyQty: 50, unit: "kg",           buyPrice: 19500, defaultUse: 2,    source: "Mile 12 Market",  category: "produce" },
  { key: "tatase",    name: "Tatase pepper",           buyQty: 50, unit: "kg",           buyPrice: 19500, defaultUse: 1.5,  source: "Mile 12 Market",  category: "produce" },
  { key: "rodo",      name: "Rodo pepper",             buyQty: 1,  unit: "big bowl",     buyPrice: 21000, defaultUse: 0.15, source: "Mile 12 Market",  category: "produce" },
  { key: "shombo",    name: "Shombo pepper",           buyQty: 1,  unit: "big bowl",     buyPrice: 7000,  defaultUse: 0.2,  source: "Mile 12 Market",  category: "produce" },
  { key: "onions",    name: "Onions, red",             buyQty: 1,  unit: "big bowl",     buyPrice: 9500,  defaultUse: 0.25, source: "Mile 12 Market",  category: "produce" },
  { key: "crayfish",  name: "Crayfish, medium",        buyQty: 1,  unit: "paint bucket", buyPrice: 18700, defaultUse: 0.1,  source: "Mile 12 Market",  category: "seasoning" },

  // Naija Food / supermarket staples
  { key: "rice",      name: "Rice",                    buyQty: 1,  unit: "derica",       buyPrice: 1500,  defaultUse: 5,    source: "Naija Food",      category: "staple" },
  { key: "veg-oil",   name: "Vegetable oil",           buyQty: 25, unit: "L",            buyPrice: 28875, defaultUse: 1.5,  source: "Naija Food",      category: "staple" },
  { key: "chicken",   name: "Chicken wings",           buyQty: 1,  unit: "kg",           buyPrice: 2790,  defaultUse: 2,    source: "Naija Food",      category: "protein" },
  { key: "beef",      name: "Beef, cut up",            buyQty: 1,  unit: "kg",           buyPrice: 7900,  defaultUse: 1.5,  source: "Naija Food",      category: "protein" },
  { key: "seasoning", name: "Seasoning cubes & spice", buyQty: 1,  unit: "lump sum",     buyPrice: 1500,  defaultUse: 1,    source: "Jumia Groceries", category: "seasoning" },

  // Packaging & utility
  { key: "pack",      name: "Takeaway pack",           buyQty: 50, unit: "pack",         buyPrice: 6000,  defaultUse: 20,   source: "Jumia Groceries", category: "packaging" },
  { key: "gas",       name: "Cooking gas",             buyQty: 1,  unit: "kg",           buyPrice: 1600,  defaultUse: 1,    source: "Jumia Groceries", category: "utility" },
];

// Opening sheet, expressed only as references into the price book.
const STARTER = [
  { key: "rice",     useQty: 5 },
  { key: "tomatoes", useQty: 2 },
  { key: "onions",   useQty: 0.25 },
];

const DEFAULTS = { wastePct: 7, marginPct: 66, batchSize: 20, vatRate: 0.075, currency: "NGN" };

const num = (v) => { const n = parseFloat(v); return isFinite(n) ? n : 0; };
const r2 = (n) => Math.round(n * 100) / 100;

/* ─────────────────────────────────────────────
   x402 wiring — SDK-backed resource server
   ───────────────────────────────────────────── */

// Vercel keeps a warm instance between invocations, so build the server
// once per cold start and cache the initialize() promise (it MUST resolve
// before the first request is processed — it fetches facilitator support).
let httpServerPromise = null;
function getHttpServer() {
  if (httpServerPromise) return httpServerPromise;

  const apiKey = process.env.OKX_API_KEY;
  const secretKey = process.env.OKX_SECRET_KEY;
  const passphrase = process.env.OKX_PASSPHRASE;
  if (!apiKey || !secretKey || !passphrase || !PAY_TO) {
    // No facilitator credentials configured yet — fail loudly rather than
    // silently giving away the paid feature for free.
    return Promise.resolve(null);
  }

  const facilitator = new OKXFacilitatorClient({
    apiKey,
    secretKey,
    passphrase,
    syncSettle: true, // wait for on-chain confirmation before delivering the result
  });

  const resourceServer = new x402ResourceServer(facilitator)
    .register(NETWORK, new ExactEvmScheme());

  const httpServer = new x402HTTPResourceServer(resourceServer, {
    [ROUTE_KEY]: {
      accepts: {
        scheme: "exact",
        network: NETWORK,
        payTo: PAY_TO,
        price: PRICE_USD,
      },
      description: "One food-cost and menu-price calculation.",
      mimeType: "application/json",
    },
  });

  httpServerPromise = resourceServer.initialize().then(
    () => httpServer,
    (err) => {
      httpServerPromise = null; // allow retry on the next request
      throw err;
    }
  );
  return httpServerPromise;
}

// Minimal framework-agnostic adapter over Vercel's plain (req, res) handler —
// the SDK's HTTPAdapter interface, not tied to Express/Next.
function makeAdapter(req) {
  const proto = req.headers["x-forwarded-proto"] || "https";
  const host = req.headers["x-forwarded-host"] || req.headers.host || "mise-api-five.vercel.app";
  const path = (req.url || "/api/calculate").split("?")[0];
  return {
    getHeader: (name) => req.headers[String(name).toLowerCase()],
    getMethod: () => req.method,
    getPath: () => path,
    getUrl: () => `${proto}://${host}${req.url || path}`,
    getAcceptHeader: () => req.headers["accept"] || "",
    getUserAgent: () => req.headers["user-agent"] || "",
  };
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, PAYMENT-SIGNATURE");
  res.setHeader(
    "Access-Control-Expose-Headers",
    "PAYMENT-REQUIRED, PAYMENT-SIGNATURE, PAYMENT-RESPONSE"
  );
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");

  if (req.method === "OPTIONS") return res.status(200).end();

  // Health probes: some availability checkers use HEAD before anything else.
  if (req.method === "HEAD") return res.status(200).end();

  // Discovery — lets another agent see what this service offers.
  // Stays free and un-gated so agents can evaluate Mise before paying.
  if (req.method === "GET") {
    return res.status(200).json({
      ok: true,
      service: "Mise — food costing",
      agent: { name: "Mise", role: "asp", chain: NETWORK },
      payment: {
        required: true,
        action: "calculate",
        network: NETWORK,
        payTo: PAY_TO,
        priceUsd: PRICE_USD,
        asset: DEFAULT_ASSET_NOTE,
        scheme: "exact",
      },
      actions: {
        catalog: { method: "POST", body: { action: "catalog" }, payment: "free" },
        calculate: {
          method: "POST",
          payment: "required (x402)",
          body: {
            dishName: "Jollof Rice",
            batchSize: 20,
            marginPct: 40,
            wastePct: 7,
            ingredients: [{ key: "tomatoes", useQty: 2 }],
          },
        },
      },
    });
  }

  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Use GET for discovery or POST to calculate." });
  }

  let body;
  try {
    body = typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};
  } catch (err) {
    return res.status(400).json({ ok: false, error: "Invalid request body" });
  }

  /* ── catalog — free, no payment gate ── */
  if (body.action === "catalog") {
    return res.status(200).json({
      ok: true,
      currency: DEFAULTS.currency,
      defaults: DEFAULTS,
      updated: "2026-07-19",
      sources: ["Mile 12 Market", "Naija Food", "Jumia Groceries"],
      catalog: PRICE_BOOK,
      starter: STARTER
        .map((s) => {
          const item = PRICE_BOOK.find((p) => p.key === s.key);
          return item ? Object.assign({}, item, { useQty: s.useQty }) : null;
        })
        .filter(Boolean),
      note: "Estimates only. Market prices move weekly — confirm against your own purchase.",
    });
  }

  /* ── calculate — paid via x402 (SDK-enforced) ── */
  const httpServer = await getHttpServer();
  if (!httpServer) {
    return res.status(500).json({
      ok: false,
      error: "OKX_API_KEY, OKX_SECRET_KEY, OKX_PASSPHRASE and PAYMENT_ADDRESS must all be set on this deployment before x402 can be enforced.",
    });
  }

  const adapter = makeAdapter(req);
  const context = { adapter, path: adapter.getPath(), method: req.method };

  let gate;
  try {
    gate = await httpServer.processHTTPRequest(context);
  } catch (err) {
    return res.status(502).json({ ok: false, error: "Payment facilitator error", detail: err.message });
  }

  if (gate.type === "payment-error") {
    const { status, headers, body: errBody } = gate.response;
    Object.entries(headers || {}).forEach(([k, v]) => res.setHeader(k, v));
    return res.status(status).json(errBody);
  }

  try {
    const {
      dishName = "Untitled",
      batchSize = DEFAULTS.batchSize,
      marginPct = DEFAULTS.marginPct,
      wastePct = DEFAULTS.wastePct,
      ingredients = [],
    } = body;

    if (!Array.isArray(ingredients) || ingredients.length === 0) {
      return res.status(400).json({ ok: false, error: "ingredients must be a non-empty array" });
    }

    const batch = Math.max(num(batchSize) || 1, 1);
    const margin = Math.min(Math.max(num(marginPct), 0), 95);
    const waste = Math.max(num(wastePct), 0);

    // An ingredient may cite a catalog key instead of carrying its own price.
    const lines = ingredients.map((i) => {
      const ref = i.key ? PRICE_BOOK.find((p) => p.key === i.key) : null;
      const buyQty = num(i.buyQty) || (ref ? ref.buyQty : 0);
      const buyPrice = num(i.buyPrice) || (ref ? ref.buyPrice : 0);
      const useQty = num(i.useQty);
      const unitRate = buyQty > 0 ? buyPrice / buyQty : 0;
      const cost = unitRate * useQty;
      return {
        name: i.name || (ref ? ref.name : "—"),
        unit: i.unit || (ref ? ref.unit : ""),
        source: ref ? ref.source : "user entered",
        buyQty, buyPrice, useQty,
        unitRate: r2(unitRate),
        cost: r2(cost),
      };
    });

    const baseCost = lines.reduce((s, l) => s + l.cost, 0);
    const wasteCost = baseCost * (waste / 100);
    const totalCost = baseCost + wasteCost;
    const costPerPortion = totalCost / batch;
    const suggestedPrice = margin < 100 ? costPerPortion / (1 - margin / 100) : costPerPortion;
    const foodCostPct = suggestedPrice > 0 ? Math.round((costPerPortion / suggestedPrice) * 100) : 0;

    lines.forEach((l) => { l.sharePct = baseCost > 0 ? Math.round((l.cost / baseCost) * 100) : 0; });

    const result = {
      ok: true,
      agent: {
        name: "Mise",
        role: "asp",
        chain: NETWORK,
        tx: "0xc2786fb119e5c05d46eb47e7e4e5a9d4b418fbc97f2f7ffe39897ed2e9eafb0d",
      },
      dishName,
      batchSize: batch,
      currency: DEFAULTS.currency,
      breakdown: lines,
      baseCost: r2(baseCost),
      wastePct: waste,
      wasteCost: r2(wasteCost),
      totalCost: r2(totalCost),
      costPerPortion: r2(costPerPortion),
      marginPct: margin,
      suggestedPrice: Math.round(suggestedPrice),
      suggestedPriceInclVat: Math.round(suggestedPrice * (1 + DEFAULTS.vatRate)),
      vatRate: DEFAULTS.vatRate,
      foodCostPercentage: foodCostPct,
      generatedAt: new Date().toISOString(),
    };

    if (gate.type === "payment-verified") {
      const settlement = await httpServer.processSettlement(
        gate.paymentPayload,
        gate.paymentRequirements,
        gate.declaredExtensions,
        { request: context, responseBody: Buffer.from(JSON.stringify(result)) }
      );

      if (!settlement.success) {
        const { status, headers, body: errBody } = settlement.response;
        Object.entries(headers || {}).forEach(([k, v]) => res.setHeader(k, v));
        return res.status(status).json(errBody);
      }

      Object.entries(settlement.headers || {}).forEach(([k, v]) => res.setHeader(k, v));
    }

    return res.status(200).json(result);
  } catch (err) {
    return res.status(400).json({ ok: false, error: "Invalid request body" });
  }
};
