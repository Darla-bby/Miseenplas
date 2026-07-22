# Mise

Food cost and menu pricing for Nigerian kitchens.

Mise turns real Lagos market prices into a true cost per portion, then
suggests a selling price at your target margin. Built for small food
vendors and home cooks who price by guesswork.

Live: https://mise-api-five.vercel.app
OKX Agent ID: #6290 (ASP, A2MCP)

## What it does

- Prices ingredients in real market units (bag, big bowl, paint bucket,
  derica, keg) rather than forcing everything into kg
- Adds waste, then divides across a batch to get cost per portion
- Suggests a menu price at your chosen margin, with VAT
- Camera scan: photograph your prep bench, get an itemised estimate

Price data: Mile 12 Market (Lagos wholesale), Naija Food, Jumia Groceries.

## API

Discovery (free): GET /api/calculate

Price library (free): POST /api/calculate with action set to catalog

Costing (paid, x402 on X Layer / eip155:196, 0.01 USDT per call):
POST /api/calculate with dishName, batchSize, marginPct and an
ingredients array. Returns a per-ingredient breakdown, total cost,
cost per portion, and suggested selling price.

## Stack

Vercel serverless functions, vanilla JS frontend, OpenAI vision for
ingredient scanning, x402 payments on X Layer.

Built for the OKX.AI Genesis Hackathon.
