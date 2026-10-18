// Pages of the reporter area (owned by B). Mounted by A with app.use(require("./routes/reporterRoutes")),
// after the session middleware. Reporters only, checked on the server.

const express = require("express");
const reporterController = require("../controllers/reporterController");
const { requireReporterLogin } = require("../middleware/articleAccess");

const router = express.Router();

router.get("/reporter", requireReporterLogin, reporterController.renderDashboard);

module.exports = router;
