const express = require("express");
const mongoose = require("mongoose");
const dotenv = require("dotenv");
const path = require("path");

dotenv.config();

const Article = require("./models/Article");
const ArticleRead = require("./models/ArticleRead");
const Comment = require("./models/Comment");
const { useArticleModel } = require("./services/publicArticleService");

const publicRoutes = require("./routes/publicRoutes");
const articleApiRoutes = require("./routes/articleApiRoutes");
const reporterRoutes = require("./routes/reporterRoutes");

const app = express();

// Set up EJS view engine
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

// Connect Article model to publicArticleService
useArticleModel(Article);

// Public routes must be mounted before express.static so GET / serves the dynamic EJS feed
app.use(publicRoutes);

// Reporter routes and Article REST API
app.use(articleApiRoutes);
app.use(reporterRoutes);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));

// Centralized error handler
app.use((err, req, res, next) => {
  const status = err.status || 500;
  if (req.path.startsWith("/api/")) {
    return res.status(status).json({ error: err.message || "Internal server error" });
  }
  res.status(status).render("public/message", {
    pageTitle: `Error ${status}`,
    title: `Error ${status}`,
    message: err.message || "Something went wrong. Please try again later.",
  });
});

const PORT = process.env.PORT || 3000;

async function startServer() {
  try {
    if (!process.env.MONGODB_URI) {
      console.error("MONGODB_URI is not set in .env");
      process.exit(1);
    }

    console.log("Connecting to MongoDB Atlas...");
    const connectOptions = process.env.DB_NAME ? { dbName: process.env.DB_NAME } : {};
    await mongoose.connect(process.env.MONGODB_URI, connectOptions);
    console.log(`Connected to database: ${mongoose.connection.name}`);

    // Ensure database indexes exist
    await Promise.all([
      Article.init(),
      ArticleRead.init(),
      Comment.init(),
    ]);
    console.log("Database indexes initialized.");

    app.listen(PORT, () => {
      console.log(`Server is running on http://localhost:${PORT}`);
    });
  } catch (error) {
    console.error("Failed to start server:", error.message);
    process.exit(1);
  }
}

startServer();