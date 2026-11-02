// Apply the saved theme before first paint (see src/lib/theme.ts). A file, not an inline
// script, so the browser edition's CSP can stay `script-src 'self'`.
(function () {
  var m = localStorage.getItem("leetclaude.theme");
  var dark = m === "dark" || (m !== "light" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
})();
