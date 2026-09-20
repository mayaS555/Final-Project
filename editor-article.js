const articles = [
    {
        id: 1,
        title: "New Technology Changes Education",
        reporter: "Maya Cohen",
        date: "September 20, 2026",
        status: "Pending Approval",
        content: `
            <p>
                Schools around the world are introducing new
                technologies into classrooms.
            </p>

            <p>
                These technologies allow students to access
                information quickly and communicate in new ways.
            </p>

            <p>
                Teachers are also learning how to use digital tools
                to improve lessons and student participation.
            </p>
        `
    },

    {
        id: 2,
        title: "Artificial Intelligence in Schools",
        reporter: "Noa Cohen",
        date: "September 19, 2026",
        status: "published",
        content: `
            <p>
                Artificial intelligence is beginning to change
                the way students learn.
            </p>

            <p>
                AI tools can help students practice subjects and
                receive immediate feedback.
            </p>

            <p>
                Schools are also discussing how these technologies
                should be used responsibly.
            </p>
        `
    },

    {
        id: 3,
        title: "The Future of Electric Cars",
        reporter: "Daniel Levi",
        date: "September 18, 2026",
        status: "Needs changes",
        content: `
            <p>
                Electric cars are becoming increasingly popular
                around the world.
            </p>

            <p>
                New battery technologies allow cars to travel
                longer distances than before.
            </p>

            <p>
                Many countries are investing in charging stations
                and other infrastructure for electric vehicles.
            </p>
        `
    }
];

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

if (article.status === "Needs changes") {
    statusElement.classList.add("Needs-changes");
}
//

document.getElementById("article-content").innerHTML =
    article.content;


