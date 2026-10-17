// The fixed list of article categories (owned by B).
// models/Article.js validates category against it; the reporter form and D's dashboard can list it.
// "General" is also the label C's public site shows when an article has no category.

const ARTICLE_CATEGORIES = ["General", "Politics", "World", "Economy", "Technology", "Sports", "Culture", "Health"];

module.exports = { ARTICLE_CATEGORIES };
