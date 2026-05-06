# Defender Dashboard API

Express.js proxy server for the Defender Technology Executive Dashboard.
Deployed on Railway. Handles all AutoTask API communication server-side
so credentials are never exposed to the browser.

## Setup

1. Clone this repo
2. Copy `.env.example` to `.env` and fill in your values
3. `npm install`
4. `npm run dev`

## Railway Deployment

1. Push to GitHub
2. Connect repo in Railway → New Project → Deploy from GitHub
3. Add all variables from `.env.example` in Railway → Variables tab
4. Railway auto-deploys on every push to main

## Endpoints

All routes require: `Authorization: Bearer <API_KEY>`

| Method | Route | Description |
|--------|-------|-------------|
| GET | /health | Health check (no auth) |
| GET | /api/tickets/summary | 12-month ticket volume by month |
| GET | /api/tickets/open | All open tickets with age + tech breakdown |
| GET | /api/tickets/categories | Ticket counts by category (last 6mo) |
| GET | /api/resources | Active technician list |
| GET | /api/sla/compliance | SLA breach rate current vs prior 6mo |
