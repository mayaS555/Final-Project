const express = require("express");
const authController = require("../controllers/authController");

const router = express.Router();

router.get("/login", (req, res) => {
  if (req.session && req.session.user) {
    const destination = req.session.user.role === "editor" ? "/editor.html" : "/reporter";
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
