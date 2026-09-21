const feed =
    document.getElementById("feed");

const searchInput =
    document.getElementById("search");

// the public feed shows published articles only
const publishedArticles =
    articles.filter(function(article) {
        return article.status === "Published";
    });


function displayArticles(articlesToDisplay) {

    feed.innerHTML = "";

    if (articlesToDisplay.length === 0) {
        feed.textContent = "No articles found.";
        return;
    }

    articlesToDisplay.forEach(function(article) {

        const articleLink =
            document.createElement("a");

        articleLink.href =
            `article.html?id=${article.id}`;

        articleLink.classList.add("article-card-link");


        const articleCard =
            document.createElement("article");

        articleCard.classList.add("article-card");


        const image =
            document.createElement("div");

        image.classList.add("article-image");


        const category =
            document.createElement("p");

        category.classList.add("article-category");

        category.textContent =
            article.category || "General";


        const title =
            document.createElement("h2");

        title.textContent =
            article.title;


        const summary =
            document.createElement("p");

        summary.textContent =
            article.summary;


        const info =
            document.createElement("p");

        info.classList.add("article-info");

        info.textContent =
            article.reporter + " · " + article.updatedDate;


        articleCard.append(image, category, title, summary, info);
        articleLink.appendChild(articleCard);
        feed.appendChild(articleLink);
    });
}


// temporary client-side search until the server API exists
searchInput.addEventListener("input", function() {

    const query =
        searchInput.value.toLowerCase();

    displayArticles(
        publishedArticles.filter(function(article) {
            return article.title.toLowerCase().includes(query);
        })
    );
});


displayArticles(publishedArticles);
