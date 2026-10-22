const express = require("express");
const mongoose = require("mongoose");
const dotenv = require("dotenv");
const path = require("path");

dotenv.config();

const Article = require("./models/Article");
const ArticleRead = require("./models/ArticleRead");
const Comment = require("./models/Comment");
const { useArticleModel } = require("./services/publicArticleService");

const session = require("express-session");
const { MongoStore } = require("connect-mongo");

const publicRoutes = require("./routes/publicRoutes");
const authRoutes = require("./routes/authRoutes");
const articleApiRoutes = require("./routes/articleApiRoutes");
const reporterRoutes = require("./routes/reporterRoutes");
const weatherRoutes = require("./routes/weatherRoutes");
const { errorHandler, notFoundHandler } = require("./middleware/errorHandler");
const logger = require("./services/logger");

const app = express();

// Set up EJS view engine
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

// Session configuration. Sessions are stored in MongoDB so they survive a server restart.
const SESSION_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 1 day
const SESSION_SECRET = process.env.SESSION_SECRET;

if (!SESSION_SECRET) {
  throw new Error(
    "SESSION_SECRET is not set. Add a long random value to .env (see .env.example). " +
      "Without it, session cookies cannot be signed safely."
  );
}

// Reuse Mongoose's MongoDB connection. The store waits for the connection before its first operation,
// so the session middleware can be registered before startServer() connects.
const sessionStore = MongoStore.create({
  clientPromise: mongoose.connection.asPromise().then(() => mongoose.connection.getClient()),
  dbName: process.env.DB_NAME || undefined,
  collectionName: "sessions",
  ttl: SESSION_MAX_AGE_MS / 1000,
  autoRemove: "native",
});

app.use(
  session({
    secret: SESSION_SECRET,
    store: sessionStore,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      maxAge: SESSION_MAX_AGE_MS,
      sameSite: "lax",
    },
  })
);

// Pass logged-in user to all EJS templates
app.use((req, res, next) => {
  res.locals.user = req.session && req.session.user ? req.session.user : null;
  next();
});

// Connect Article model to publicArticleService
useArticleModel(Article);

// HTTP request logger – mounted early so all application routes are covered
app.use(logger.requestLogger());

// Public routes must be mounted before express.static so GET / serves the dynamic EJS feed
app.use(publicRoutes);

// Body parsers for auth and API routes
app.use(express.json({ limit: "500kb" }));
app.use(express.urlencoded({ extended: true }));

// Authentication routes (/login, /logout, /api/auth/me)
app.use(authRoutes);

// Reporter routes and Article REST API
app.use(articleApiRoutes);
app.use(reporterRoutes);
// Weather proxy (cached, no auth required)
app.use(weatherRoutes);

// Protect editor area pages from unauthorized visitors
app.get(["/editor.html", "/editor-article.html"], (req, res, next) => {
  if (!req.session?.user) {
    const err = new Error("Please log in as an editor.");
    err.status = 401;
    return next(err);
  }
  if (req.session.user.role !== "editor" && req.session.user.role !== "admin") {
    const err = new Error("Only editors can access this page.");
    err.status = 403;
    return next(err);
  }
  next();
});

// Serve static assets from public folder
app.use(express.static(path.join(__dirname, "public")));

// 404 handler for unmatched routes
app.use(notFoundHandler);

// Centralized error-handling middleware
app.use(errorHandler);

// Global safety net for unhandled async rejections and unexpected exceptions
process.on("unhandledRejection", (reason, promise) => {
  logger.error("Unhandled promise rejection", reason instanceof Error ? reason : new Error(String(reason)));
});

process.on("uncaughtException", (error) => {
  logger.error("Uncaught exception – server may be in an unstable state", error);
});

const PORT = process.env.PORT || 3000;

async function startServer() {
  try {
    if (!process.env.MONGODB_URI) {
      logger.error("MONGODB_URI is not set in .env – cannot start.");
      process.exit(1);
    }

    logger.logServerEvent("db_connecting", { uri: process.env.MONGODB_URI.replace(/\/\/[^@]+@/, "//***@") });
    const connectOptions = process.env.DB_NAME ? { dbName: process.env.DB_NAME } : {};
    await mongoose.connect(process.env.MONGODB_URI, connectOptions);
    logger.logServerEvent("db_connected", { db: mongoose.connection.name });

    // Ensure database indexes exist
    await Promise.all([
      Article.init(),
      ArticleRead.init(),
      Comment.init(),
    ]);
    logger.logServerEvent("indexes_ready");

    app.listen(PORT, () => {
      logger.logServerEvent("start", { port: PORT, env: process.env.NODE_ENV || "development" });
    });
  } catch (error) {
    logger.error("Failed to start server:", error);
    process.exit(1);
  }
}

if (require.main === module) {
  startServer();
}

module.exports = app;