
const params = new URLSearchParams(window.location.search);

const articleId = Number(params.get("id"));

const article = articles.find(function(article) {
    return article.id === articleId;
});

document.getElementById("article-title").textContent =
    article.title;

document.getElementById("article-reporter").textContent =
    article.reporter;

document.getElementById("article-date").textContent =
    article.date;

//status
const statusElement =
    document.getElementById("article-status");

statusElement.textContent = article.status;

if (article.status === "Pending Approval") {
    statusElement.classList.add("pending");
}

if (article.status === "Published") {
    statusElement.classList.add("published");
}

if (article.status === "needs Changes") {
    statusElement.classList.add("needs-changes");
}
//

document.getElementById("article-content").innerHTML =
    article.content;


