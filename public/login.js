const f = document.getElementById('f'), err = document.getElementById('err'), go = document.getElementById('go');
f.onsubmit = async (e) => {
  e.preventDefault(); go.disabled = true; err.textContent = '';
  try {
    const r = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: document.getElementById('pw').value }) });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || 'Sign in failed');
    location.replace('/');
  } catch (ex) { err.textContent = ex.message; go.disabled = false; document.getElementById('pw').select(); }
};
fetch('/api/auth/status').then((r) => r.json()).then((s) => { if (!s.required || s.authenticated) location.replace('/'); }).catch(() => {});
