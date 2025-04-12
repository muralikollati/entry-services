// api/index.js
const express = require("express");
const app = express();

app.get("/", (req, res) => {
  res.send("Express on Vercel at entry-service");
});

app.listen(3000, () => {
  console.log("Server is running on port 3000");
});

// Export as a serverless function
module.exports = (req, res) => {
  app(req, res);
};
