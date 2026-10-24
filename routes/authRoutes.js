const express = require("express");
const authController = require("../controllers/authController");

const router = express.Router();

router.get("/login", (req, res) => {
  if (req.session && req.session.user) {
    // Only reporters have a dashboard; editors land on the public home page for now.
    const destination = req.session.user.role === "reporter" ? "/reporter" : "/";
    return res.redirect(destination);
  }
  const queryString = req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : "";
  res.redirect(`/login.html${queryString}`);
});

router.post("/login", authController.login);

router.get("/logout", authController.logout);
router.post("/logout", authController.logout);

router.get("/api/auth/me", authController.getCurrentUser);

module.exports = router;
