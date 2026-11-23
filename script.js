document.addEventListener('DOMContentLoaded', () => {
  const menuButton = document.getElementById('menu-toggle');
  const nav = document.getElementById('main-nav');
  if (menuButton && nav) {
    menuButton.addEventListener('click', () => {
      const expanded = nav.classList.toggle('open');
      menuButton.setAttribute('aria-expanded', String(expanded));
    });
  }

  const form = document.getElementById('inquiry-form');
  if (!form) return;
  const status = document.getElementById('form-status');
  const button = form.querySelector('button[type="submit"]');
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!form.reportValidity()) return;
    const fields = Object.fromEntries(new FormData(form).entries());
    status.className = 'status';
    status.textContent = 'Sending your inquiry…';
    button.disabled = true;
    button.textContent = 'SENDING…';
    try {
      const response = await fetch('/api/franchise-inquiry', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(fields)
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || !result.ok) {
        throw new Error(result.error || 'We could not send your inquiry. Please try again or email franchise@neighbarks.com.');
      }
      form.reset();
      status.className = 'status success';
      status.textContent = 'Thank you. Your franchise inquiry has been sent to our team.';
    } catch (error) {
      status.className = 'status error';
      status.textContent = error.message || 'We could not send your inquiry. Please try again or email franchise@neighbarks.com.';
    } finally {
      button.disabled = false;
      button.textContent = 'SEND';
    }
  });
});
