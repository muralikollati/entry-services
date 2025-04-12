// api/index.js
const express = require("express");
const cors = require("cors");
require("dotenv").config();

const app = express();
app.use(cors());
app.use(express.json());

// Your constants and setup
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

// Your routes here
app.get("/", (req, res) => {
  res.send("Hello from Vercel serverless Express!"+ GEMINI_API_KEY);
});

// Wrap Express to work with Vercel
module.exports = (req, res) => {
  app(req, res);
};
