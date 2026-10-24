function defaultDestination(role) {
  if (role === "editor") return "/editor";
  if (role === "reporter" || role === "admin") return "/reporter";
  return "/";
}

// Preserve returnTo for protected pages; only allow paths within this application.
function loginDestination(role, returnTo) {
  if (typeof returnTo === "string" && /^\/(?!\/)/.test(returnTo) && !/[\\\x00-\x20\x7f]/.test(returnTo)) {
    return returnTo;
  }
  return defaultDestination(role);
}

module.exports = { defaultDestination, loginDestination };
