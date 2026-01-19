// server.js
require("./lib/loadEnv");              // load .env locally / skip on Cloud Run

const app = require("./app");

const port = process.env.PORT || 8080;
app.listen(port, "0.0.0.0", () => {
  console.log(`Server istening on port ${port}`);
});
