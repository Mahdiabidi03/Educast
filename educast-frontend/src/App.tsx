import { useEffect, useMemo, useState } from 'react';
import axios from 'axios';
import './App.css';
import { AdminLibrary } from './AdminLibrary';
import { QuickGenerate } from './QuickGenerate';
import { Login } from './Login';
import { ResetPassword } from './ResetPassword';
import { clearSession, getStoredToken, getStoredUser, UserSession } from './auth';

import { createContext } from 'react';

// Configure global Axios interceptor for JWT Bearer token
axios.interceptors.request.use((config) => {
  const token = getStoredToken();
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

type ViewMode = 'library' | 'quick';

const navItems = [
  { id: 'library' as const, label: 'Bibliothèque', detail: 'Matières & cours' },
  { id: 'quick' as const, label: 'Résumé rapide', detail: 'Documents personnels' },
];

export const UserContext = createContext<UserSession | null>(null);

function App() {
  const [currentUser, setCurrentUser] = useState<UserSession | null>(() => getStoredUser());
  const [view, setView] = useState<ViewMode>('library');
  const [searchQuery, setSearchQuery] = useState('');

  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    if (typeof window === 'undefined') return 'light';
    const savedTheme = window.localStorage.getItem('educast-theme');
    return savedTheme === 'dark' ? 'dark' : 'light';
  });

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    document.documentElement.style.colorScheme = theme;
    window.localStorage.setItem('educast-theme', theme);
  }, [theme]);

  const handleLogout = () => {
    clearSession();
    setCurrentUser(null);
  };

  const title = useMemo(() => (view === 'library' ? 'Bibliothèque' : 'Résumé rapide'), [view]);

  if (window.location.pathname === '/reset-password') {
    return <ResetPassword />;
  }

  if (!currentUser) {
    return (
      <Login
        onLoginSuccess={(user) => setCurrentUser(user)}
        theme={theme}
        onToggleTheme={() => setTheme((c) => (c === 'light' ? 'dark' : 'light'))}
      />
    );
  }

  const userInitials = currentUser.name
    .split(' ')
    .map((n) => n[0])
    .join('')
    .substring(0, 2)
    .toUpperCase();

  return (
    <UserContext.Provider value={currentUser}>
      <div className="App-shell">
        <aside className="App-sidebar">
          <div className="App-brand">
            <div className="App-brandMark">E</div>
            <div className="App-brandName">
              <h2>EduCast</h2>
            </div>
          </div>

          <div className="App-dock">
            <input
              type="text"
              placeholder="Rechercher une matière..."
              aria-label="Rechercher"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
            <button type="button" className="btn-secondary App-dockButton">⌕</button>
          </div>

          <nav className="App-nav" aria-label="Navigation principale">
            <div className="App-navGroup">
              <span className="App-navLabel">Navigation</span>
              {navItems.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={`App-navItem ${view === item.id ? 'active' : ''}`}
                  onClick={() => setView(item.id)}
                >
                  <span className="App-navIcon">{item.id === 'library' ? '◫' : '⚡'}</span>
                  <span className="App-navText">
                    <strong>{item.label}</strong>
                    <small>{item.detail}</small>
                  </span>
                </button>
              ))}
            </div>
          </nav>

          <div className="App-sidebarFooter">
            <div className="App-user" style={{ flexWrap: 'wrap', gap: '0.6rem' }}>
              <div className="App-userAvatar">{userInitials}</div>
              <div style={{ flex: 1, minWidth: '110px' }}>
                <strong>{currentUser.name}</strong>
                <p style={{ textTransform: 'capitalize' }}>
                  {currentUser.role === 'admin' ? '👑 Administrateur' : '🎓 Étudiant'}
                </p>
              </div>
              <button
                type="button"
                className="btn-secondary"
                onClick={handleLogout}
                title="Se déconnecter"
                style={{ padding: '0.4rem 0.6rem', fontSize: '0.78rem', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: '0.3rem' }}
              >
                <span>Déconnexion</span> 🚪
              </button>
            </div>

            <div className="App-themeRow" style={{ justifyContent: 'center' }}>
              <button
                type="button"
                className="btn-secondary App-iconButton"
                onClick={() => setTheme((currentTheme) => (currentTheme === 'light' ? 'dark' : 'light'))}
                aria-label={`Activer le thème ${theme === 'light' ? 'sombre' : 'clair'}`}
              >
                {theme === 'light' ? '☾' : '☀'}
              </button>
            </div>
          </div>
        </aside>

        <main className="App-main">
          <header className="App-topbar">
            <div>
              <h1>{title}</h1>
            </div>
            {currentUser.role === 'admin' && (
              <div className="App-topbarActions">
                <span className="status-badge" style={{ background: 'rgba(124, 106, 247, 0.15)', color: '#7c6af7' }}>
                  Admin Mode
                </span>
              </div>
            )}
          </header>

          <div className="App-content">
            {view === 'library' ? (
              <AdminLibrary searchQuery={searchQuery} userRole={currentUser.role} />
            ) : (
              <QuickGenerate />
            )}
          </div>
        </main>
      </div>
    </UserContext.Provider>
  );
}

export default App;
