// lib/loadEnv.js
const path = require("path");
const dotenv = require("dotenv");

const envName = process.env.ENV_FILE || ".env"; // e.g. ".env.prod"
dotenv.config({
  path: path.resolve(process.cwd(), envName),
  override: false, // set true if you want ENV_FILE to override existing vars
});

// optional debug
console.log("Loaded env file:", envName);
