'use strict';
const timestamps = document.getElementById('timestamps');
const progress = document.getElementById('progress');
const spacing = document.getElementById('spacing');
function updatePreview() {
  document.querySelectorAll('.time').forEach(label => { label.hidden = !timestamps.checked; });
  document.getElementById('preview-progress').hidden = !progress.checked;
  document.getElementById('preview-answer').className = `preview-answer ${spacing.value}`;
}
[timestamps, progress, spacing].forEach(control => control.addEventListener('change', updatePreview));
document.getElementById('reset-preview').addEventListener('click', () => {
  timestamps.checked = true;
  progress.checked = true;
  spacing.value = 'original';
  updatePreview();
});
document.querySelectorAll('[data-copy]').forEach(button => {
  button.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(button.dataset.copy);
      button.textContent = 'Copied';
      document.getElementById('copy-status').textContent = 'Command copied.';
    } catch {
      button.textContent = 'Select to copy';
      document.getElementById('copy-status').textContent = 'Select the command text and copy it manually.';
    }
  });
});
if ('IntersectionObserver' in window) {
  const sectionLinks = document.querySelectorAll('.guide-nav a');
  const observer = new IntersectionObserver(entries => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      sectionLinks.forEach(link => {
        if (link.hash === `#${entry.target.id}`) link.setAttribute('aria-current', 'location');
        else link.removeAttribute('aria-current');
      });
    }
  }, { rootMargin: '-12% 0px -65% 0px' });
  document.querySelectorAll('.guide-section').forEach(section => observer.observe(section));
}
updatePreview();
