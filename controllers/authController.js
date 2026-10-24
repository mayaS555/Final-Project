const User = require("../models/User");
const logger = require("../services/logger");

/**
 * Handles user login.
 * Supports both JSON AJAX requests and standard HTML form POSTs.
 */
async function login(req, res) {
  try {
    const { email, password, returnTo } = req.body;

    const isHtmlForm = req.headers["content-type"]?.includes("application/x-www-form-urlencoded");

    if (!email || !password) {
      logger.logAuthEvent("login_failed_missing_credentials", { ip: req.ip });
      if (isHtmlForm) {
        const query = returnTo ? `?error=missing&returnTo=${encodeURIComponent(returnTo)}` : "?error=missing";
        return res.redirect(`/login.html${query}`);
      }
      return res.status(400).json({ error: "Email and password are required." });
    }

    const cleanEmail = email.toLowerCase().trim();
    const user = await User.findOne({ email: cleanEmail });
    if (!user) {
      logger.logAuthEvent("login_failed_user_not_found", { email: cleanEmail, ip: req.ip });
      if (isHtmlForm) {
        const query = returnTo ? `?error=invalid&returnTo=${encodeURIComponent(returnTo)}` : "?error=invalid";
        return res.redirect(`/login.html${query}`);
      }
      return res.status(401).json({ error: "Invalid email or password." });
    }

    const isMatch = await user.comparePassword(password);
    if (!isMatch) {
      logger.logAuthEvent("login_failed_bad_password", { email: cleanEmail, ip: req.ip });
      if (isHtmlForm) {
        const query = returnTo ? `?error=invalid&returnTo=${encodeURIComponent(returnTo)}` : "?error=invalid";
        return res.redirect(`/login.html${query}`);
      }
      return res.status(401).json({ error: "Invalid email or password." });
    }

    // Store user info in session
    req.session.user = {
      _id: String(user._id),
      name: user.name,
      email: user.email,
      role: user.role,
    };

    logger.logAuthEvent("login_success", {
      userId: String(user._id),
      email: user.email,
      role: user.role,
      ip: req.ip,
    });

    // Only reporters have a dashboard; editors land on the public home page for now.
    const targetUrl = returnTo || (user.role === "reporter" ? "/reporter" : "/");

    if (isHtmlForm) {
      return res.redirect(targetUrl);
    }

    return res.json({
      success: true,
      user: req.session.user,
      redirectUrl: targetUrl,
    });
  } catch (error) {
    logger.error("Login error:", error);
    if (req.headers["content-type"]?.includes("application/x-www-form-urlencoded")) {
      return res.redirect("/login.html?error=server");
    }
    return res.status(500).json({ error: "An unexpected error occurred during login." });
  }
}

/**
 * Destroys the current session and logs the user out.
 */
function logout(req, res) {
  if (req.session) {
    const userId = req.session.user?._id;
    req.session.destroy((err) => {
      if (err) {
        logger.error("Error destroying session:", err);
      } else if (userId) {
        logger.logAuthEvent("logout", { userId });
      }
      res.clearCookie("connect.sid");
      if (req.headers.accept?.includes("text/html")) {
        return res.redirect("/");
      }
      return res.json({ success: true, message: "Logged out successfully." });
    });
  } else {
    if (req.headers.accept?.includes("text/html")) {
      return res.redirect("/");
    }
    return res.json({ success: true, message: "Not logged in." });
  }
}

/**
 * Returns the currently authenticated user, or null.
 */
function getCurrentUser(req, res) {
  if (req.session && req.session.user) {
    return res.json({ user: req.session.user });
  }
  return res.json({ user: null });
}

module.exports = { login, logout, getCurrentUser };
