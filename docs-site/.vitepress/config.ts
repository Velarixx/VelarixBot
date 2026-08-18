import { defineConfig } from "vitepress";

export default defineConfig({
  base: "/VelarixBot/",
  title: "VelarixBot Docs",
  description:
    "Guides and references for running VelarixBot — your AI team in a messaging app: bots, engines, computers, routines, and the local-first harness.",
  lastUpdated: true,
  themeConfig: {
    nav: [
      { text: "Learn", link: "/learn/what-is-velarixbot" },
      { text: "Guides", link: "/guide/engines" },
      { text: "Reference", link: "/reference/api" },
      { text: "GitHub", link: "https://github.com/Velarixx/VelarixBot" },
    ],
    search: { provider: "local" },
    outline: [2, 3],
    sidebar: {
      "/learn/": [
        {
          text: "Quickstart",
          items: [
            { text: "What is VelarixBot?", link: "/learn/what-is-velarixbot" },
            { text: "Key concepts", link: "/learn/key-concepts" },
            { text: "Installation", link: "/learn/installation" },
            { text: "Your first bot", link: "/learn/your-first-bot" },
            { text: "Watching bots work", link: "/learn/watching-bots-work" },
            { text: "Glossary", link: "/learn/glossary" },
          ],
        },
      ],
      "/guide/": [
        {
          text: "Bots & Engines",
          items: [
            { text: "Engines", link: "/guide/engines" },
            { text: "Computers", link: "/guide/computers" },
            { text: "Groups & delegation", link: "/guide/groups-and-delegation" },
          ],
        },
        {
          text: "Day-to-day",
          items: [
            { text: "Approvals & permissions", link: "/guide/approvals" },
            { text: "Routines", link: "/guide/routines" },
            { text: "Memory", link: "/guide/memory" },
            { text: "Skills & teach-a-task", link: "/guide/skills" },
            { text: "Background harness", link: "/guide/background-harness" },
            { text: "Blocked states & errors", link: "/guide/blocked-and-errors" },
          ],
        },
      ],
      "/reference/": [
        {
          text: "Reference",
          items: [
            { text: "HTTP API", link: "/reference/api" },
            { text: "Configuration", link: "/reference/configuration" },
            { text: "Security model", link: "/reference/security" },
            { text: "Troubleshooting", link: "/reference/troubleshooting" },
            { text: "Roadmap", link: "/reference/roadmap" },
          ],
        },
      ],
    },
    footer: {
      message: "Internal documentation for VelarixBot.",
    },
  },
});
