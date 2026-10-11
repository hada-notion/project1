/* Shared by the existing administrator pages. Public configuration comes from each page. */
window.HadaAdminAuth = Object.freeze({
  // scope 'kiosk' asks for a 30-day session limited to check-in routes.
  async login(base, password, scope) {
    const res = await fetch(base.replace(/\/$/, '') + '/functions/v1/admin-security', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'login', password, ...(scope ? { scope } : {}) }), cache: 'no-store',
    });
    const data = await res.json().catch(() => ({}));
    // Legacy fallback is allowed only when the server explicitly says security is not enabled.
    // Network errors, bad credentials and missing routes must NEVER silently downgrade.
    if (res.status === 503 && data.error === '관리자 보안 기능의 최초 서버 설정이 필요합니다.') return password;
    if (!res.ok || !data.session) throw new Error(data.error || '관리자 로그인 서버에 연결하지 못했습니다.');
    return data.session;
  }
});
