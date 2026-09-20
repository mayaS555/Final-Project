const articlesList =
    document.getElementById("articles-list");


function displayArticles(articlesToDisplay) {

    articlesList.innerHTML = "";

    articlesToDisplay.forEach(function(article) {

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
            status.classList.add("needs-changes");
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

}

const allButton =
    document.getElementById("filter-all");

const pendingButton =
    document.getElementById("filter-pending");

const publishedButton =
    document.getElementById("filter-published");

const needsChangesButton =
    document.getElementById("filter-needs-changes");


allButton.addEventListener("click", function() {
    displayArticles(articles);
});

pendingButton.addEventListener("click", function() {

    const pendingArticles =
        articles.filter(function(article) {
            return article.status === "Pending Approval";
        });

    displayArticles(pendingArticles);

});

publishedButton.addEventListener("click", function() {

    const publishedArticles =
        articles.filter(function(article) {
            return article.status === "Published";
        });

    displayArticles(publishedArticles);

});

needsChangesButton.addEventListener("click", function() {

    const needsChangesArticles =
        articles.filter(function(article) {
            return article.status === "Needs Changes";
        });

    displayArticles(needsChangesArticles);

});

displayArticles(articles);

function setActiveButton(selectedButton) {

    const buttons =
        document.querySelectorAll(".filters button");

    buttons.forEach(function(button) {
        button.classList.remove("active");
    });

    selectedButton.classList.add("active");
}

function setActiveButton(selectedButton) {

    const buttons =
        document.querySelectorAll(".filters button");

    buttons.forEach(function(button) {
        button.classList.remove("active");
    });

    selectedButton.classList.add("active");
}

allButton.addEventListener("click", function() {

    displayArticles(articles);

    setActiveButton(allButton);
});

pendingButton.addEventListener("click", function() {

    const pendingArticles =
        articles.filter(function(article) {
            return article.status === "Pending Approval";
        });

    displayArticles(pendingArticles);

    setActiveButton(pendingButton);
});

publishedButton.addEventListener("click", function() {

    const publishedArticles =
        articles.filter(function(article) {
            return article.status === "Published";
        });

    displayArticles(publishedArticles);

    setActiveButton(publishedButton);
});

needsChangesButton.addEventListener("click", function() {

    const needsChangesArticles =
        articles.filter(function(article) {
            return article.status === "Needs Changes";
        });

    displayArticles(needsChangesArticles);

    setActiveButton(needsChangesButton);
});

displayArticles(articles);
setActiveButton(allButton);

