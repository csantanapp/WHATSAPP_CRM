// Gate de autenticação do app principal (index.html). Roda antes de qualquer
// outra coisa: sem sessão válida, redireciona pro login. Também popula o
// usuário logado no header e liga o botão de sair.
(function () {
  async function check() {
    try {
      const res = await fetch('/api/auth/me', { headers: { 'Content-Type': 'application/json' } });
      if (res.status === 401) {
        window.location.href = '/login.html?next=' + encodeURIComponent(window.location.pathname);
        return;
      }
      const { user } = await res.json();
      const nameEl = document.getElementById('ds-user-name');
      const avatarEl = document.getElementById('ds-user-avatar');
      if (nameEl) nameEl.textContent = user.name;
      if (avatarEl) {
        avatarEl.textContent = (user.name || '').split(' ').filter(Boolean).slice(0, 2).map((p) => p[0].toUpperCase()).join('') || '?';
      }
      const usersLink = document.getElementById('ds-users-link');
      if (usersLink && user.role !== 'admin' && !user.isPlatformAdmin) usersLink.style.display = 'none';
    } catch (err) {
      // Falha de rede não derruba a tela — só não preenche o usuário.
      console.error('auth-guard: falha ao checar sessão', err);
    }
  }

  const logoutBtn = document.getElementById('ds-logout-btn');
  if (logoutBtn) {
    logoutBtn.addEventListener('click', async () => {
      await fetch('/api/auth/logout', { method: 'POST' });
      window.location.href = '/login.html';
    });
  }

  check();
})();
