
const params = new URLSearchParams(window.location.search);

const articleId = Number(params.get("id"));

const article = articles.find(function(article) {
    return article.id === articleId;
});

document.getElementById("article-title").textContent =
    article.title;

document.getElementById("article-reporter").textContent =
    article.reporter;

document.getElementById("submitted-date").textContent =
    article.submittedDate;

document.getElementById("updated-date").textContent =
    article.updatedDate;

//status//
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



//return section area//
const returnButton =
    document.querySelector(".return-btn");

const returnSection =
    document.getElementById("return-section");

returnButton.addEventListener("click", function() {
    returnSection.classList.toggle("show");
});
//

//edit article area//
const editButton =
    document.querySelector(".edit-btn");

const actionButtons =
    document.querySelector(".action-buttons");

const editButtons =
    document.getElementById("edit-buttons");

const saveButton =
    document.getElementById("save-btn");

const cancelButton =
    document.getElementById("cancel-btn");

const articleTitle =
    document.getElementById("article-title");

const articleContent =
    document.getElementById("article-content");

let originalTitle = "";
let originalContent = "";

editButton.addEventListener("click", function() {

    originalTitle = articleTitle.textContent;
    originalContent = articleContent.innerText;

    articleTitle.innerHTML = `
        <input
            type="text"
            id="edit-title"
            class="edit-title"
        >
    `;

    articleContent.innerHTML = `
        <textarea
            id="edit-content"
            class="edit-content"
        ></textarea>
    `;

    document.getElementById("edit-title").value =
        originalTitle;

    document.getElementById("edit-content").value =
        originalContent;

    actionButtons.style.display = "none";

    editButtons.classList.add("show");
});


saveButton.addEventListener("click", function() {

    const newTitle =
        document.getElementById("edit-title").value;

    const newContent =
        document.getElementById("edit-content").value;

    article.title = newTitle;
    article.content = newContent;


     const today = new Date();

    const formattedDate =
        today.toLocaleDateString("en-US", {
            year: "numeric",
            month: "long",
            day: "numeric"
        });

    article.date = formattedDate;
    
    
    articleTitle.textContent =
        newTitle;

    articleContent.textContent =
        newContent;

    document.getElementById("article-date").textContent =
        formattedDate;


    articleTitle.style.display = "block";
    articleContent.style.display = "block";

    document.getElementById("edit-title").style.display = "none";
    document.getElementById("edit-content").style.display = "none";
    

    editButtons.classList.remove("show");

    actionButtons.style.display = "flex";
});


cancelButton.addEventListener("click", function() {

    articleTitle.textContent = originalTitle;

    articleContent.textContent = originalContent;

    editButtons.classList.remove("show");

    actionButtons.style.display = "flex";
});
//