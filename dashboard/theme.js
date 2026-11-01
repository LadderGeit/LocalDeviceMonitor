// Applies the saved theme before the page is drawn, so it never shows the wrong colors first.
// Dark is the default; renderer.js has the toggle.
try {
  if (localStorage.getItem('theme') === 'light') document.documentElement.dataset.theme = 'light';
} catch {
  // Storage unavailable: stay on the default dark theme.
}
