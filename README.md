# The Daily Web

A small news platform built as a final project. Reporters write and submit articles, editors review and approve them, and the public reads whatever has been published. There's also a comments section and a weather widget in the header.

## Stack

- **Node.js / Express 5** – server and routing
- **MongoDB* – data storage
- **EJS** – server-side templating
- **bcryptjs** – password hashing
- **express-session + connect-mongo** – session management, stored in MongoDB so logins survive a restart
- No frontend framework – plain HTML/CSS/JS on the client

## Getting started

1. Clone the repo and install dependencies:
   ```bash
   npm install
   ```

2. Copy `.env.example` to `.env` and fill in your values:
   ```bash
   cp .env.example .env
   ```
   `MONGODB_URI` and `SESSION_SECRET` are required. Generate the session secret with
   `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` and keep it unchanged between restarts.

3. (Optional) Seed the demo database:
   ```bash
   npm run seed
   ```
   This replaces the articles and the demo data attached to them (comments, read history, article views and
   publish events), and creates or updates the five demo reporters and one demo editor listed below. Other user
   accounts are not touched.

4. Start the server:
   ```bash
   npm start
   ```
   Default port is 3000.

## Environment variables

| Variable | Required | Default | Notes |
|---|---|---|---|
| `MONGODB_URI` | yes | — | Full connection string |
| `DB_NAME` | no | from URI | Override the database name |
| `SESSION_SECRET` | yes | — | Signs session cookies. Generate a long random value and keep it stable across restarts |
| `PORT` | no | `3000` | |
| `NODE_ENV` | no | `development` | Set to `production` to hide error details; seed script refuses to run |
| `SEED_REPORTER_PASSWORD` | no | `reporter123` | Password for the demo reporter accounts created by `npm run seed` |
| `SEED_EDITOR_PASSWORD` | no | `editor123` | Password for the demo editor account created by `npm run seed` |
| `LOG_LEVEL` | no | `info` | `debug` / `info` / `warn` / `error` / `silent` |
| `LOG_TO_FILE` | no | `false` | Write logs to `logs/` in addition to stdout |
| `OPENWEATHERMAP_API_KEY` | no | — | Get one free at openweathermap.org. Widget shows "unavailable" without it |
| `WEATHER_DEFAULT_CITY` | no | `Tel Aviv` | City shown in the header weather widget |

## User roles

Three roles, created manually (no self-registration):

- **reporter** – can create and edit their own articles, submit for review
- **editor** – can approve, return or re-publish any article; has access to the editor dashboard
- **admin** – same as editor (reserved for future use)

To create a user, either use the helper script or connect directly to MongoDB:
```bash
node scripts/create-user.js
```

### Demo accounts created by the seed

`npm run seed` creates (or updates) these accounts with hashed passwords. The passwords can be changed with
`SEED_REPORTER_PASSWORD` and `SEED_EDITOR_PASSWORD`.

| Role | Email | Default password |
|---|---|---|
| reporter | `noa.levi@dailyweb.test` | `reporter123` |
| reporter | `daniel.cohen@dailyweb.test` | `reporter123` |
| reporter | `yael.mizrahi@dailyweb.test` | `reporter123` |
| reporter | `omer.friedman@dailyweb.test` | `reporter123` |
| reporter | `maya.shapiro@dailyweb.test` | `reporter123` |
| editor | `editor@dailyweb.test` | `editor123` |

The 500 seeded articles are owned by these reporters, so logging in as one of them shows a populated dashboard.
The seed also adds comments, per-day view data and publish-event markers for the Impact Analytics demo.

## Article workflow

```
draft → pending → published
              ↘ returned → pending (resubmit)
published → pending (revision while old version stays live)
```

An article is public as soon as it has an `approved.publishedAt` date. Reporters submitting a revision don't take the current published version down – readers keep seeing it until the new version is approved.

## Weather widget

The header shows current weather pulled from OpenWeatherMap. It's a server-side proxy (`GET /api/weather`) so the API key never reaches the browser. Responses are cached in memory for 15 minutes. If the API is down, the server returns the last cached reading with a "Cached" label; if there's nothing cached at all, the widget just says "Weather unavailable" instead of breaking the page.

The client-side script (`public/js/weather-widget.js`) quietly re-fetches every 15 minutes to keep the data reasonably fresh without a full page reload.

## API overview

All the routes that return JSON live under `/api/`:

| Method | Path | Who can call it |
|---|---|---|
| `GET` | `/api/public/articles` | anyone |
| `GET` | `/api/weather` | anyone |
| `GET` | `/api/articles` | reporter / editor |
| `POST` | `/api/articles` | reporter |
| `PATCH` | `/api/articles/:id` | article owner or editor |
| `DELETE` | `/api/articles/:id` | article owner or editor |
| `POST` | `/api/articles/:id/submit` | article owner |
| `POST` | `/api/articles/:id/approve` | editor |
| `POST` | `/api/articles/:id/return` | editor |
| `GET` | `/api/auth/me` | authenticated users |
| `GET/POST` | `/api/articles/:id/comments` | anyone |
| `PATCH/DELETE` | `/api/articles/:id/comments/:cid` | comment author (device cookie) |


## Project structure

```
controllers/   – request handlers (public site, reporter dashboard, article API, auth)
middleware/    – session auth checks, device identity cookie, error handler
models/        – Mongoose schemas (Article, User, Comment, ArticleRead, ArticleView, PublishEvent)
routes/        – Express routers
services/      – business logic and shared utilities (article state machine, caching, logging, weather)
views/         – EJS templates
  public/      – reader-facing pages and partials
  reporter/    – dashboard and article editor
public/        – static assets (CSS, client-side JS)
scripts/       – one-off utilities (seed, create-user)
tests/         – test files and test helpers
```

