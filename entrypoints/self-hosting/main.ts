import "./style.css";

import { browser } from "../../src/platform/browser";
import { getSettings } from "../../src/core/storage";
import { applyThemeMode } from "../../src/ui/theme";

const app = document.querySelector<HTMLDivElement>("#app");
const BACKEND_GUIDE_URL =
  "https://github.com/punkrock34/roll_together_backend/blob/main/docs/self-hosting.md";

function createElement<K extends keyof HTMLElementTagNameMap>(
  tagName: K,
  options: {
    className?: string;
    text?: string;
  } = {},
) {
  const element = document.createElement(tagName);

  if (options.className) {
    element.className = options.className;
  }

  if (options.text !== undefined) {
    element.textContent = options.text;
  }

  return element;
}

function appendChildren(parent: Node, children: Array<Node | undefined>) {
  for (const child of children) {
    if (child) {
      parent.appendChild(child);
    }
  }
}

function createButton(text: string, className: string, action: string) {
  const button = createElement("button", { className, text });
  button.type = "button";
  button.dataset.action = action;
  return button;
}

function createSectionHead(title: string, description: string) {
  const head = createElement("div", { className: "section-head" });
  const copy = createElement("div", { className: "stack" });
  appendChildren(copy, [
    createElement("h2", { text: title }),
    createElement("p", { className: "muted", text: description }),
  ]);
  head.appendChild(copy);
  return head;
}

function createHintList(items: string[]) {
  const list = createElement("ul", { className: "hint-list" });
  for (const item of items) {
    const row = createElement("li");
    row.textContent = item;
    list.appendChild(row);
  }
  return list;
}

function createChoiceCard(title: string, summary: string, items: string[]) {
  const card = createElement("section", { className: "card choice-card" });
  appendChildren(card, [
    createElement("h3", { text: title }),
    createElement("p", { className: "muted", text: summary }),
    createHintList(items),
  ]);
  return card;
}

function createCodeCard(title: string, lines: string[]) {
  const card = createElement("section", { className: "card code-card" });
  const code = createElement("pre");
  code.textContent = lines.join("\n");
  appendChildren(card, [createElement("h3", { text: title }), code]);
  return card;
}

function createStepList(items: string[]) {
  const list = createElement("ol", { className: "step-list" });
  for (const item of items) {
    const row = createElement("li");
    row.textContent = item;
    list.appendChild(row);
  }
  return list;
}

function renderPage() {
  if (!app) {
    return;
  }

  const main = createElement("main");

  const hero = createElement("section", { className: "card hero-card" });
  const heroActions = createElement("div", { className: "actions" });
  appendChildren(heroActions, [
    createButton("<- Go Back to Settings", "secondary", "open-options"),
    createButton("Open Backend Guide", "primary", "open-backend-guide"),
  ]);
  appendChildren(hero, [
    createElement("span", { className: "eyebrow", text: "Roll Together" }),
    createElement("h1", { text: "Self-Hosting Guide" }),
    createElement("p", {
      className: "muted",
      text: "You do not need to be a sysadmin. Pick the setup that matches how often you plan to host, then point the extension at those URLs.",
    }),
    heroActions,
  ]);

  const pathGrid = createElement("section", { className: "choice-grid" });
  appendChildren(pathGrid, [
    createChoiceCard("Small VPS", "Best for regular use and the least drama.", [
      "Usually the easiest stable setup for friends outside your home.",
      "A tiny Linux VPS is enough for this backend.",
      "Good if you want the room server online whenever you need it.",
    ]),
    createChoiceCard(
      "Spare Laptop or Raspberry Pi",
      "Best if you already own the hardware and want the cheapest long-term setup.",
      [
        "An old laptop, Raspberry Pi, mini PC, or desktop all work.",
        "You must keep that machine powered on while hosting.",
        "Home hosting usually means port forwarding or a tunnel.",
      ],
    ),
    createChoiceCard(
      "Your Current PC",
      "Best for temporary sessions, testing, or occasional hosting.",
      [
        "You need to start the backend every time you want to watch with friends.",
        "If your PC sleeps, reboots, or closes Docker, the room goes offline.",
        "This is fine for one-off sessions, but not the nicest long-term setup.",
      ],
    ),
  ]);

  const addressCard = createElement("section", { className: "card" });
  appendChildren(addressCard, [
    createSectionHead(
      "Domain or Hostname",
      "The extension only cares that it can reach one HTTP URL and one matching WebSocket URL.",
    ),
    createHintList([
      "Best long-term path: use a normal domain or subdomain such as watch.example.com.",
      "If you do not want to buy a domain yet, a Dynamic DNS hostname can work for home hosting.",
      "If you host at home, a tunnel can be easier than teaching your router about port forwarding.",
      "If you host on your current PC, the backend is only available while that PC is running the service.",
    ]),
  ]);

  const urlGrid = createElement("section", { className: "code-grid" });
  appendChildren(urlGrid, [
    createCodeCard("Public HTTPS setup", [
      "HTTP Base URL: https://watch.example.com",
      "WebSocket URL: wss://watch.example.com/ws",
    ]),
    createCodeCard("Local-only setup", [
      "HTTP Base URL: http://localhost:3000",
      "WebSocket URL: ws://localhost:3000/ws",
    ]),
  ]);

  const beginnerCard = createElement("section", { className: "card" });
  appendChildren(beginnerCard, [
    createSectionHead(
      "Recommended Beginner Path",
      "If you want the least painful setup for regular use, this is the one to copy.",
    ),
    createStepList([
      "Get a small Linux VPS or use a spare machine you can keep online.",
      "Give it a reachable name such as a domain, subdomain, or Dynamic DNS hostname.",
      "Run the Roll Together backend with Docker.",
      "Put HTTPS in front of it with Nginx, Apache, or a tunnel that can carry WebSocket traffic.",
      "Enter the matching HTTP and WebSocket URLs in the extension settings.",
    ]),
  ]);

  const resourceCard = createElement("section", {
    className: "card card-subtle",
  });
  const resourceActions = createElement("div", { className: "actions" });
  appendChildren(resourceActions, [
    createButton("Open Backend Guide", "primary", "open-backend-guide"),
  ]);
  appendChildren(resourceCard, [
    createSectionHead(
      "Need the Full Deployment Steps?",
      "The backend guide has the command-by-command setup, reverse proxy examples, and troubleshooting notes.",
    ),
    resourceActions,
  ]);

  appendChildren(main, [
    hero,
    createSectionHead(
      "Pick a Hosting Path",
      "Choose the path that matches your comfort level and how often you plan to host.",
    ),
    pathGrid,
    addressCard,
    urlGrid,
    beginnerCard,
    resourceCard,
  ]);

  app.replaceChildren(main);
  bindEvents();
}

function bindEvents() {
  app
    ?.querySelectorAll<HTMLButtonElement>("[data-action='open-options']")
    .forEach((button) => {
      button.addEventListener("click", async () => {
        await browser.tabs.create({
          url: browser.runtime.getURL("/options.html"),
        });
      });
    });

  app
    ?.querySelectorAll<HTMLButtonElement>("[data-action='open-backend-guide']")
    .forEach((button) => {
      button.addEventListener("click", async () => {
        await browser.tabs.create({ url: BACKEND_GUIDE_URL });
      });
    });
}

async function render() {
  const settings = await getSettings();
  applyThemeMode(settings.themeMode);
  renderPage();
}

void render();
