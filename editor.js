const articlesList =
    document.getElementById("articles-list");


articles.forEach(function(article) {

    const articleLink =
        document.createElement("a");

    articleLink.href =
        `editor-article.html?id=${article.id}`;

    articleLink.classList.add("article-card-link");


    const articleCard =
        document.createElement("article");

    articleCard.classList.add("article-card");


    const status =
        document.createElement("div");

    status.classList.add("article-status");

    status.textContent =
        article.status;


    if (article.status === "Pending Approval") {
        status.classList.add("pending");
    }

    if (article.status === "Published") {
        status.classList.add("published");
    }

    if (article.status === "Needs Changes") {
        status.classList.add("Needs-changes");
    }


    const title =
        document.createElement("h3");

    title.textContent =
        article.title;


    const reporter =
        document.createElement("p");

    reporter.classList.add("article-info");

    reporter.textContent =
        "Reporter: " + article.reporter;


    const date =
        document.createElement("p");

    date.classList.add("article-info");

    date.textContent =
        "Date: " + article.date;


    const summary =
        document.createElement("p");

    summary.classList.add("article-summary");

    summary.textContent =
        article.summary;


    articleCard.appendChild(status);

    articleCard.appendChild(title);

    articleCard.appendChild(reporter);

    articleCard.appendChild(date);

    articleCard.appendChild(summary);

    articleLink.appendChild(articleCard);

    articlesList.appendChild(articleLink);

});