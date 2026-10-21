const mongoose = require("mongoose");
const dotenv = require("dotenv");
const path = require("path");

dotenv.config({ path: path.join(__dirname, "..", ".env") });

const User = require("../models/User");

async function createUser({ name, email, password, role = "reporter" }) {
  if (!process.env.MONGODB_URI) {
    throw new Error("MONGODB_URI is not set in .env");
  }

  if (!name || !email || !password) {
    throw new Error("name, email, and password are required.");
  }

  const connectOptions = process.env.DB_NAME ? { dbName: process.env.DB_NAME } : {};
  await mongoose.connect(process.env.MONGODB_URI, connectOptions);

  try {
    const existing = await User.findOne({ email: email.toLowerCase() });
    if (existing) {
      existing.name = name;
      existing.password = password; // Will be hashed by pre-save hook
      existing.role = role;
      await existing.save();
      console.log(`User updated successfully:`);
      console.log(`  ID:    ${existing._id}`);
      console.log(`  Name:  ${existing.name}`);
      console.log(`  Email: ${existing.email}`);
      console.log(`  Role:  ${existing.role}`);
      return existing;
    }

    const user = await User.create({
      name,
      email,
      password,
      role,
    });

    console.log(`User created successfully:`);
    console.log(`  ID:    ${user._id}`);
    console.log(`  Name:  ${user.name}`);
    console.log(`  Email: ${user.email}`);
    console.log(`  Role:  ${user.role}`);
    return user;
  } finally {
    await mongoose.disconnect();
  }
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const [name, email, password, role] = args;

  if (!name || !email || !password) {
    console.log("Usage: node scripts/create-user.js <name> <email> <password> [role]");
    console.log('Example: node scripts/create-user.js "Itay Z" "itayz@mail.com" "qwe123" "reporter"');
    process.exit(1);
  }

  createUser({ name, email, password, role: role || "reporter" })
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("Error creating user:", err.message);
      process.exit(1);
    });
}

module.exports = { createUser };
