# The Daily Web

A small news platform built as a final project. Reporters write and submit articles, editors review submissions, and
the public reads whatever has been published. There's also a comments section and a weather widget in the header.

## Stack

- **Node.js / Express 5** – server and routing
- **MongoDB** – data storage
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
   This replaces the articles (including the comments, view buckets and publish events embedded in them) and the
   read history, and creates or updates the five demo reporters and one demo editor listed below. Other user
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

- **reporter** – creates and edits their own articles, submits them for review, and manages published revisions
- **editor** – reviews all articles, edits pending submissions, and manages the article collection through the article API
- **admin** – combines the reporter and editor roles: can write and manage their own articles, review pending
  submissions, and manage every article in the collection

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

## Database

MongoDB holds four collections:

| Collection | Model | Contents |
|---|---|---|
| `articles` | `models/Article.js` | Each article with its working copy (`draft`), public version (`approved`), and embedded arrays: `comments` (guest comments), `views` (daily view buckets with per-minute counts) and `publishEvents` (one entry per approval, the Impact Analytics markers) |
| `users` | `models/User.js` | Staff accounts (reporter / editor / admin) |
| `article_reads` | `models/ArticleRead.js` | Which articles a browser has opened, for the viewed/unviewed feed filter |
| `sessions` | connect-mongo | Login sessions |

Comments and analytics used to live in their own `comments`, `article_views` and `publish_events` collections. A
database that still has them must be migrated once, before the new code runs on it:

```bash
node scripts/migrate-embed-article-data.js --dry-run   # prints what would move
node scripts/migrate-embed-article-data.js             # backs up to backups/, embeds, verifies, drops the old collections
```

## Article workflow

```
draft → pending
returned → pending (resubmit)
pending → published (approve)
pending → returned (return)
published → draft (start a revision; the old version stays live)
```

An article is public as soon as it has an `approved.publishedAt` date. Reporters starting a revision don't take the
current published version down – readers keep seeing it until the new version is approved. The workflow is enforced by
the state machine in `services/articleStatus.js` and the article service in `services/articleService.js`.

## Weather widget

The header shows current weather pulled from OpenWeatherMap. It's a server-side proxy (`GET /api/weather`) so the API key never reaches the browser. Responses are cached in memory for 15 minutes. If the API is down, the server returns the last cached reading with a "Cached" label; if there's nothing cached at all, the widget just says "Weather unavailable" instead of breaking the page.

The client-side script (`public/js/weather-widget.js`) quietly re-fetches every 15 minutes to keep the data reasonably fresh without a full page reload.

## API overview

The JSON API lives under `/api/`. Staff authentication is outside it: `POST /login` accepts either JSON or a normal
form post, and `GET|POST /logout` clears the session.

| Method | Path | Who can call it | Status |
|---|---|---|---|
| `GET` | `/api/public/articles` | anyone | Implemented |
| `GET` | `/api/public/articles/:id/comments` | anyone | Implemented |
| `POST` | `/api/public/articles/:id/comments` | anyone (rate-limited per device) | Implemented |
| `PATCH` | `/api/public/comments/:id` | comment author (device cookie) | Implemented |
| `DELETE` | `/api/public/comments/:id` | comment author (device cookie) | Implemented |
| `GET` | `/api/weather` | anyone | Implemented |
| `GET` | `/api/auth/me` | anyone; returns `null` when logged out | Implemented |
| `GET` | `/api/articles` | reporter / editor / admin | Implemented |
| `POST` | `/api/articles` | reporter / admin | Implemented |
| `GET` | `/api/articles/:id` | article owner / editor / admin | Implemented |
| `PATCH` | `/api/articles/:id` | article owner / editor / admin; draft or returned for the owner, pending for editor or admin | Implemented |
| `DELETE` | `/api/articles/:id` | article owner / editor / admin | Implemented |
| `POST` | `/api/articles/:id/submit` | article owner | Implemented |
| `POST` | `/api/articles/:id/approve` | editor / admin | Not implemented yet |
| `POST` | `/api/articles/:id/return` | editor / admin | Not implemented yet |
| `POST` | `/api/articles/:id/revise` | article owner | Implemented |

Comment routes live under `/api/public/`, while article management routes live under `/api/articles/`.

## Project structure

```
controllers/   – request handlers (public site, reporter dashboard, article API, auth)
middleware/    – session auth checks, device identity cookie, error handler
models/        – Mongoose schemas (Article with its embedded comments and analytics, User, ArticleRead)
routes/        – Express routers
services/      – business logic and shared utilities (article state machine, caching, logging, weather)
views/         – EJS templates
  public/      – reader-facing pages and partials
  reporter/    – dashboard and article editor
public/        – static assets (CSS, client-side JS, login page)
scripts/       – one-off utilities (seed, create-user, migrate-embed-article-data)
tests/         – test files and test helpers
```

