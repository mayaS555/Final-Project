// DEVELOPMENT ONLY. Connects to MongoDB using DEV_MONGODB_URI from the local .env file.
// The dbName option overrides any database named in the URI, so this connection selects
// DEV_DATABASE_NAME. The seed still verifies the model's own connection before deleting.

const mongoose = require("mongoose");

const DEV_DATABASE_NAME = "daily_web_dev_public";

async function connectDevDb() {
  const uri = process.env.DEV_MONGODB_URI;
  if (!uri) {
    throw new Error("DEV_MONGODB_URI is not set. See dev/env.example.");
  }
  await mongoose.connect(uri, { dbName: DEV_DATABASE_NAME, serverSelectionTimeoutMS: 5000 });
  return mongoose.connection;
}

module.exports = { connectDevDb, DEV_DATABASE_NAME };
